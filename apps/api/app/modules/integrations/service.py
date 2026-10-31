"""Scheduled pulls of a single contact format; credentials stay on the server."""
import hashlib
import json
import os
import time
from datetime import datetime, timedelta
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from sqlalchemy import select

from app.core.config import Clock, settings
from app.core.db import SessionLocal, json_value
from app.core.errors import AppError
from app.models import ImportJob, Source, Tenant
from app.modules.sources.contracts import SourceCoveragePatch
from .contracts import ContactRecord

MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS = 10000


def validate_api_url(value):
    value = value.strip()
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError as exc:
        raise AppError('invalid_api_url', 'Некорректный адрес API') from exc
    hosts = {v.strip().lower() for v in settings.connector_allowed_hosts.split(',') if v.strip()}
    http_hosts = {v.strip().lower() for v in settings.connector_http_hosts.split(',') if v.strip()}
    if (not url.hostname or url.hostname.lower() not in hosts or url.username or url.password
            or url.fragment or url.scheme not in ('http', 'https')
            or (url.scheme == 'http' and url.hostname.lower() not in http_hosts)
            or any(c.isspace() or ord(c) < 32 for c in value)
            or (port is not None and not 1 <= port <= 65535)):
        raise AppError('api_host_not_allowed', 'Укажите HTTPS API арендатора. Его адрес должен быть добавлен администратором сервера в список разрешённых подключений.')
    return value


def normalized_event(raw):
    record = ContactRecord.model_validate(raw)
    identity = hashlib.sha256(json.dumps([record.phone, record.email], ensure_ascii=False).encode()).hexdigest()
    event_id = hashlib.sha256(f'{identity}:{record.time.isoformat()}'.encode()).hexdigest()
    return dict(external_customer_id=f'contact-{identity}', external_event_id=f'interaction-{event_id}',
                display_name=f'Клиент {record.phone[-4:] if record.phone else identity[:6].upper()}',
                email=record.email, phone=record.phone, occurred_at=record.time, event_type='interaction')


def config(source):
    return dict(source.config or {})


def connection_public(source, tenant, admin=False):
    value = config(source)
    result = dict(id=source.id, tenant_id=tenant.id, tenant_name=tenant.name, category=tenant.category,
                  name=source.name, kind=source.kind, enabled=bool(value.get('enabled')),
                  interval_minutes=value.get('interval_minutes', 15), last_success_at=source.last_success_at,
                  next_sync_at=value.get('next_sync_at'), last_error=value.get('last_error'),
                  coverage_from=source.coverage_from, coverage_to=source.coverage_to,
                  covered_event_types=source.covered_event_types, has_credentials=bool(value.get('credential_env')),
                  has_api=bool(value.get('api_url')))
    if admin:
        result.update(api_url=value.get('api_url', ''), credential_env=value.get('credential_env'))
    return json_value(result)


def active_job(db, source_id):
    return db.scalar(select(ImportJob).where(ImportJob.source_id == source_id,
                     ImportJob.status.in_(['queued', 'running'])).order_by(ImportJob.created_at.desc()))


def save_config(db, source, body):
    if active_job(db, source.id):
        raise AppError('import_in_progress', 'Дождитесь завершения текущей загрузки перед изменением подключения', 409)
    value = body.model_dump(exclude={'coverage_from', 'coverage_to'})
    value['api_url'] = validate_api_url(body.api_url) if body.api_url.strip() else ''
    if body.enabled and not value['api_url']:
        raise AppError('api_url_required', 'Для автоматической загрузки нужен адрес API')
    if body.credential_env and not os.environ.get(body.credential_env):
        raise AppError('credential_unavailable', 'Указанный секрет подключения не настроен на сервере')
    old = config(source)
    # A new endpoint/credential starts a fresh incremental cursor.
    same = value['api_url'] == old.get('api_url') and body.credential_env == old.get('credential_env')
    value.update(cursor=old.get('cursor') if same else None, next_sync_at=Clock.now().isoformat() if body.enabled else None,
                 last_error=None, workspace_prepared=old.get('workspace_prepared', False))
    source.kind = 'contacts'
    source.config = value
    if {'coverage_from', 'coverage_to'} & body.model_fields_set:
        from app.modules.sources.service import update_coverage
        update_coverage(db, source.id, source.mall_id, SourceCoveragePatch.model_validate({
            'coverage_from': body.coverage_from, 'coverage_to': body.coverage_to,
            'covered_event_types': ['interaction']}))


def enqueue_sync(db, source):
    existing = active_job(db, source.id)
    if existing:
        return existing
    if source.kind == 'contacts' and not config(source).get('api_url'):
        raise AppError('api_not_configured', 'Администратор ещё не настроил API этого арендатора. Можно загрузить CSV или Excel.')
    job = ImportJob(id=uuid4(), source_id=source.id)
    db.add(job)
    if source.kind == 'contacts':
        value = config(source)
        value['next_sync_at'] = (Clock.now() + timedelta(minutes=value.get('interval_minutes', 15))).isoformat()
        source.config = value
    return job


def schedule_due():
    with SessionLocal.begin() as db:
        now = Clock.now()
        sources = db.scalars(select(Source).join(Tenant).where(Source.kind == 'contacts',
                              Tenant.is_active.is_(True)).with_for_update(of=Source, skip_locked=True)).all()
        for source in sources:
            value = config(source)
            due = datetime.fromisoformat(value['next_sync_at']) if value.get('next_sync_at') else now
            if value.get('enabled') and due <= now:
                enqueue_sync(db, source)


def read_page(value, cursor=None, deadline=None):
    deadline = deadline if deadline is not None else time.monotonic()+40
    if time.monotonic() >= deadline:
        raise AppError('source_timeout', 'API не завершил цикл вовремя. Уменьшите объём одной синхронизации.', 503)
    url = validate_api_url(value.get('api_url', ''))
    headers = {'Accept': 'application/json'}
    if name := value.get('credential_env'):
        token = os.environ.get(name)
        if not token:
            raise AppError('credential_unavailable', 'Секрет подключения недоступен на сервере', 503)
        headers['Authorization'] = f'Bearer {token}'
    try:
        with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
            target = httpx.URL(url)
            if cursor:
                target = target.copy_merge_params({'cursor': cursor})
            with client.stream('GET', target, headers=headers) as response:
                response.raise_for_status()
                data = bytearray()
                for chunk in response.iter_bytes():
                    if time.monotonic() >= deadline:
                        raise AppError('source_timeout', 'API не завершил цикл вовремя. Уменьшите объём одной синхронизации.', 503)
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise AppError('source_too_large', 'Ответ API превышает 10 MiB')
        page = json.loads(data)
        if not isinstance(page, dict) or set(page) - {'records', 'next_cursor', 'has_more', 'coverage_from', 'coverage_to'}:
            raise ValueError()
        if not isinstance(page.get('records'), list) or len(page['records']) > MAX_ROWS:
            raise ValueError()
        if not isinstance(page.get('has_more', False), bool):
            raise ValueError()
        next_cursor = page.get('next_cursor')
        if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor or len(next_cursor) > 2048):
            raise ValueError()
        if page.get('has_more') and (not next_cursor or next_cursor == cursor):
            raise ValueError()
        if 'coverage_from' in page or 'coverage_to' in page:
            coverage = SourceCoveragePatch.model_validate({k: page.get(k) for k in ['coverage_from', 'coverage_to']})
            start, end = coverage.coverage_from, coverage.coverage_to
            if (start is None) != (end is None) or (start is not None and (start >= end or end > Clock.now())):
                raise ValueError()
        return page
    except AppError:
        raise
    except httpx.HTTPError as exc:
        raise AppError('source_unavailable', 'API арендатора недоступен или отклонил подключение. Проверьте адрес и секрет доступа.', 503) from exc
    except (ValueError, TypeError) as exc:
        raise AppError('invalid_api_response', 'Нужен JSON с records: телефон (phone), email и время (time); next_cursor и has_more используются для продолжения.') from exc


def fetch_contacts(source):
    value = config(source)
    cursor = value.get('cursor')
    seen = set()
    rows = []
    total_bytes = 0
    # Stay below the worker's 60-second lease while fetching the entire batch.
    deadline = time.monotonic()+40
    for _ in range(20):
        page = read_page(value, cursor, deadline)
        total_bytes += len(json.dumps(page).encode())
        if total_bytes > MAX_BYTES:
            raise AppError('source_too_large', 'Данные одного цикла API превышают 10 MiB')
        rows.extend(page['records'])
        if len(rows) > MAX_ROWS:
            raise AppError('too_many_rows', 'Один цикл API допускает до 10 000 записей')
        cursor = page.get('next_cursor')
        if not page.get('has_more'):
            result = {**page, 'records': rows}
            data = json.dumps(result).encode()
            if len(data) > MAX_BYTES:
                raise AppError('source_too_large', 'Данные одного цикла API превышают 10 MiB')
            return data
        if cursor in seen:
            break
        seen.add(cursor)
    raise AppError('invalid_api_pagination', 'API не завершил выдачу за 20 страниц. Уменьшите размер периода синхронизации.')
