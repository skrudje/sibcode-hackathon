import io
import json
from datetime import datetime, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select

from app.core.config import Clock, settings
from app.core.db import SessionLocal
from app.main import app
from app.models import Customer, Event, ImportJob, Mall, Source, Tenant, User
from app.modules.ingestion.service import process_job


@pytest.fixture
def brand(admin_client):
    tenant = admin_client.post('/api/v1/tenants', json={'name': 'Бренд «Маяк»', 'category': 'Книги'}).json()
    member = admin_client.post('/api/v1/team', json={'email': 'brand@example.invalid',
        'password': 'BrandPassword2026!', 'role': 'brand', 'tenant_id': tenant['id']})
    assert member.status_code == 201, member.text
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as browser:
        assert browser.post('/api/v1/auth/login', json={'email': 'brand@example.invalid', 'password': 'BrandPassword2026!'}).status_code == 200
        yield browser, tenant, member.json()


def submit(browser, content, mapping=None, endpoint='preview', filename='clients.csv'):
    return browser.post('/api/v1/brand/imports' + ('/preview' if endpoint == 'preview' else ''),
        files={'file': (filename, content)}, data={'mapping': json.dumps(mapping)} if mapping is not None else {})


def test_brand_role_cannot_access_staff_or_other_tenant_data(brand, admin_client):
    browser, tenant, member = brand
    assert browser.get('/api/v1/auth/me').json()['tenant_id'] == tenant['id']
    info = browser.get('/api/v1/brand/context').json()
    assert info['tenant_name'] == tenant['name']
    for path in ['summary', 'customers', 'sources', 'integrations', 'imports', 'radar', 'segments', 'campaigns', 'recommendation-rules', 'team', 'tenants']:
        assert browser.get('/api/v1/' + path).status_code == 403, path
    assert browser.post('/api/v1/sources/' + info['source_id'] + '/sync').status_code == 403
    assert browser.post('/api/v1/sources/' + info['source_id'] + '/imports', files={'file': ('a.csv', b'phone,email,time\n')}).status_code == 403
    assert browser.get(f'/api/v1/exports/{uuid4()}/download').status_code == 403
    assert browser.get(f'/api/v1/brand/imports/{uuid4()}/errors').status_code == 404
    assert admin_client.get('/api/v1/brand/context').status_code == 403
    assert admin_client.patch(f'/api/v1/team/{member["id"]}', json={'role': 'brand', 'tenant_id': tenant['id'], 'is_active': False}).status_code == 200
    assert browser.get('/api/v1/brand/context').status_code == 401


def test_preview_maps_selected_columns_without_persisting_raw_data(brand):
    browser, _, _ = brand
    timestamp = (Clock.now() - timedelta(days=1)).isoformat()
    content = f'Имя;Мобильный;Почта;Когда;Сумма\nСЕКРЕТНОЕ ИМЯ;8 (913) 123-45-67;CLIENT@EXAMPLE.INVALID;{timestamp};99999\n'.encode()
    existing_files = set(settings.path('upload_dir').glob('*'))
    first = submit(browser, content)
    assert first.status_code == 200, first.text
    assert first.json()['total_rows'] == 1
    assert [c['name'] for c in first.json()['columns']] == ['Имя', 'Мобильный', 'Почта', 'Когда', 'Сумма']
    checked = submit(browser, content, {'phone': 1, 'email': 2, 'time': 3})
    assert checked.status_code == 200, checked.text
    assert checked.json()['valid_rows'] == 1
    assert checked.json()['sample'][0]['phone'] == '+79131234567'
    assert checked.json()['sample'][0]['email'] == 'client@example.invalid'
    assert set(settings.path('upload_dir').glob('*')) == existing_files
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0
        assert db.scalar(select(func.count()).select_from(Customer)) == 0
    uploaded = submit(browser, content, {'phone': 1, 'email': 2, 'time': 3}, endpoint='import')
    assert uploaded.status_code == 202, uploaded.text
    with SessionLocal.begin() as db:
        job = db.get(ImportJob, UUID(uploaded.json()['id']))
        from pathlib import Path
        stored = Path(job.file_path).read_text(encoding='utf-8-sig')
        assert stored.startswith('phone,email,time')
        assert 'СЕКРЕТНОЕ ИМЯ' not in stored and '99999' not in stored
        source = db.get(Source, job.source_id)
        source.config = {**source.config, 'cursor': 'do-not-reset'}
    process_job(uploaded.json()['id'])
    assert browser.get('/api/v1/brand/imports').json()['items'][0]['accepted_rows'] == 1
    with SessionLocal() as db:
        source = db.get(Source, UUID(uploaded.json()['source_id']))
        assert source.config['cursor'] == 'do-not-reset'
        assert source.coverage_from is source.coverage_to is None
    again = submit(browser, content, {'phone': 1, 'email': 2, 'time': 3}, endpoint='import').json()
    process_job(again['id'])
    jobs = browser.get('/api/v1/brand/imports').json()['items']
    assert sum(j['accepted_rows'] for j in jobs) == 1
    assert sum(j['duplicate_rows'] for j in jobs) == 1


def test_excel_native_dates_and_bad_rows_flow_through_existing_worker(brand):
    browser, _, _ = brand
    book = Workbook()
    book.active.title = 'Клиенты'
    book.active.append(['Телефон', 'Почта', 'Дата', 'Не передавать'])
    naive = (Clock.now() - timedelta(days=2)).replace(tzinfo=None, microsecond=0)
    book.active.append([79131234567, 'good@example.invalid', naive, 'hidden'])
    book.active.append(['wrong', 'bad', 'нет даты', 'hidden'])
    output = io.BytesIO(); book.save(output); book.close()
    mapping = {'phone': 0, 'email': 1, 'time': 2}
    report = submit(browser, output.getvalue(), mapping, filename='data.xlsx')
    assert report.status_code == 200, report.text
    data = report.json()
    assert (data['valid_rows'], data['invalid_rows'], data['sheet_name']) == (1, 1, 'Клиенты')
    assert data['timezone'] == 'Asia/Krasnoyarsk'
    assert datetime.fromisoformat(data['sample'][0]['time']) == naive.replace(tzinfo=ZoneInfo('Asia/Krasnoyarsk'))
    uploaded = submit(browser, output.getvalue(), mapping, endpoint='import', filename='data.xlsx')
    assert uploaded.status_code == 202, uploaded.text
    process_job(uploaded.json()['id'])
    job = browser.get('/api/v1/brand/imports').json()['items'][0]
    assert (job['accepted_rows'], job['rejected_rows']) == (1, 1)
    errors = browser.get(f'/api/v1/brand/imports/{job["id"]}/errors').json()
    assert errors['items'][0]['row_number'] == 2
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Event)) == 1


@pytest.mark.parametrize('mapping', [{'phone': 0, 'time': 0}, {'time': 1}, {'email': 9, 'time': 1}, {'phone': -1, 'time': 1}])
def test_mapping_is_validated_on_server(brand, mapping):
    assert submit(brand[0], b'Phone,Time\nwrong,wrong\n', mapping).status_code == 422


def test_brand_cannot_assign_itself_or_read_another_store_jobs(brand, admin_client):
    browser, _, member = brand
    another = admin_client.post('/api/v1/tenants', json={'name': 'Другой бренд', 'category': 'Спорт'}).json()
    source = next(s for s in admin_client.get('/api/v1/integrations').json()['items'] if s['tenant_id'] == another['id'])
    job = admin_client.post(f'/api/v1/sources/{source["id"]}/imports', files={'file': ('a.csv', b'phone,email,time\n')}).json()
    assert browser.get(f'/api/v1/brand/imports/{job["id"]}/errors').status_code == 404
    assert browser.get('/api/v1/brand/imports').json()['total'] == 0
    assert browser.patch(f'/api/v1/team/{member["id"]}', json={'role': 'admin', 'is_active': True}).status_code == 403
    with SessionLocal.begin() as db:
        other_mall = Mall(name='Другой ТЦ'); db.add(other_mall); db.flush()
        other_tenant = Tenant(mall_id=other_mall.id, code='other', name='Чужой', category='Книги'); db.add(other_tenant); db.flush()
        foreign_id = str(other_tenant.id)
    response = admin_client.patch(f'/api/v1/team/{member["id"]}', json={'role': 'brand', 'tenant_id': foreign_id, 'is_active': True})
    assert response.status_code == 422
    assert browser.get('/api/v1/brand/context').status_code == 200


def test_brand_requires_assignment_and_preview_does_not_allow_other_formats(admin_client, brand):
    response = admin_client.post('/api/v1/team', json={'email': 'missing@example.invalid', 'password': 'BrandPassword2026!', 'role': 'brand'})
    assert response.status_code == 422
    assert submit(brand[0], b'anything', filename='file.exe').status_code == 415
    assert submit(brand[0], b'not an Excel file', filename='file.xlsx').status_code == 422


def test_brand_data_joins_existing_customer_from_another_store(brand, admin_client):
    browser, _, _ = brand
    another = admin_client.post('/api/v1/tenants', json={'name': 'Кафе', 'category': 'Еда'}).json()
    source = next(s for s in admin_client.get('/api/v1/integrations').json()['items'] if s['tenant_id'] == another['id'])
    timestamp = (Clock.now() - timedelta(days=1)).isoformat()
    first = admin_client.post(f'/api/v1/sources/{source["id"]}/imports', files={'file': ('contacts.csv',
        f'phone,email,time\n+79131234567,,{timestamp}\n'.encode())}).json()
    process_job(first['id'])
    second = submit(browser, f'Номер;Когда;Лишнее\n8 (913) 123-45-67;{timestamp};не сохранять\n'.encode(),
        {'phone': 0, 'time': 1}, endpoint='import')
    assert second.status_code == 202, second.text
    process_job(second.json()['id'])
    customers = admin_client.get('/api/v1/customers?q=%2B79131234567').json()
    assert customers['total'] == 1
    detail = admin_client.get('/api/v1/customers/' + customers['items'][0]['id']).json()
    assert detail['event_count'] == 2
    assert len(detail['external_identities']) == 2


def test_role_and_store_reassignment_apply_to_existing_session(brand, admin_client):
    browser, _, member = brand
    another = admin_client.post('/api/v1/tenants', json={'name': 'Другой магазин', 'category': 'Спорт'}).json()
    assert admin_client.patch(f'/api/v1/team/{member["id"]}', json={'role': 'brand', 'tenant_id': another['id'], 'is_active': True}).status_code == 200
    assert browser.get('/api/v1/brand/context').json()['tenant_id'] == another['id']
    assert admin_client.patch(f'/api/v1/team/{member["id"]}', json={'role': 'marketer', 'is_active': True}).status_code == 200
    assert browser.get('/api/v1/brand/context').status_code == 403
    assert browser.get('/api/v1/customers').status_code == 200
