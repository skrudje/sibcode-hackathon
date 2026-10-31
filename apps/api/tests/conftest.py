import os
from pathlib import Path

import psycopg
from psycopg import sql

TEST_URL = os.environ.get('TEST_DATABASE_URL', 'postgresql+psycopg://hryukers:hryukers-local-db@localhost:55432/hryukers_test')
if not TEST_URL.rsplit('/', 1)[-1].endswith('_test'):
    raise RuntimeError('Tests require a separate database ending in _test')
os.environ['DATABASE_URL'] = TEST_URL
os.environ['SEED_WORKSPACE_DATA'] = 'false'

from sqlalchemy.engine import make_url
from alembic import command
from alembic.config import Config
import pytest
from fastapi.testclient import TestClient

from app.core.config import ROOT, Clock, settings
from app.core.db import Base, SessionLocal, engine
from app.main import app
from app.seed import seed

url = make_url(TEST_URL)
with psycopg.connect(host=url.host, port=url.port, user=url.username, password=url.password, dbname='postgres', autocommit=True) as connection:
    if not connection.execute('SELECT 1 FROM pg_database WHERE datname=%s', (url.database,)).fetchone():
        connection.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(url.database)))
command.upgrade(Config(str(ROOT / 'apps/api/alembic.ini')), 'head')


@pytest.fixture(autouse=True)
def isolated(tmp_path):
    from sqlalchemy import text
    with engine.begin() as db:
        names = ', '.join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
        db.execute(text(f'TRUNCATE {names} CASCADE'))
    settings.demo_dir, settings.upload_dir = str(tmp_path / 'demo'), str(tmp_path / 'uploads')
    Clock.frozen = None
    seed()
    yield
    Clock.frozen = None


@pytest.fixture
def client():
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as c:
        response = c.post('/api/v1/auth/login', json={'email': settings.demo_email, 'password': settings.demo_password})
        assert response.status_code == 200
        yield c


@pytest.fixture
def admin_client():
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as c:
        response = c.post('/api/v1/auth/login', json={'email': settings.admin_email, 'password': settings.admin_password})
        assert response.status_code == 200
        yield c


@pytest.fixture
def dataset(client, monkeypatch):
    from app.modules.ingestion import service
    from app.models import Source
    import json
    manifest = json.loads((ROOT / 'apps/api/fixtures/demo_scenario.json').read_text())
    monkeypatch.setattr(service, 'fetch_api', lambda source_id: (settings.path('demo_dir') / 'api_A.json').read_bytes())
    ids = manifest['ids']
    for code in ['a', 'b', 'c']:
        source_id = ids[f'source_{code}']
        if code == 'a':
            response = client.post(f'/api/v1/sources/{source_id}/sync')
        else:
            name = 'pos_B.xlsx' if code == 'b' else 'crm_C_initial.csv'
            response = client.post(f'/api/v1/sources/{source_id}/imports', files={'file': (name, (settings.path('demo_dir') / name).read_bytes())})
        assert response.status_code == 202, response.text
        service.process_job(response.json()['id'])
    return manifest
