import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from openapi_spec_validator import validate
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

from app.core.config import ROOT, Clock, settings
from app.core.db import SessionLocal
from app.main import app
from app.models import Mall, Source, Tenant


def source(client, code='C'):
    tenants = client.get('/api/v1/tenants').json()['items']
    tenant_id = next(t['id'] for t in tenants if t['code'] == code)
    return next(s for s in client.get('/api/v1/sources').json()['items'] if s['tenant_id'] == tenant_id)


def endpoint(item):
    return f'/api/v1/sources/{item["id"]}/coverage'


def contract(schema, value):
    spec = json.loads((ROOT / 'docs/api/openapi.json').read_text())
    registry = Registry().with_resource('urn:coverage:openapi', Resource.from_contents(spec, default_specification=DRAFT202012))
    Draft202012Validator({'$ref': f'urn:coverage:openapi#/components/schemas/{schema}'}, registry=registry).validate(value)


def test_patch_persists_utc_dates_and_preserves_unsupplied_fields(client):
    original = source(client)
    start = datetime.fromisoformat(original['coverage_from'].replace('Z', '+00:00')) - timedelta(days=1)
    end = datetime.fromisoformat(original['coverage_to'].replace('Z', '+00:00'))
    krasnoyarsk = timezone(timedelta(hours=7))
    payload = {'coverage_from': start.astimezone(krasnoyarsk).isoformat(), 'coverage_to': end.astimezone(krasnoyarsk).isoformat()}
    response = client.patch(endpoint(original), json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    contract('Source', result)
    assert result['coverage_from'] == start.isoformat().replace('+00:00', 'Z')
    assert result['coverage_to'] == original['coverage_to']
    for key in ['id', 'tenant_id', 'name', 'kind', 'covered_event_types', 'last_success_at']:
        assert result[key] == original[key]
    # A new session confirms this is a committed update, not an in-memory response.
    with SessionLocal() as db:
        saved = db.get(Source, UUID(original['id']))
        assert (saved.coverage_from, saved.coverage_to) == (start, end)
    assert source(client) == result


def test_partial_patch_validates_against_saved_dates(client):
    original = source(client)
    end = datetime.fromisoformat(original['coverage_to'].replace('Z', '+00:00'))
    new_start = (end - timedelta(days=30)).isoformat()
    result = client.patch(endpoint(original), json={'coverage_from': new_start})
    assert result.status_code == 200
    assert result.json()['coverage_to'] == original['coverage_to']
    result = client.patch(endpoint(original), json={'covered_event_types': ['purchase', 'booking']})
    assert result.status_code == 200
    assert result.json()['coverage_from'] == new_start.replace('+00:00', 'Z')
    assert result.json()['covered_event_types'] == ['purchase', 'booking']


@pytest.mark.parametrize('payload', [
    {},
    {'coverage_from': 'not-a-date'},
    {'coverage_to': '2026-01-01T12:00:00'},
    {'coverage_from': '2026-01-01'},
    {'coverage_to': 1770000000},
    {'coverage_to': True},
    {'coverage_from': None},
    {'coverage_to': None},
    {'covered_event_types': None},
    {'covered_event_types': ['purchase', 'purchase']},
    {'covered_event_types': ['PURCHASE']},
    {'covered_event_types': ['unknown']},
    {'covered_event_types': 'purchase'},
    {'covered_event_types': ['visit', 'purchase', 'booking', 'visit']},
    {'kind': 'rest_api'},
    {'mall_id': '00000000-0000-0000-0000-000000000001'},
    {'coverage_from': '2026-02-02T00:00:00Z', 'coverage_to': '2026-02-01T00:00:00Z'},
    {'coverage_from': '2026-02-01T00:00:00Z', 'coverage_to': '2026-02-01T00:00:00Z'},
])
def test_invalid_patch_does_not_change_source(client, payload):
    original = source(client)
    response = client.patch(endpoint(original), json=payload)
    assert response.status_code == 422, response.text
    contract('ApiError', response.json())
    assert source(client) == original


def test_future_period_and_invalid_effective_pair_are_atomic(client):
    original = source(client)
    future = (Clock.now() + timedelta(days=1)).isoformat()
    for payload in [
        {'coverage_to': future, 'covered_event_types': []},
        {'coverage_from': original['coverage_to']},
        {'coverage_to': original['coverage_from']},
    ]:
        response = client.patch(endpoint(original), json=payload)
        assert response.status_code == 422
        assert response.json()['error']['code'] == 'invalid_coverage'
        assert source(client) == original


def test_clear_unknown_period_then_set_both_dates(client):
    original = source(client)
    response = client.patch(endpoint(original), json={'coverage_from': None, 'coverage_to': None})
    assert response.status_code == 200
    assert response.json()['coverage_from'] is response.json()['coverage_to'] is None
    assert response.json()['covered_event_types'] == original['covered_event_types']
    # One bound cannot be supplied while the other remains unknown.
    assert client.patch(endpoint(original), json={'coverage_from': original['coverage_from']}).status_code == 422
    response = client.patch(endpoint(original), json={key: original[key] for key in ['coverage_from', 'coverage_to']})
    assert response.status_code == 200
    assert response.json() == original


def test_foreign_and_unknown_source_are_not_disclosed_or_changed(client):
    with SessionLocal.begin() as db:
        mall = Mall(name='Другой ТЦ')
        db.add(mall); db.flush()
        tenant = Tenant(mall_id=mall.id, code='X', name='Чужой магазин', category='Книги')
        db.add(tenant); db.flush()
        foreign = Source(mall_id=mall.id, tenant_id=tenant.id, name='Чужая CRM', kind='crm_csv', covered_event_types=['purchase'])
        db.add(foreign); db.flush(); foreign_id = foreign.id
    for identifier in [foreign_id, uuid4()]:
        response = client.patch(f'/api/v1/sources/{identifier}/coverage', json={'covered_event_types': []})
        assert response.status_code == 404
        assert response.json()['error']['code'] == 'not_found'
    with SessionLocal() as db:
        assert db.get(Source, foreign_id).covered_event_types == ['purchase']


def test_patch_requires_session_and_trusted_origin(client):
    original = source(client)
    with TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]}) as anonymous:
        assert anonymous.patch(endpoint(original), json={'covered_event_types': []}).status_code == 401
    assert client.patch(endpoint(original), json={'covered_event_types': []}, headers={'Origin': 'https://untrusted.invalid'}).status_code == 403
    assert source(client) == original


def test_coverage_change_recalculates_segment_and_recommendation_without_changing_events(client, dataset):
    ids = dataset['ids']
    original = source(client)
    members = f'/api/v1/segments/{ids["segment"]}/members'
    customer = client.get('/api/v1/customers?q=g001@example.invalid').json()['items'][0]
    recommendations = f'/api/v1/customers/{customer["id"]}/recommendations'
    assert client.get(members).json()['evaluation']['eligible_count'] == 5
    assert len(client.get(recommendations).json()['items']) == 1
    end = datetime.fromisoformat(original['coverage_to'].replace('Z', '+00:00'))

    # Insufficient time range must not be interpreted as an absence of purchases.
    response = client.patch(endpoint(original), json={'coverage_from': (end - timedelta(days=30)).isoformat()})
    assert response.status_code == 200
    evaluation = client.get(members).json()['evaluation']
    assert (evaluation['eligible_count'], evaluation['unknown_count']) == (0, 10)
    assert client.get(recommendations).json()['empty_reason'] == 'insufficient_history'

    assert client.patch(endpoint(original), json={'coverage_from': original['coverage_from']}).status_code == 200
    assert client.get(members).json()['evaluation']['eligible_count'] == 5
    # A declared period alone is insufficient if purchase events are not covered.
    assert client.patch(endpoint(original), json={'covered_event_types': []}).status_code == 200
    assert client.get(members).json()['evaluation']['unknown_count'] == 10
    assert client.get(recommendations).json()['items'] == []
    assert client.patch(endpoint(original), json={'covered_event_types': original['covered_event_types']}).status_code == 200
    assert client.get(members).json()['evaluation']['eligible_count'] == 5
    assert len(client.get(recommendations).json()['items']) == 1
    assert client.get('/api/v1/summary').json()['event_count'] == 18


def test_coverage_api_contract():
    spec = json.loads((ROOT / 'docs/api/openapi.json').read_text())
    validate(spec)
    assert spec['paths']['/api/v1/sources/{source_id}/coverage']['patch']['operationId'] == 'updateSourceCoverage'
    contract('SourceCoveragePatch', {'covered_event_types': []})
    contract('SourceCoveragePatch', {'coverage_from': None, 'coverage_to': None})


@pytest.fixture
def client(admin_client):
    return admin_client
