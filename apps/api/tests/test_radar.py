from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4
import json

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012
from sqlalchemy import func, select

from app.core.config import ROOT, Clock
from app.core.db import SessionLocal
from app.main import app
from app.models import Campaign, Customer, Event, ImportJob, Mall, RecommendationRule, Segment, Source, User
from app.modules.ingestion.service import process_job
from app.modules.radar.contracts import RadarCampaignWrite
from app.modules.radar.service import launch


@pytest.fixture
def radar_data(client):
    response = client.post('/api/v1/demo/radar', json={'stage': 'initial'})
    assert response.status_code == 202, response.text
    for identifier in response.json()['job_ids']:
        process_job(identifier)
        job = client.get(f'/api/v1/imports/{identifier}').json()
        assert job['status'] == 'succeeded', job
    report = client.get('/api/v1/radar').json()
    assert len(report['opportunities']) == 3, report
    return report


def body_for(item):
    return dict(opportunity_id=item['id'], offer_rule_id=item['offers'][0]['rule_id'],
                name='Радар · Новые покупки', channel='email', idempotency_key=str(uuid4()))


def test_discovery_evidence_deduplication_and_contract(client, radar_data):
    report = radar_data
    assert (report['customer_count'], report['verified_customer_count'], report['unknown_customer_count']) == (102, 100, 2)
    item = report['opportunities'][0]
    assert len(item['origins']) == 2
    assert (item['population_count'], item['cohort_count'], item['shared_count'], item['destination_count'], item['candidate_count']) == (100, 40, 25, 30, 15)
    assert item['conditional_rate'] == .625 and item['baseline_rate'] == .3
    assert item['lift'] == pytest.approx(.625 / .3)
    detail = client.get(f'/api/v1/radar/opportunities/{item["id"]}?limit=5&offset=2').json()
    assert detail['total'] == 15 and len(detail['items']) == 5
    assert all(c['display_name'].startswith('Демо · Посетитель R') for c in detail['items'])
    assert len(detail['items'][0]['observed_events']) == 2
    assert len(detail['shared_examples']) == 3 and len(detail['shared_examples'][0]['observed_events']) == 3
    with SessionLocal.begin() as db:
        event = db.scalar(select(Event).where(Event.external_event_id == 'RADAR-A-001'))
        db.add(Event(mall_id=event.mall_id, customer_id=event.customer_id, tenant_id=event.tenant_id, source_id=event.source_id,
            external_event_id='another-transaction-same-client', event_type='visit', occurred_at=event.occurred_at, payload_hash='d'*64))
    assert client.get('/api/v1/radar').json()['opportunities'][0]['shared_count'] == 25
    spec = json.loads((ROOT / 'docs/api/openapi.json').read_text())
    registry = Registry().with_resource('urn:radar:api', Resource.from_contents(spec, default_specification=DRAFT202012))
    for data, schema in [(report, 'RadarReport'), (detail, 'RadarAudience')]:
        Draft202012Validator({'$ref': f'urn:radar:api#/components/schemas/{schema}'}, registry=registry).validate(data)
    assert client.get('/api/v1/radar?min_shared_customers=31').json()['opportunities'] == []
    assert client.get('/api/v1/radar?min_lift=3').json()['opportunities'] == []


def test_campaign_atomicity_idempotency_preview_and_followup(client, radar_data):
    item = radar_data['opportunities'][0]
    body = body_for(item)
    first = client.post('/api/v1/radar/campaigns', json=body)
    assert first.status_code == 201, first.text
    result = first.json()
    repeat = client.post('/api/v1/radar/campaigns', json=body)
    assert repeat.status_code == 200 and repeat.json() == {**result, 'created': False}
    assert client.post('/api/v1/radar/campaigns', json={**body, 'name': 'Другой замысел'}).status_code == 409
    preview = client.get(f'/api/v1/campaigns/{result["campaign_id"]}/preview').json()
    assert preview['base_count'] == preview['eligible_count'] == 15
    export = client.post(f'/api/v1/campaigns/{result["campaign_id"]}/exports', headers={'Idempotency-Key': str(uuid4())})
    assert export.status_code == 201
    assert 'radar-r026@example.invalid' in client.get(export.json()['download_url']).text
    followup = client.post('/api/v1/demo/radar', json={'stage': 'followup'})
    assert followup.status_code == 202
    for identifier in followup.json()['job_ids']:
        process_job(identifier)
    detail = client.get(f'/api/v1/radar/opportunities/{item["id"]}').json()
    assert detail['total'] == 14
    assert all('R026' not in c['display_name'] for c in detail['items'])
    members = client.get(f'/api/v1/segments/{result["segment_id"]}/members').json()
    assert members['total'] == 14 and members['evaluation']['unknown_count'] == 2
    assert client.post('/api/v1/radar/campaigns', json=body).json()['campaign_id'] == result['campaign_id']


def test_parallel_launch_creates_one_set(client, radar_data):
    body = RadarCampaignWrite(**body_for(radar_data['opportunities'][0]))
    with SessionLocal() as db:
        mall_id = db.scalar(select(User.mall_id))
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: launch(mall_id, body), range(2)))
    assert sum(result['created'] for result in results) == 1
    assert len({result['campaign_id'] for result in results}) == 1
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Campaign.id))) == 2
        assert db.scalar(select(func.count(Segment.id))) == 2
        assert db.scalar(select(func.count(RecommendationRule.id))) == 2


def test_coverage_offer_and_stale_selection(client, radar_data):
    item = radar_data['opportunities'][0]
    body = body_for(item)
    ids = json.loads((ROOT / 'apps/api/fixtures/demo_scenario.json').read_text())['ids']
    with SessionLocal() as db:
        original = db.get(Source, UUID(ids['source_c'])).coverage_from
    assert client.patch(f'/api/v1/sources/{ids["source_c"]}/coverage', json={'coverage_from': (Clock.now()-timedelta(days=30)).isoformat()}).status_code == 200
    report = client.get('/api/v1/radar').json()
    assert report['opportunities'] == []
    assert next(n for n in report['nodes'] if n['code'] == 'C')['coverage_status'] == 'incomplete_history'
    assert client.get(f'/api/v1/radar/opportunities/{item["id"]}').status_code == 404
    assert client.post('/api/v1/radar/campaigns', json=body).status_code == 409
    assert client.patch(f'/api/v1/sources/{ids["source_c"]}/coverage', json={'coverage_from': original.isoformat()}).status_code == 200
    assert client.get('/api/v1/radar').json()['opportunities'][0]['candidate_count'] == 15
    with SessionLocal.begin() as db:
        db.get(RecommendationRule, UUID(body['offer_rule_id'])).valid_until = Clock.now()-timedelta(seconds=1)
    assert client.get('/api/v1/radar').json()['opportunities'][0]['offers'] == []
    assert client.post('/api/v1/radar/campaigns', json=body).status_code == 409
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Campaign.id))) == 1
        assert db.scalar(select(func.count(Segment.id))) == 1


def test_other_mall_scope_and_demo_isolation(client, radar_data):
    item = radar_data['opportunities'][0]
    with SessionLocal.begin() as db:
        mall = Mall(name='Чужой ТЦ')
        db.add(mall); db.flush()
        db.add(Customer(mall_id=mall.id, global_customer_key='R026', identity_status='verified'))
        db.scalar(select(User).where(User.role == 'admin')).mall_id = mall.id
    report = client.get('/api/v1/radar').json()
    assert report['customer_count'] == 1 and report['nodes'] == [] and report['opportunities'] == []
    assert client.get(f'/api/v1/radar/opportunities/{item["id"]}').status_code == 404
    assert client.post('/api/v1/radar/campaigns', json=body_for(item)).status_code == 409
    assert client.post('/api/v1/demo/radar', json={'stage': 'initial'}).status_code == 404
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Campaign.id))) == 1
        assert db.scalar(select(func.count(ImportJob.id))) == 3


@pytest.mark.parametrize('query', ['lookback_days=0', 'lookback_days=366', 'min_shared_customers=1', 'min_lift=1', 'min_lift=nan', 'min_lift=inf', 'lookback_days=hello'])
def test_invalid_filters(client, query):
    assert client.get('/api/v1/radar?' + query).status_code == 422


def test_auth_empty_and_invalid_launch(client):
    anonymous = TestClient(app)
    assert anonymous.get('/api/v1/radar').status_code == 401
    assert client.get('/api/v1/radar').json()['empty_reason'] == 'no_data'
    assert client.post('/api/v1/radar/campaigns', json={}).status_code == 422
    assert client.post('/api/v1/demo/radar', json={'stage': 'delete'}).status_code == 422
    assert anonymous.post('/api/v1/demo/radar', json={'stage': 'initial'}).status_code == 403


def test_original_small_sample_is_not_a_discovery(client, dataset):
    report = client.get('/api/v1/radar').json()
    assert report['opportunities'] == []
    assert report['empty_reason'] == 'insufficient_support'


def test_watermark_matches_dynamic_segment_and_excludes_later_events(client, radar_data):
    item = radar_data['opportunities'][0]
    result = client.post('/api/v1/radar/campaigns', json=body_for(item)).json()
    with SessionLocal.begin() as db:
        sources = db.scalars(select(Source)).all()
        original = min(s.coverage_to for s in sources)
        Clock.frozen = original + timedelta(minutes=10)
        customer = db.scalar(select(Customer).where(Customer.display_name == 'Демо · Посетитель R026'))
        destination = next(s for s in sources if str(s.tenant_id) == item['destination']['tenant_id'])
        db.add(Event(mall_id=customer.mall_id, customer_id=customer.id, tenant_id=destination.tenant_id, source_id=destination.id,
            external_event_id='later-than-declared-coverage', event_type='purchase', amount=100, currency='RUB',
            occurred_at=original+timedelta(minutes=1), payload_hash='e'*64))
    assert client.get(f'/api/v1/radar/opportunities/{item["id"]}').json()['total'] == 15
    assert client.get(f'/api/v1/segments/{result["segment_id"]}/members').json()['total'] == 15
    with SessionLocal.begin() as db:
        for source in db.scalars(select(Source)):
            source.coverage_to = original+timedelta(minutes=2)
    assert client.get(f'/api/v1/radar/opportunities/{item["id"]}').json()['total'] == 14
    assert client.get(f'/api/v1/segments/{result["segment_id"]}/members').json()['total'] == 14


def test_missing_offer_does_not_leave_partial_campaign(client, radar_data):
    body = {**body_for(radar_data['opportunities'][0]), 'offer_rule_id': str(uuid4())}
    assert client.post('/api/v1/radar/campaigns', json=body).status_code == 404
    with SessionLocal() as db:
        assert db.scalar(select(func.count(Campaign.id))) == 1
        assert db.scalar(select(func.count(Segment.id))) == 1


@pytest.fixture
def client(admin_client):
    return admin_client
