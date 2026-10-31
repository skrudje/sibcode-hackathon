import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, File, Form, Header, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pwdlib import PasswordHash
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from redis import Redis
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError

from app.contracts import CampaignWrite, LoginRequest, RecommendationRuleWrite, SegmentWrite
from app.core.config import ROOT, Clock, settings
from app.core.contacts import normalize_contact
from app.core.db import SessionLocal, dump, json_value, lock
from app.core.errors import AppError
from app.models import AuthSession, Campaign, Customer, CustomerContact, Event, Export, ExternalIdentity, ImportJob, ImportRowResult, RecommendationRule, Segment, Source, Tenant, User
from app.modules.exports.service import create_export, export_public, preview
from app.modules.ingestion.adapters import MAX_BYTES
from app.modules.segments.service import destination_compatible, evaluate, evaluation_summary, recommendations, scoped, validate_definition
from app.modules.sources.contracts import SourceCoveragePatch
from app.modules.sources.service import update_coverage
from app.modules.radar import service as radar_service
from app.modules.radar.contracts import RadarAudience, RadarCampaignResult, RadarCampaignWrite, RadarDemoResult, RadarDemoWrite, RadarOptions, RadarReport
from app.modules.radar.demo import enqueue as enqueue_radar_demo
from app.modules.integrations import service as integrations
from app.modules.integrations.contracts import (ConnectionTest, IntegrationInfo, IntegrationPage, IntegrationWrite,
    TeamMember, TeamPage, TenantInfo, TenantWrite, UserPatch, UserWrite)

from app.modules.brand import service as brand_service
from app.modules.brand.contracts import BrandContext, ColumnMapping, FilePreview

app = FastAPI(title='Хрюкерсы CDP', version='0.1.0')
log = logging.getLogger('hryukers')
PUBLIC = {'/api/v1/auth/login', '/api/v1/health/live', '/api/v1/health/ready'}


@app.middleware('http')
async def request_policy(request: Request, call_next):
    request.state.request_id = str(uuid4())
    if request.method in ['POST', 'PUT', 'PATCH', 'DELETE'] and request.url.path.startswith('/api/'):
        if request.headers.get('origin') not in settings.allowed_origins.split(','):
            return error_response(request, AppError('origin_not_allowed', 'Источник запроса не разрешён', 403))
    response = await call_next(request)
    response.headers['X-Request-ID'] = request.state.request_id
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Cache-Control'] = 'no-store'
    return response


def error_response(request, exc):
    return JSONResponse(status_code=exc.status, content={'error': {'code': exc.code, 'message': exc.message, 'details': exc.details, 'request_id': getattr(request.state, 'request_id', str(uuid4()))}})


@app.exception_handler(AppError)
async def domain_error(request, exc):
    return error_response(request, exc)


@app.exception_handler(RequestValidationError)
async def input_error(request, exc):
    details = [{'field': '.'.join(str(x) for x in e['loc'][1:]), 'message': e['msg']} for e in exc.errors()]
    return error_response(request, AppError('validation_error', 'Проверьте входные данные', details=details))


@app.exception_handler(SQLAlchemyError)
async def database_error(request, exc):
    log.error('Database operation failed: request_id=%s class=%s', request.state.request_id, type(exc).__name__)
    return error_response(request, AppError('database_error', 'Не удалось выполнить операцию. Повторите запрос.', 503))


def db_session():
    with SessionLocal() as db:
        yield db


DB = Annotated[object, Depends(db_session)]


def current_user(request: Request, db: DB):
    token = request.cookies.get('hryukers_session')
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hashlib.sha256(token.encode()).hexdigest(), AuthSession.expires_at > Clock.now())) if token else None
    user = db.get(User, session.user_id) if session else None
    if not user or not user.is_active:
        raise AppError('unauthorized', 'Войдите в аккаунт', 401)
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def admin_user(user: CurrentUser):
    if user.role != 'admin':
        raise AppError('admin_required', 'Это действие доступно администратору', 403)
    return user


AdminUser = Annotated[User, Depends(admin_user)]


def staff_user(user: CurrentUser):
    if user.role not in ('admin', 'marketer'):
        raise AppError('staff_required', 'Этот раздел доступен сотрудникам управляющей компании', 403)
    return user


def brand_user(user: CurrentUser):
    if user.role != 'brand':
        raise AppError('brand_required', 'Этот раздел доступен представителю бренда', 403)
    return user


StaffUser = Annotated[User, Depends(staff_user)]
BrandUser = Annotated[User, Depends(brand_user)]
Limit = Annotated[int, Query(ge=1, le=100)]
Offset = Annotated[int, Query(ge=0)]
USER_FIELDS = ['id', 'email', 'role', 'mall_id', 'tenant_id']
TEAM_FIELDS = ['id', 'email', 'role', 'is_active', 'tenant_id']
CUSTOMER_FIELDS = ['id', 'global_customer_key', 'display_name', 'identity_status', 'created_at']
SOURCE_FIELDS = ['id', 'tenant_id', 'name', 'kind', 'covered_event_types', 'coverage_from', 'coverage_to', 'last_success_at']
JOB_FIELDS = ['id', 'source_id', 'status', 'total_rows', 'accepted_rows', 'duplicate_rows', 'rejected_rows', 'attempt_count', 'created_at', 'finished_at', 'failure_code', 'failure_message']


def paginate(db, query, limit, offset, serializer=dump):
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    return {'items': [serializer(row) for row in db.scalars(query.limit(limit).offset(offset))], 'total': total, 'limit': limit, 'offset': offset}


def import_job(db, identifier, user):
    job = db.get(ImportJob, identifier)
    if not job:
        raise AppError('not_found', 'Импорт не найден', 404)
    scoped(db, Source, job.source_id, user.mall_id)
    return job


def event_public(event):
    fields = ['id', 'customer_id', 'source_id', 'tenant_id', 'external_event_id', 'event_type', 'occurred_at', 'amount', 'currency']
    return {**dump(event, fields), 'metadata': event.metadata_json}


@app.get('/api/v1/health/live')
def live():
    return {'status': 'ok', 'postgres': 'unchecked', 'valkey': 'unchecked'}


@app.get('/api/v1/health/ready')
def ready(db: DB):
    try:
        db.execute(text('SELECT 1'))
        Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2).ping()
    except Exception as exc:
        raise AppError('not_ready', 'База данных или очередь недоступна', 503) from exc
    return {'status': 'ok', 'postgres': 'up', 'valkey': 'up'}


@app.post('/api/v1/auth/login')
def login(body: LoginRequest, response: Response, db: DB):
    user = db.scalar(select(User).where(User.email == body.email.strip().lower(), User.is_active.is_(True)))
    if not user or not PasswordHash.recommended().verify(body.password, user.password_hash):
        raise AppError('invalid_credentials', 'Неверный email или пароль', 401)
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=Clock.now() + timedelta(hours=12)))
    db.commit()
    response.set_cookie('hryukers_session', token, max_age=43200, httponly=True, secure=settings.cookie_secure, samesite='lax', path='/')
    return {'user': dump(user, USER_FIELDS)}


@app.post('/api/v1/auth/logout', status_code=204)
def logout(request: Request, response: Response, user: CurrentUser, db: DB):
    token = request.cookies.get('hryukers_session', '')
    session = db.scalar(select(AuthSession).where(AuthSession.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if session:
        db.delete(session)
        db.commit()
    response.delete_cookie('hryukers_session', path='/')


@app.get('/api/v1/auth/me')
def me(user: CurrentUser):
    return dump(user, USER_FIELDS)


@app.get('/api/v1/summary')
def summary(user: StaffUser, db: DB):
    counts = dict(db.execute(select(Customer.identity_status, func.count()).where(Customer.mall_id == user.mall_id).group_by(Customer.identity_status)).all())
    jobs = db.scalars(select(ImportJob).join(Source).where(Source.mall_id == user.mall_id).order_by(ImportJob.created_at.desc()).limit(5)).all()
    return dict(customer_count=sum(counts.values()), verified_customer_count=counts.get('verified', 0), source_only_customer_count=counts.get('source_only', 0), event_count=db.scalar(select(func.count(Event.id)).where(Event.mall_id == user.mall_id)), source_count=db.scalar(select(func.count(Source.id)).where(Source.mall_id == user.mall_id)), last_imports=[dump(j, JOB_FIELDS) for j in jobs])


@app.get('/api/v1/tenants')
def tenants(user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    return paginate(db, select(Tenant).where(Tenant.mall_id == user.mall_id).order_by(Tenant.code), limit, offset, lambda t: dump(t, ['id', 'code', 'name', 'category', 'is_active']))


@app.get('/api/v1/sources')
def sources(user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    return paginate(db, select(Source).where(Source.mall_id == user.mall_id).order_by(Source.name), limit, offset, lambda s: dump(s, SOURCE_FIELDS))


@app.patch('/api/v1/sources/{source_id}/coverage')
def source_coverage(source_id: UUID, body: SourceCoveragePatch, user: AdminUser, db: DB):
    source = update_coverage(db, source_id, user.mall_id, body)
    db.commit()
    return dump(source, SOURCE_FIELDS)


@app.post('/api/v1/sources/{source_id}/imports', status_code=202)
async def upload(source_id: UUID, user: StaffUser, db: DB, file: UploadFile = File(...)):
    source = scoped(db, Source, source_id, user.mall_id)
    extension = '.' + (file.filename or '').lower().rsplit('.', 1)[-1]
    allowed = {'.csv', '.xlsx'} if source.kind == 'contacts' else {'.csv'} if source.kind == 'crm_csv' else {'.xlsx'} if source.kind == 'pos_xlsx' else set()
    if extension not in allowed:
        raise AppError('unsupported_file', 'Формат файла не соответствует источнику', 415)
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise AppError('file_too_large', 'Максимальный размер файла — 10 MiB', 413)
    identifier = uuid4()
    directory = settings.path('upload_dir')
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'{identifier}{extension}'
    path.write_bytes(data)
    try:
        job = ImportJob(id=identifier, source_id=source_id, file_path=str(path))
        db.add(job)
        db.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return dump(job, JOB_FIELDS)


@app.post('/api/v1/sources/{source_id}/sync', status_code=202)
def sync_source(source_id: UUID, user: StaffUser, db: DB):
    source = db.scalar(select(Source).where(Source.id == source_id, Source.mall_id == user.mall_id).with_for_update())
    if not source:
        raise AppError('not_found', 'Источник не найден', 404)
    if source.kind not in ('rest_api', 'contacts'):
        raise AppError('invalid_source_type', 'Для этого источника требуется файл')
    job = integrations.enqueue_sync(db, source)
    db.commit()
    return dump(job, JOB_FIELDS)


@app.get('/api/v1/integrations', response_model=IntegrationPage)
def integration_list(user: StaffUser, db: DB):
    rows = db.execute(select(Source, Tenant).join(Tenant, Source.tenant_id == Tenant.id)
                      .where(Source.mall_id == user.mall_id, Tenant.mall_id == user.mall_id).order_by(Tenant.name)).all()
    return {'items': [integrations.connection_public(source, tenant, user.role == 'admin') for source, tenant in rows], 'total': len(rows)}


@app.patch('/api/v1/integrations/{source_id}', response_model=IntegrationInfo)
def integration_update(source_id: UUID, body: IntegrationWrite, user: AdminUser, db: DB):
    source = db.scalar(select(Source).where(Source.id == source_id, Source.mall_id == user.mall_id).with_for_update())
    if not source:
        raise AppError('not_found', 'Подключение не найдено', 404)
    integrations.save_config(db, source, body)
    db.commit()
    return integrations.connection_public(source, db.get(Tenant, source.tenant_id), True)


@app.post('/api/v1/integrations/{source_id}/test', response_model=ConnectionTest)
def integration_test(source_id: UUID, user: AdminUser, db: DB):
    source = scoped(db, Source, source_id, user.mall_id)
    page = integrations.read_page(integrations.config(source), integrations.config(source).get('cursor'))
    # Test checks the format too, but never writes events or advances the cursor.
    from app.modules.integrations.contracts import ContactRecord
    from pydantic import ValidationError
    try:
        for row in page['records']:
            ContactRecord.model_validate(row)
    except ValidationError as exc:
        raise AppError('invalid_contact_record', 'API доступен, но записи должны содержать только phone, email и time с корректным контактом и часовым поясом.') from exc
    return dict(status='ok', record_count=len(page['records']), message='Подключение и формат проверены. Записи не загружались.')


@app.get('/api/v1/integrations/template')
def contact_template(user: StaffUser):
    return Response('phone,email,time\n,visitor@example.invalid,2026-10-30T12:00:00+07:00\n'.encode('utf-8-sig'),
                    media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="contacts.csv"'})


@app.post('/api/v1/tenants', response_model=TenantInfo, status_code=201)
def create_tenant(body: TenantWrite, user: AdminUser, db: DB):
    tenant = Tenant(mall_id=user.mall_id, code=uuid4().hex[:8], name=body.name, category=body.category)
    db.add(tenant)
    db.flush()
    db.add(Source(mall_id=user.mall_id, tenant_id=tenant.id, name=body.name, kind='contacts',
                  covered_event_types=['interaction'], config={'enabled': False, 'interval_minutes': 15}))
    db.commit()
    return dump(tenant, ['id', 'code', 'name', 'category', 'is_active'])


@app.get('/api/v1/team', response_model=TeamPage)
def team_list(user: AdminUser, db: DB):
    members = db.scalars(select(User).where(User.mall_id == user.mall_id).order_by(User.email)).all()
    return {'items': [dump(member, TEAM_FIELDS) for member in members], 'total': len(members)}


@app.post('/api/v1/team', response_model=TeamMember, status_code=201)
def team_create(body: UserWrite, user: AdminUser, db: DB):
    if db.scalar(select(User.id).where(User.email == body.email)):
        raise AppError('email_unavailable', 'Этот email уже используется', 409)
    brand_service.validate_assignment(db, body.tenant_id, user.mall_id)
    member = User(mall_id=user.mall_id, email=body.email, password_hash=PasswordHash.recommended().hash(body.password), role=body.role, tenant_id=body.tenant_id)
    db.add(member)
    db.commit()
    return dump(member, TEAM_FIELDS)


@app.patch('/api/v1/team/{user_id}', response_model=TeamMember)
def team_update(user_id: UUID, body: UserPatch, user: AdminUser, db: DB):
    lock(db, f'team:{user.mall_id}')
    db.refresh(user)
    if user.role != 'admin' or not user.is_active:
        raise AppError('admin_required', 'Это действие доступно администратору', 403)
    if user_id == user.id:
        raise AppError('self_change_not_allowed', 'Собственную роль и доступ здесь изменить нельзя', 409)
    member = scoped(db, User, user_id, user.mall_id)
    brand_service.validate_assignment(db, body.tenant_id, user.mall_id)
    member.role, member.is_active, member.tenant_id = body.role, body.is_active, body.tenant_id
    db.commit()
    return dump(member, TEAM_FIELDS)


@app.get('/api/v1/imports')
def imports(user: StaffUser, db: DB, source_id: UUID | None = None, limit: Limit = 20, offset: Offset = 0):
    query = select(ImportJob).join(Source).where(Source.mall_id == user.mall_id)
    if source_id:
        scoped(db, Source, source_id, user.mall_id)
        query = query.where(ImportJob.source_id == source_id)
    return paginate(db, query.order_by(ImportJob.created_at.desc(), ImportJob.id.desc()), limit, offset, lambda j: dump(j, JOB_FIELDS))


@app.get('/api/v1/imports/{job_id}')
def get_import(job_id: UUID, user: StaffUser, db: DB):
    return dump(import_job(db, job_id, user), JOB_FIELDS)


@app.get('/api/v1/imports/{job_id}/errors')
def import_errors(job_id: UUID, user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    import_job(db, job_id, user)
    return paginate(db, select(ImportRowResult).where(ImportRowResult.job_id == job_id, ImportRowResult.status == 'rejected').order_by(ImportRowResult.row_number), limit, offset, lambda r: {'row_number': r.row_number, 'code': r.error_code, 'message': r.error_message})


@app.get('/api/v1/customers')
def customers(user: StaffUser, db: DB, q: Annotated[str | None, Query(max_length=200)] = None, identity_status: Literal['verified', 'source_only'] | None = None, limit: Limit = 20, offset: Offset = 0):
    query = select(Customer).where(Customer.mall_id == user.mall_id)
    if identity_status:
        query = query.where(Customer.identity_status == identity_status)
    if q:
        pattern = f'%{q}%'
        normalized = [value for channel in ['email', 'sms'] if (value := normalize_contact(channel, q))]
        contact_ids = select(CustomerContact.customer_id).where(or_(CustomerContact.value.ilike(pattern), CustomerContact.normalized_value.in_(normalized)))
        identity_ids = select(ExternalIdentity.customer_id).where(ExternalIdentity.external_customer_id.ilike(pattern))
        query = query.where(or_(Customer.display_name.ilike(pattern), Customer.global_customer_key.ilike(pattern), Customer.id.in_(contact_ids), Customer.id.in_(identity_ids)))
    return paginate(db, query.order_by(Customer.created_at.desc(), Customer.id.desc()), limit, offset, lambda c: dump(c, CUSTOMER_FIELDS))


@app.get('/api/v1/customers/{customer_id}')
def customer_detail(customer_id: UUID, user: StaffUser, db: DB):
    customer = scoped(db, Customer, customer_id, user.mall_id)
    contacts = db.scalars(select(CustomerContact).where(CustomerContact.customer_id == customer.id)).all()
    return {**dump(customer, CUSTOMER_FIELDS), 'external_identities': [dump(i, ['source_id', 'external_customer_id']) for i in db.scalars(select(ExternalIdentity).where(ExternalIdentity.customer_id == customer.id))], 'contacts': [dump(c, ['id', 'source_id', 'external_customer_id', 'channel', 'value', 'normalized_value']) for c in contacts], 'contact_conflicts': [channel for channel in ['email', 'sms', 'push'] if len({c.normalized_value for c in contacts if c.channel == channel and c.normalized_value}) > 1], 'event_count': db.scalar(select(func.count(Event.id)).where(Event.customer_id == customer.id))}


@app.get('/api/v1/customers/{customer_id}/events')
def customer_events(customer_id: UUID, user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    scoped(db, Customer, customer_id, user.mall_id)
    return paginate(db, select(Event).where(Event.customer_id == customer_id).order_by(Event.occurred_at.desc(), Event.id.desc()), limit, offset, event_public)


@app.get('/api/v1/customers/{customer_id}/recommendations')
def customer_recs(customer_id: UUID, user: StaffUser, db: DB, as_of: datetime | None = None):
    return recommendations(db, scoped(db, Customer, customer_id, user.mall_id), as_of)


@app.get('/api/v1/segments')
def segments(user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    return paginate(db, select(Segment).where(Segment.mall_id == user.mall_id).order_by(Segment.created_at.desc(), Segment.id), limit, offset, lambda s: dump(s, ['id', 'name', 'definition', 'created_at', 'updated_at']))


@app.post('/api/v1/segments', status_code=201)
def create_segment(body: SegmentWrite, user: StaffUser, db: DB):
    definition = body.definition.model_dump(mode='json')
    validate_definition(db, definition, user.mall_id)
    segment = Segment(mall_id=user.mall_id, name=body.name, definition=definition)
    db.add(segment)
    db.commit()
    return dump(segment, ['id', 'name', 'definition', 'created_at', 'updated_at'])


@app.get('/api/v1/segments/{segment_id}')
def get_segment(segment_id: UUID, user: StaffUser, db: DB):
    return dump(scoped(db, Segment, segment_id, user.mall_id), ['id', 'name', 'definition', 'created_at', 'updated_at'])


@app.put('/api/v1/segments/{segment_id}')
def update_segment(segment_id: UUID, body: SegmentWrite, user: StaffUser, db: DB):
    segment = scoped(db, Segment, segment_id, user.mall_id)
    definition = body.definition.model_dump(mode='json')
    validate_definition(db, definition, user.mall_id)
    dependent = db.scalars(select(RecommendationRule).where(RecommendationRule.segment_id == segment.id)).all()
    if any(not destination_compatible(definition, rule.destination_tenant_id) for rule in dependent):
        raise AppError('dependent_rule_conflict', 'Арендатор назначения связанных рекомендаций должен оставаться в условиях исключения', 409)
    segment.name, segment.definition = body.name, definition
    db.commit()
    return dump(segment, ['id', 'name', 'definition', 'created_at', 'updated_at'])


@app.get('/api/v1/segments/{segment_id}/members')
def segment_members(segment_id: UUID, user: StaffUser, db: DB, as_of: datetime | None = None, limit: Limit = 20, offset: Offset = 0):
    result = evaluate(db, scoped(db, Segment, segment_id, user.mall_id), as_of)
    return dict(items=[dump(c, CUSTOMER_FIELDS) for c in result['eligible'][offset:offset + limit]], total=len(result['eligible']), limit=limit, offset=offset, evaluation=evaluation_summary(result))


def rule_public(rule):
    return dump(rule, ['id', 'name', 'segment_id', 'destination_tenant_id', 'priority', 'offer_title', 'offer_description', 'valid_from', 'valid_until', 'is_active'])


def validate_rule(db, body, user):
    segment = scoped(db, Segment, body.segment_id, user.mall_id)
    scoped(db, Tenant, body.destination_tenant_id, user.mall_id)
    if not destination_compatible(segment.definition, body.destination_tenant_id):
        raise AppError('invalid_destination', 'Событие у арендатора назначения должно быть исключено в сегменте')


@app.get('/api/v1/recommendation-rules')
def rules(user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    return paginate(db, select(RecommendationRule).where(RecommendationRule.mall_id == user.mall_id).order_by(RecommendationRule.priority.desc(), RecommendationRule.id), limit, offset, rule_public)


@app.post('/api/v1/recommendation-rules', status_code=201)
def create_rule(body: RecommendationRuleWrite, user: StaffUser, db: DB):
    validate_rule(db, body, user)
    rule = RecommendationRule(mall_id=user.mall_id, **body.model_dump())
    db.add(rule)
    db.commit()
    return rule_public(rule)


@app.put('/api/v1/recommendation-rules/{rule_id}')
def update_rule(rule_id: UUID, body: RecommendationRuleWrite, user: StaffUser, db: DB):
    rule = scoped(db, RecommendationRule, rule_id, user.mall_id)
    validate_rule(db, body, user)
    if body.segment_id != rule.segment_id and db.scalar(select(Campaign.id).where(Campaign.recommendation_rule_id == rule.id)):
        raise AppError('campaign_conflict', 'Правило уже используется кампанией; создайте новое правило для другого сегмента', 409)
    for key, value in body.model_dump().items():
        setattr(rule, key, value)
    db.commit()
    return rule_public(rule)


def campaign_public(c):
    return dump(c, ['id', 'name', 'segment_id', 'recommendation_rule_id', 'channel', 'created_at'])


@app.get('/api/v1/campaigns')
def campaigns(user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    return paginate(db, select(Campaign).where(Campaign.mall_id == user.mall_id).order_by(Campaign.created_at.desc(), Campaign.id), limit, offset, campaign_public)


@app.post('/api/v1/campaigns', status_code=201)
def create_campaign(body: CampaignWrite, user: StaffUser, db: DB):
    scoped(db, Segment, body.segment_id, user.mall_id)
    rule = scoped(db, RecommendationRule, body.recommendation_rule_id, user.mall_id)
    if rule.segment_id != body.segment_id:
        raise AppError('segment_mismatch', 'Сегмент кампании должен совпадать с сегментом правила')
    campaign = Campaign(mall_id=user.mall_id, **body.model_dump())
    db.add(campaign)
    db.commit()
    return campaign_public(campaign)


@app.get('/api/v1/campaigns/{campaign_id}')
def get_campaign(campaign_id: UUID, user: StaffUser, db: DB):
    return campaign_public(scoped(db, Campaign, campaign_id, user.mall_id))


@app.get('/api/v1/campaigns/{campaign_id}/preview')
def campaign_preview(campaign_id: UUID, user: StaffUser, db: DB):
    return preview(db, scoped(db, Campaign, campaign_id, user.mall_id))[0]


@app.get('/api/v1/campaigns/{campaign_id}/exports')
def campaign_exports(campaign_id: UUID, user: StaffUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    scoped(db, Campaign, campaign_id, user.mall_id)
    return paginate(db, select(Export).where(Export.campaign_id == campaign_id).order_by(Export.created_at.desc()), limit, offset, export_public)


@app.post('/api/v1/campaigns/{campaign_id}/exports', status_code=201)
def campaign_export(campaign_id: UUID, user: StaffUser, response: Response, idempotency_key: Annotated[UUID, Header()], db: DB):
    result, created = create_export(campaign_id, user.mall_id, idempotency_key)
    response.status_code = 201 if created else 200
    return result


@app.get('/api/v1/exports/{export_id}/download')
def download(export_id: UUID, user: StaffUser, db: DB):
    row = db.get(Export, export_id)
    if not row:
        raise AppError('not_found', 'Выгрузка не найдена', 404)
    scoped(db, Campaign, row.campaign_id, user.mall_id)
    return Response(row.file_content, media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="export-{row.id}.csv"'})


# Protected convenience endpoint for reproducible hackathon imports; not a production connector.
@app.get('/api/v1/demo/files/{name}')
def demo_file(name: str, user: StaffUser):
    allowed = {'pos_B.xlsx', 'crm_C_initial.csv', 'crm_C_after.csv', 'crm_C_conflict.csv'}
    if name not in allowed:
        raise AppError('not_found', 'Демонстрационный файл не найден', 404)
    return FileResponse(settings.path('demo_dir') / name, filename=name)


app.openapi = lambda: json.loads((ROOT / 'docs/spec/02_OPENAPI.json').read_text())


def radar_options(lookback_days: Annotated[int, Query(ge=1, le=365)] = 90,
                  min_shared_customers: Annotated[int, Query(ge=2, le=1000)] = 3,
                  min_lift: Annotated[float, Query(ge=1.01, le=100, allow_inf_nan=False)] = 1.1):
    return RadarOptions(lookback_days=lookback_days, min_shared_customers=min_shared_customers, min_lift=min_lift)


RadarQuery = Annotated[RadarOptions, Depends(radar_options)]


@app.get('/api/v1/radar', response_model=RadarReport)
def radar_report(user: StaffUser, options: RadarQuery):
    return radar_service.snapshot(user.mall_id, options)


@app.get('/api/v1/radar/opportunities/{opportunity_id}', response_model=RadarAudience)
def radar_audience(opportunity_id: UUID, user: StaffUser, options: RadarQuery, limit: Limit = 20, offset: Offset = 0):
    return radar_service.snapshot(user.mall_id, options, opportunity_id, limit, offset)


@app.post('/api/v1/radar/campaigns', status_code=201, response_model=RadarCampaignResult)
def radar_campaign(body: RadarCampaignWrite, user: StaffUser, response: Response):
    result = radar_service.launch(user.mall_id, body)
    response.status_code = 201 if result['created'] else 200
    return result


@app.post('/api/v1/demo/radar', status_code=202, response_model=RadarDemoResult)
def radar_demo(body: RadarDemoWrite, user: StaffUser, db: DB):
    return enqueue_radar_demo(db, user.mall_id, body.stage)


@app.get('/api/v1/brand/context', response_model=BrandContext)
def brand_context(user: BrandUser, db: DB):
    return brand_service.context(db, user)[1]


async def mapped_brand_file(user, db, file, mapping):
    source, info = brand_service.context(db, user)
    content = await file.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise AppError('file_too_large', 'Максимальный размер файла — 10 MiB', 413)
    try:
        selected = ColumnMapping.model_validate_json(mapping) if mapping is not None else None
    except ValidationError as exc:
        raise AppError('invalid_mapping', 'Выберите отдельные колонки для времени и хотя бы одного контакта') from exc
    table, sheet_name, encoding = await run_in_threadpool(brand_service.read_table, file.filename, content)
    report, records = await run_in_threadpool(brand_service.preview, table, info['timezone'], selected, sheet_name, encoding)
    return source, report, records


@app.post('/api/v1/brand/imports/preview', response_model=FilePreview)
async def brand_preview(user: BrandUser, db: DB, file: UploadFile = File(...), mapping: str | None = Form(None)):
    _, report, _ = await mapped_brand_file(user, db, file, mapping)
    return report


@app.post('/api/v1/brand/imports', status_code=202)
async def brand_upload(user: BrandUser, db: DB, file: UploadFile = File(...), mapping: str = Form(...)):
    source, report, records = await mapped_brand_file(user, db, file, mapping)
    if not report['valid_rows']:
        raise AppError('no_valid_rows', 'Нет корректных записей. Проверьте сопоставление колонок и значения в таблице.')
    identifier = uuid4()
    directory = settings.path('upload_dir')
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'{identifier}.csv'
    path.write_bytes(brand_service.canonical_csv(records))
    try:
        job = ImportJob(id=identifier, source_id=source.id, file_path=str(path))
        db.add(job)
        db.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return dump(job, JOB_FIELDS)


@app.get('/api/v1/brand/imports')
def brand_imports(user: BrandUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    source, _ = brand_service.context(db, user)
    return paginate(db, select(ImportJob).where(ImportJob.source_id == source.id)
        .order_by(ImportJob.created_at.desc(), ImportJob.id.desc()), limit, offset, lambda job: dump(job, JOB_FIELDS))


@app.get('/api/v1/brand/imports/{job_id}/errors')
def brand_errors(job_id: UUID, user: BrandUser, db: DB, limit: Limit = 20, offset: Offset = 0):
    source, _ = brand_service.context(db, user)
    if not db.scalar(select(ImportJob.id).where(ImportJob.id == job_id, ImportJob.source_id == source.id)):
        raise AppError('not_found', 'Загрузка не найдена', 404)
    return paginate(db, select(ImportRowResult).where(ImportRowResult.job_id == job_id, ImportRowResult.status == 'rejected')
        .order_by(ImportRowResult.row_number), limit, offset,
        lambda row: dict(row_number=row.row_number, code=row.error_code, message=row.error_message))
