import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from pydantic import ValidationError
from redis import RedisError
from sqlalchemy import delete, func, select

from app.core import security
from app.core.config import Clock, Settings, settings
from app.core.db import SessionLocal
from app.core.errors import AppError
from app.main import app
from app.models import AuthSession, ImportJob, Source, User
from app.modules.brand.service import read_table
from app.modules.ingestion.adapters import read_rows
from app.modules.ingestion.service import process_job
from app.modules.ingestion.storage import cleanup_import_files, create_file_import
from app.modules.integrations import service as integrations


def workbook(entity=False, row=2, column=3):
    output = io.BytesIO()
    book = Workbook()
    book.active.append(['phone', 'email', 'time'])
    book.active.append(['', 'audit@example.invalid', (Clock.now() - timedelta(days=1)).isoformat()])
    book.active.cell(row=row, column=column, value='value')
    book.save(output)
    if not entity:
        return output.getvalue()
    result = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(output.getvalue())) as original, zipfile.ZipFile(result, 'w') as destination:
        for info in original.infolist():
            content = original.read(info.filename)
            if info.filename == 'xl/workbook.xml':
                content = b'<!DOCTYPE workbook [<!ENTITY audit "ENTITY">]>' + content.replace(b'name="Sheet"', b'name="&audit;"')
            destination.writestr(info.filename, content)
    return result.getvalue()


def source_info(client):
    row = next(row for row in client.get('/api/v1/sources').json()['items'] if row['kind'] != 'rest_api')
    with SessionLocal.begin() as db:
        source = db.get(Source, UUID(row['id']))
        source.kind, source.covered_event_types = 'contacts', ['interaction']
    return {**row, 'kind': 'contacts'}


def csv_data():
    return f'phone,email,time\n,audit@example.invalid,{(Clock.now() - timedelta(days=1)).isoformat()}\n'.encode()


@pytest.mark.parametrize('change', [
    {'seed_demo_accounts': True}, {'seed_workspace_data': True}, {'cookie_secure': False},
    {'admin_password': 'HryukersAdmin2026!'}, {'allowed_origins': 'http://example.invalid'},
    {'database_url': 'postgresql+psycopg://user:hryukers-local-db@db/app'},
])
def test_production_rejects_insecure_configuration(change):
    values = dict(deployment_mode='production', seed_demo_accounts=False, seed_workspace_data=False,
        cookie_secure=True, admin_password='OwnStrongPassword2026!', allowed_origins='https://nexa.example.invalid',
        database_url='postgresql+psycopg://user:own-strong-db-password@db/app')
    assert Settings(_env_file=None, **values).deployment_mode == 'production'
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{**values, **change})


def test_public_accounts_require_explicit_opt_in(monkeypatch):
    from app.seed import seed
    with SessionLocal.begin() as db:
        db.execute(delete(User))
    monkeypatch.setattr(settings, 'seed_demo_accounts', False)
    monkeypatch.setattr(settings, 'admin_password', 'HryukersAdmin2026!')
    seed()
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 0
    monkeypatch.setattr(settings, 'admin_password', 'OwnStrongPassword2026!')
    seed()
    with SessionLocal() as db:
        assert [user.role for user in db.scalars(select(User))] == ['admin']


def test_production_rejects_existing_accounts_with_public_passwords(monkeypatch):
    from app.seed import seed
    monkeypatch.setattr(settings, 'deployment_mode', 'production')
    monkeypatch.setattr(settings, 'seed_demo_accounts', False)
    monkeypatch.setattr(settings, 'admin_password', 'OwnStrongPassword2026!')
    with pytest.raises(RuntimeError, match='сохранённые пароли'):
        seed()


def test_connector_credentials_are_bound_to_mall_tenant_and_origin(monkeypatch):
    source = SimpleNamespace(mall_id=uuid4(), tenant_id=uuid4())
    name = 'CONNECTOR_SECRET_SECURITY_TEST'
    monkeypatch.setenv(name, 'synthetic-security-test-token')
    monkeypatch.setattr(settings, 'connector_allowed_hosts', 'one.example.invalid,two.example.invalid')
    monkeypatch.setattr(settings, 'connector_secret_bindings', {name: {
        'mall_id': str(source.mall_id), 'tenant_id': str(source.tenant_id), 'origin': 'https://one.example.invalid'}})
    value = {'api_url': 'https://one.example.invalid/records', 'credential_env': name}
    captured = []
    original = httpx.Client
    def handler(request):
        captured.append((request.url.host, request.headers['Authorization']))
        return httpx.Response(200, json={'records': []})
    monkeypatch.setattr(integrations.httpx, 'Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    assert integrations.read_page(value, source=source)['records'] == []
    assert captured == [('one.example.invalid', 'Bearer synthetic-security-test-token')]
    for identity, request in [
        (SimpleNamespace(mall_id=uuid4(), tenant_id=source.tenant_id), value),
        (SimpleNamespace(mall_id=source.mall_id, tenant_id=uuid4()), value),
        (source, {**value, 'api_url': 'https://two.example.invalid/records'}),
        (source, {**value, 'api_url': 'https://one.example.invalid:8443/records'}),
    ]:
        with pytest.raises(AppError) as error:
            integrations.read_page(request, source=identity)
        assert error.value.code == 'credential_not_allowed'
    with pytest.raises(AppError):
        integrations.read_page(value)
    assert len(captured) == 1


def test_login_throttles_unknown_accounts_and_sends_retry_after():
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as browser:
        responses = [browser.post('/api/v1/auth/login', json={'email': 'unknown@example.invalid', 'password': 'wrong'}) for _ in range(9)]
    assert [response.status_code for response in responses] == [401] * 8 + [429]
    assert int(responses[-1].headers['Retry-After']) > 0
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(AuthSession)) == 0


def test_successful_login_clears_account_failures():
    key = None
    for _ in range(7):
        key = security.request_limit('login-account', settings.demo_email, 8, 900)
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as browser:
        assert browser.post('/api/v1/auth/login', json={'email': settings.demo_email, 'password': settings.demo_password}).status_code == 200
    assert security.limiter().get(key) is None


def test_login_fails_closed_when_rate_limit_storage_is_unavailable(monkeypatch):
    class Unavailable:
        def eval(self, *args):
            raise RedisError('offline')
    monkeypatch.setattr(security, 'limiter', lambda: Unavailable())
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as browser:
        response = browser.post('/api/v1/auth/login', json={'email': settings.demo_email, 'password': settings.demo_password})
    assert response.status_code == 503


@pytest.mark.parametrize('body', [
    {'email': 'x' * 321, 'password': 'wrong'},
    {'email': 'audit@example.invalid', 'password': 'x' * 257},
])
def test_login_rejects_oversized_fields(body):
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as browser:
        assert browser.post('/api/v1/auth/login', json=body).status_code == 422


@pytest.mark.parametrize('variant,expected', [('entity', 'unsafe_spreadsheet'), ('columns', 'invalid_file_schema'), ('rows', 'too_many_rows')])
def test_all_xlsx_entry_points_reject_unsafe_content(tmp_path, variant, expected):
    data = workbook(entity=variant == 'entity', row=10002 if variant == 'rows' else 2,
                    column=201 if variant == 'columns' else 3)
    path = tmp_path / 'unsafe.xlsx'; path.write_bytes(data)
    for operation in [lambda: read_table('unsafe.xlsx', data), lambda: read_rows('contacts', path)]:
        with pytest.raises(AppError) as error:
            operation()
        assert error.value.code == expected


def test_xlsx_archive_limits_apply_to_both_entry_points(tmp_path, monkeypatch):
    from app.core import spreadsheets
    data = workbook()
    monkeypatch.setattr(spreadsheets, 'MAX_UNPACKED_BYTES', 100)
    path = tmp_path / 'large.xlsx'; path.write_bytes(data)
    for operation in [lambda: read_table('large.xlsx', data), lambda: read_rows('contacts', path)]:
        with pytest.raises(AppError) as error:
            operation()
        assert error.value.status == 413


def test_upload_queue_limits_are_atomic(client, monkeypatch):
    source = source_info(client)
    monkeypatch.setattr(settings, 'max_active_imports_per_source', 1)
    def submit(_):
        with SessionLocal() as db:
            try:
                return create_file_import(db, db.get(Source, UUID(source['id'])), csv_data(), '.csv').id
            except AppError as error:
                assert error.code == 'import_queue_full'
                return None
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(submit, range(2)))
    assert sum(item is not None for item in results) == 1
    assert len(list(settings.path('upload_dir').glob('*'))) == 1


def test_upload_queue_limit_is_visible_through_api(client, monkeypatch):
    source = source_info(client)
    monkeypatch.setattr(settings, 'max_active_imports_per_source', 1)
    url = f'/api/v1/sources/{source["id"]}/imports'
    first = client.post(url, files={'file': ('contacts.csv', csv_data())})
    assert first.status_code == 202
    assert client.post(url, files={'file': ('contacts.csv', csv_data())}).status_code == 429
    process_job(first.json()['id'])
    assert client.post(url, files={'file': ('contacts.csv', csv_data())}).status_code == 202


def test_upload_storage_budget_prevents_file_creation(client, monkeypatch):
    source = source_info(client)
    monkeypatch.setattr(settings, 'max_upload_bytes_per_mall', 1)
    response = client.post(f'/api/v1/sources/{source["id"]}/imports', files={'file': ('contacts.csv', csv_data())})
    assert response.status_code == 429
    assert not list(settings.path('upload_dir').glob('*'))
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(ImportJob)) == 0


def test_retention_preserves_active_jobs_and_external_files(client, tmp_path):
    source = source_info(client)
    directory = settings.path('upload_dir'); directory.mkdir(parents=True, exist_ok=True)
    paths = [directory / 'finished.csv', directory / 'active.csv', tmp_path / 'external.csv']
    for path in paths:
        path.write_bytes(b'private input')
    with SessionLocal.begin() as db:
        for path, status in zip(paths, ['succeeded', 'running', 'failed']):
            db.add(ImportJob(source_id=UUID(source['id']), status=status, file_path=str(path), finished_at=Clock.now() - timedelta(days=2)))
    cleanup_import_files()
    assert not paths[0].exists()
    assert paths[1].exists() and paths[2].exists()
    with SessionLocal() as db:
        assert db.scalar(select(ImportJob).where(ImportJob.status == 'succeeded')).file_path is None
