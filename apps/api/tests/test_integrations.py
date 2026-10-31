import io
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID

import httpx
import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from app.core.config import Clock, settings
from app.core.db import SessionLocal
from app.models import Event, ImportJob, Mall, Source, Tenant, User
from app.modules.ingestion.service import process_job
from app.modules.integrations.contracts import ContactRecord
from app.modules.integrations.service import schedule_due


def tenant(admin_client, name='Магазин «Маяк»'):
    response = admin_client.post('/api/v1/tenants', json={'name': name, 'category': 'Книги'})
    assert response.status_code == 201, response.text
    return next(x for x in admin_client.get('/api/v1/integrations').json()['items'] if x['tenant_id'] == response.json()['id'])


def record(**changes):
    return {'phone': '8 (913) 123-45-67', 'email': 'VISITOR@example.invalid', 'time': (Clock.now()-timedelta(days=2)).isoformat(), **changes}


def test_admin_and_marketer_are_enforced_on_server(client, admin_client):
    assert client.get('/api/v1/team').status_code == 403
    assert client.post('/api/v1/tenants', json={'name': 'X', 'category': 'Y'}).status_code == 403
    source = tenant(admin_client)
    assert client.patch(f'/api/v1/integrations/{source["id"]}', json={'api_url': ''}).status_code == 403
    assert client.patch(f'/api/v1/sources/{source["id"]}/coverage', json={'covered_event_types': []}).status_code == 403
    assert client.post(f'/api/v1/integrations/{source["id"]}/test').status_code == 403
    result = client.get('/api/v1/integrations').json()['items']
    assert all(x.get('api_url') is None and x.get('credential_env') is None for x in result)


@pytest.mark.parametrize('kind', ['csv', 'xlsx'])
def test_same_three_fields_in_both_files_and_reimport_is_duplicate(client, admin_client, kind):
    source = tenant(admin_client)
    row = record()
    if kind == 'csv':
        data = f'phone,email,time\n{row["phone"]},{row["email"]},{row["time"]}\n'.encode()
    else:
        book = Workbook(); book.active.append(['phone', 'email', 'time']); book.active.append(list(row.values()))
        output = io.BytesIO(); book.save(output); data = output.getvalue()
    for expected in [(1, 0), (0, 1)]:
        job = client.post(f'/api/v1/sources/{source["id"]}/imports', files={'file': (f'contacts.{kind}', data)})
        assert job.status_code == 202, job.text
        process_job(job.json()['id'])
        result = client.get(f'/api/v1/imports/{job.json()["id"]}').json()
        assert result['status'] == 'succeeded', result
        assert (result['accepted_rows'], result['duplicate_rows']) == expected
    with SessionLocal() as db:
        event = db.scalar(select(Event).where(Event.source_id == UUID(source['id'])))
        assert event.event_type == 'interaction' and event.amount is None
        saved = db.get(Source, UUID(source['id']))
        assert saved.coverage_from is saved.coverage_to is None


@pytest.mark.parametrize('changes', [{'phone': None, 'email': None}, {'email': 'bad'}, {'time': '2026-10-20T12:00:00'}, {'time': 1234567}, {'amount': 20}])
def test_invalid_minimal_records(changes):
    with pytest.raises(ValueError): ContactRecord.model_validate(record(**changes))


def test_contact_record_normalization_does_not_require_source_ids():
    value = ContactRecord.model_validate(record())
    assert value.phone == '+79131234567' and value.email == 'visitor@example.invalid'


def test_pagination_schedule_cursor_coverage_and_no_duplicate_jobs(client, admin_client, monkeypatch):
    source = tenant(admin_client)
    url = f'/api/v1/integrations/{source["id"]}'
    body = {'api_url': 'https://tenant.example/records?shop=1', 'enabled': True, 'interval_minutes': 5}
    monkeypatch.setattr(settings, 'connector_allowed_hosts', 'tenant.example')
    assert admin_client.patch(url, json=body).status_code == 200
    called = []
    original_client = httpx.Client
    now = Clock.now()
    start, end = (now-timedelta(days=120)).isoformat(), now.isoformat()
    def handler(request):
        assert request.url.params['shop'] == '1'
        called.append(request.url.params.get('cursor'))
        first = not request.url.params.get('cursor')
        return httpx.Response(200, json={'records': [record()] if first else [], 'next_cursor': 'one' if first else 'two',
            'has_more': first, 'coverage_from': start, 'coverage_to': end})
    monkeypatch.setattr('app.modules.integrations.service.httpx.Client', lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs))
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda _: schedule_due(), range(2)))
    with SessionLocal() as db:
        jobs = db.scalars(select(ImportJob).where(ImportJob.source_id == UUID(source['id']))).all()
        assert len(jobs) == 1
        job_id = jobs[0].id
    assert admin_client.patch(url, json=body).status_code == 409
    process_job(job_id)
    assert called == [None, 'one']
    with SessionLocal() as db:
        saved = db.get(Source, UUID(source['id']))
        assert saved.config['cursor'] == 'two' and saved.coverage_from.isoformat() == start
        assert saved.covered_event_types == ['interaction']
    job = client.post(f'/api/v1/sources/{source["id"]}/sync')
    process_job(job.json()['id'])
    assert called[-1] == 'two'
    assert client.get(f'/api/v1/imports/{job.json()["id"]}').json()['status'] == 'succeeded'


def test_invalid_provider_rows_do_not_advance_cursor(admin_client, monkeypatch):
    source = tenant(admin_client)
    with SessionLocal.begin() as db:
        db.get(Source, UUID(source['id'])).config = {'api_url': 'https://tenant.example', 'cursor': 'old'}
    monkeypatch.setattr('app.modules.ingestion.service.fetch_api', lambda _: json.dumps({'records': [record(email='bad')], 'next_cursor': 'new'}).encode())
    job = admin_client.post(f'/api/v1/sources/{source["id"]}/sync').json()
    process_job(job['id'])
    with SessionLocal() as db:
        assert db.get(Source, UUID(source['id'])).config['cursor'] == 'old'


def test_foreign_source_and_configuration_validation_are_atomic(admin_client, monkeypatch):
    source = tenant(admin_client)
    with SessionLocal.begin() as db:
        mall = Mall(name='Другой ТЦ'); db.add(mall); db.flush()
        other = Tenant(mall_id=mall.id, code='other', name='Другой', category='Тест'); db.add(other); db.flush()
        other_source = Source(mall_id=mall.id, tenant_id=other.id, name='Чужой', kind='contacts'); db.add(other_source); db.flush(); foreign = other_source.id
    assert admin_client.patch(f'/api/v1/integrations/{foreign}', json={}).status_code == 404
    assert admin_client.post(f'/api/v1/integrations/{foreign}/test').status_code == 404
    for body in [{'api_url': 'http://evil.invalid'}, {'api_url': 'https://user:secret@localhost'}, {'enabled': True}, {'interval_minutes': 0}, {'credential_env': 'DATABASE_URL'}, {'coverage_from': '2026-10-20T00:00:00+07:00'}]:
        assert admin_client.patch(f'/api/v1/integrations/{source["id"]}', json=body).status_code == 422
    saved = next(x for x in admin_client.get('/api/v1/integrations').json()['items'] if x['id'] == source['id'])
    assert saved['api_url'] == '' and not saved['enabled']


def test_team_role_changes_take_effect_and_own_access_is_protected(client, admin_client):
    own = admin_client.get('/api/v1/auth/me').json()
    assert admin_client.patch(f'/api/v1/team/{own["id"]}', json={'role': 'marketer', 'is_active': False}).status_code == 409
    member = client.get('/api/v1/auth/me').json()
    assert admin_client.patch(f'/api/v1/team/{member["id"]}', json={'role': 'marketer', 'is_active': False}).status_code == 200
    assert client.get('/api/v1/customers').status_code == 401
    response = admin_client.post('/api/v1/team', json={'email': 'new@example.invalid', 'password': 'StrongPassword2026!', 'role': 'marketer'})
    assert response.status_code == 201 and 'password' not in response.json() and 'password_hash' not in response.json()


def test_interaction_radar_and_dynamic_segment_do_not_infer_purchases(client, admin_client):
    from app.models import RecommendationRule, Segment
    from app.modules.customers.service import ingest_event
    from app.modules.integrations.service import normalized_event
    sources = [tenant(admin_client, f'Место {i}') for i in range(3)]
    now = Clock.now()
    with SessionLocal.begin() as db:
        for index, info in enumerate(sources):
            source = db.get(Source, UUID(info['id']))
            source.coverage_from, source.coverage_to = now-timedelta(days=120), now
            source.covered_event_types, source.last_success_at = ['interaction'], now
            numbers = range(1,11) if index == 0 else [*range(1,7),19,20] if index == 1 else range(11,21)
            for number in numbers:
                data = normalized_event(record(phone=None, email=f'person{number}@example.invalid'))
                from app.contracts import NormalizedEvent
                ingest_event(db, source, NormalizedEvent.model_validate(data))
        definition = {'lookback_days': 90, 'include_all': [{'tenant_id': sources[0]['tenant_id'], 'event_types': ['interaction']}],
            'exclude_any': [{'tenant_id': sources[1]['tenant_id'], 'event_types': ['interaction']}],
            'require_verified_identity': True, 'require_complete_coverage': True}
        segment = Segment(mall_id=source.mall_id, name='Без взаимодействия в месте назначения', definition=definition)
        db.add(segment); db.flush()
        db.add(RecommendationRule(mall_id=source.mall_id, segment_id=segment.id, destination_tenant_id=UUID(sources[1]['tenant_id']),
            name='Предложение', priority=80, offer_title='Знакомство', offer_description='', is_active=True,
            valid_from=now-timedelta(days=1), valid_until=now+timedelta(days=30)))
        segment_id = segment.id
    report = client.get('/api/v1/radar').json()
    opportunity = next(x for x in report['opportunities'] if x['destination']['tenant_id'] == sources[1]['tenant_id'])
    assert opportunity['candidate_count'] == 4 and opportunity['lift'] == pytest.approx(1.5)
    assert opportunity['definition']['exclude_any'][0]['event_types'] == ['interaction']
    assert 'покуп' not in opportunity['explanation']
    assert client.get(f'/api/v1/segments/{segment_id}/members').json()['total'] == 4
    with SessionLocal.begin() as db:
        source = db.get(Source, UUID(sources[1]['id']))
        ingest_event(db, source, NormalizedEvent.model_validate(normalized_event(record(phone=None, email='person7@example.invalid'))))
    assert client.get(f'/api/v1/segments/{segment_id}/members').json()['total'] == 3


def test_workspace_preparation_is_repeatable_and_preserves_configuration(admin_client):
    from app.workspace_seed import prepare
    jobs = prepare()
    assert len(jobs) == 9
    with SessionLocal.begin() as db:
        source = db.scalar(select(Source).order_by(Source.name))
        source.config = {**source.config, 'enabled': False, 'api_url': 'https://tenant.example/custom'}
        source_id = source.id
    assert prepare() == []
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Tenant.id))) == 9
        assert not db.get(Source, source_id).config['enabled']
        assert db.get(Source, source_id).config['api_url'] == 'https://tenant.example/custom'


def test_api_cycle_deadline_preserves_worker_lease(monkeypatch):
    from app.core.errors import AppError
    from app.modules.integrations.service import read_page
    monkeypatch.setattr('app.modules.integrations.service.time.monotonic', lambda: 100)
    with pytest.raises(AppError) as error:
        read_page({'api_url': 'https://tenant.example'}, deadline=90)
    assert error.value.code == 'source_timeout'
