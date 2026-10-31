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

from app.core.config import ROOT, Clock, settings
from app.core.db import SessionLocal
from app.core.errors import AppError, LeaseLost
from app.main import app
from app.models import AuthSession, Campaign, Customer, Event, ImportJob, Mall, RecommendationRule, Segment, Source
from app.modules.exports.service import create_export, safe_csv
from app.modules.ingestion import service


def g001(client):
    return next(c['id'] for c in client.get('/api/v1/customers?q=G001').json()['items'] if c['global_customer_key'] == 'G001')


def test_auth_origin_expiration_and_scope(client):
    anonymous = TestClient(app)
    assert anonymous.get('/api/v1/customers').status_code == 401
    assert anonymous.get(f'/api/v1/exports/{uuid4()}/download').status_code == 401
    assert anonymous.post('/api/v1/auth/login', json={'email': settings.demo_email, 'password': 'bad'}).status_code == 403
    assert anonymous.post('/api/v1/auth/login', headers={'Origin': settings.allowed_origins.split(',')[0]}, json={'email': settings.demo_email, 'password': 'bad'}).status_code == 401
    with SessionLocal.begin() as db:
        mall = Mall(name='Another mall')
        db.add(mall); db.flush()
        other = Customer(mall_id=mall.id, identity_status='source_only')
        db.add(other); db.flush(); oid = other.id
    assert client.get(f'/api/v1/customers/{oid}').status_code == 404
    with SessionLocal.begin() as db:
        for s in db.scalars(select(AuthSession)):
            s.expires_at = Clock.now() - timedelta(seconds=1)
    assert client.get('/api/v1/auth/me').status_code == 401


def test_full_dataset_and_contract(client, dataset):
    summary = client.get('/api/v1/summary').json()
    assert (summary['customer_count'], summary['verified_customer_count'], summary['source_only_customer_count'], summary['event_count']) == (10, 8, 2, 18)
    jobs = client.get('/api/v1/imports').json()['items']
    assert sum(j['accepted_rows'] for j in jobs) == 18
    assert sum(j['duplicate_rows'] for j in jobs) == 1
    assert sum(j['rejected_rows'] for j in jobs) == 3
    for job in jobs:
        assert job['total_rows'] == job['accepted_rows'] + job['duplicate_rows'] + job['rejected_rows']
    cid = g001(client)
    profile = client.get(f'/api/v1/customers/{cid}').json()
    assert len(profile['external_identities']) == 2 and profile['event_count'] == 2
    spec = json.loads((ROOT / 'docs/spec/02_OPENAPI.json').read_text())
    registry = Registry().with_resource('urn:hryukers:openapi', Resource.from_contents(spec, default_specification=DRAFT202012))
    cases = [('/summary', 'Summary'), ('/sources', 'SourcePage'), ('/imports', 'ImportJobPage'), ('/customers', 'CustomerPage'), (f'/customers/{cid}', 'CustomerDetail'), (f'/customers/{cid}/events', 'EventPage'), (f'/customers/{cid}/recommendations', 'RecommendationResult'), ('/segments', 'SegmentPage'), ('/recommendation-rules', 'RecommendationRulePage'), ('/campaigns', 'CampaignPage')]
    for path, schema in cases:
        response = client.get('/api/v1' + path)
        assert response.status_code == 200, response.text
        Draft202012Validator({'$ref': f'urn:hryukers:openapi#/components/schemas/{schema}'}, registry=registry).validate(response.json())
    expected = {(path, method.upper()) for path, item in spec['paths'].items() for method in item}
    actual = {(r.path, method) for r in app.routes if hasattr(r, 'methods') for method in r.methods}
    assert expected <= actual


def test_segment_explanation_and_followup(client, dataset):
    ids = dataset['ids']
    page = client.get(f'/api/v1/segments/{ids["segment"]}/members').json()
    assert [page['evaluation'][f'{x}_count'] for x in ['eligible', 'ineligible', 'unknown']] == [5, 3, 2]
    cid = g001(client)
    rec = client.get(f'/api/v1/customers/{cid}/recommendations').json()
    assert len(rec['items']) == 1 and len(rec['items'][0]['observed_events']) == 2
    assert rec['items'][0]['absence_checks'][0]['coverage_complete']
    for name, accepted, duplicate, rejected in [('crm_C_after.csv', 1, 0, 0), ('crm_C_after.csv', 0, 1, 0), ('crm_C_conflict.csv', 0, 0, 1)]:
        job = client.post(f'/api/v1/sources/{ids["source_c"]}/imports', files={'file': (name, (settings.path('demo_dir') / name).read_bytes())}).json()
        service.process_job(job['id'])
        result = client.get(f'/api/v1/imports/{job["id"]}').json()
        assert [result['accepted_rows'], result['duplicate_rows'], result['rejected_rows']] == [accepted, duplicate, rejected]
    page = client.get(f'/api/v1/segments/{ids["segment"]}/members').json()
    assert [page['evaluation'][f'{x}_count'] for x in ['eligible', 'ineligible', 'unknown']] == [4, 4, 2]
    assert client.get(f'/api/v1/customers/{cid}/recommendations').json()['items'] == []
    assert client.get('/api/v1/summary').json()['event_count'] == 19


def test_export_preview_idempotency_and_csv(client, dataset):
    campaign = dataset['ids']['campaign']
    preview = client.get(f'/api/v1/campaigns/{campaign}/preview').json()
    assert preview['eligible_count'] == 1 and preview['base_count'] == 5
    assert preview['excluded_counts'] == dataset['expected_after_initial']['email_preview']['excluded_counts']
    key = str(uuid4())
    response = client.post(f'/api/v1/campaigns/{campaign}/exports', headers={'Idempotency-Key': key})
    assert response.status_code == 201, response.text
    export = response.json()
    download = client.get(export['download_url'])
    assert download.content.startswith(b'\xef\xbb\xbf') and 'g001@example.invalid' in download.text
    assert 'g005-a@example.invalid' not in download.text
    repeat = client.post(f'/api/v1/campaigns/{campaign}/exports', headers={'Idempotency-Key': key})
    assert repeat.status_code == 200 and repeat.json()['id'] == export['id']
    assert client.get(export['download_url']).content == download.content
    assert client.post(f'/api/v1/campaigns/{campaign}/exports', headers={'Idempotency-Key': str(uuid4())}).status_code == 409
    assert safe_csv('  =1+1').startswith("'") and safe_csv('+70000000001').startswith("'")


def test_export_races(client, dataset):
    campaign = UUID(dataset['ids']['campaign'])
    with SessionLocal() as db:
        mall = db.get(Campaign, campaign).mall_id
    key = uuid4()
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: create_export(campaign, mall, key), range(2)))
    assert sum(created for _, created in results) == 1
    assert len({r['id'] for r, _ in results}) == 1


def test_cross_campaign_cooldown_race(client, dataset):
    first = UUID(dataset['ids']['campaign'])
    with SessionLocal.begin() as db:
        c = db.get(Campaign, first)
        second = Campaign(mall_id=c.mall_id, name='Parallel', segment_id=c.segment_id, recommendation_rule_id=c.recommendation_rule_id, channel=c.channel)
        db.add(second); db.flush(); second_id, mall_id = second.id, c.mall_id
    def run(identifier):
        try:
            return create_export(identifier, mall_id, uuid4())[0]['recipient_count']
        except AppError as e:
            assert e.code == 'no_exportable_recipients'
            return 0
    with ThreadPoolExecutor(2) as pool:
        assert sum(pool.map(run, [first, second_id])) == 1


def test_incomplete_coverage_inactive_offers_and_boundaries(client, dataset):
    ids = dataset['ids']
    with SessionLocal.begin() as db:
        source = db.get(Source, UUID(ids['source_c']))
        original = source.coverage_from
        source.coverage_from = source.coverage_to - timedelta(days=30)
    result = client.get(f'/api/v1/segments/{ids["segment"]}/members').json()
    assert result['evaluation']['unknown_count'] == 10 and result['total'] == 0
    assert client.get(f'/api/v1/customers/{g001(client)}/recommendations').json()['empty_reason'] == 'insufficient_history'
    with SessionLocal.begin() as db:
        db.get(Source, UUID(ids['source_c'])).coverage_from = original
        rule = db.get(RecommendationRule, UUID(ids['recommendation_rule']))
        rule.valid_until = Clock.now() - timedelta(seconds=1)
    assert client.get(f'/api/v1/customers/{g001(client)}/recommendations').json()['empty_reason'] == 'no_active_offers'
    assert client.get(f'/api/v1/campaigns/{ids["campaign"]}/preview').json()['eligible_count'] == 0


def test_crashed_worker_recovery_preserves_row_results(client, monkeypatch):
    from app.modules.ingestion.dispatcher import dispatch_once
    manifest = json.loads((ROOT / 'demo/templates/demo_scenario.json').read_text())
    monkeypatch.setattr(service, 'fetch_api', lambda _: (settings.path('demo_dir') / 'api_A.json').read_bytes())
    original = service.ingest_event
    counter = 0
    def crash(*args):
        nonlocal counter
        counter += 1
        if counter == 4:
            raise KeyboardInterrupt()
        return original(*args)
    monkeypatch.setattr(service, 'ingest_event', crash)
    job = client.post(f'/api/v1/sources/{manifest["ids"]["source_a"]}/sync').json()
    with pytest.raises(KeyboardInterrupt):
        service.process_job(job['id'])
    with SessionLocal.begin() as db:
        value = db.get(ImportJob, UUID(job['id']))
        old_token = value.lease_token
        assert value.accepted_rows == 3
        value.lease_until = Clock.now() - timedelta(seconds=1)
    def unavailable_queue(*args, **kwargs):
        raise ConnectionError('Simulated transport outage')
    monkeypatch.setattr('app.modules.ingestion.dispatcher.Queue.enqueue', unavailable_queue)
    dispatch_once()
    with SessionLocal() as db:
        assert db.get(ImportJob, UUID(job['id'])).status == 'queued'
    monkeypatch.setattr(service, 'ingest_event', original)
    service.process_job(job['id'])
    final = client.get(f'/api/v1/imports/{job["id"]}').json()
    assert [final['accepted_rows'], final['duplicate_rows'], final['rejected_rows']] == [9, 1, 2]
    with SessionLocal.begin() as db:
        with pytest.raises(LeaseLost):
            service.guarded_job(db, UUID(job['id']), old_token)


def test_seed_is_idempotent(client, dataset):
    from app.seed import seed
    before = (settings.path('demo_dir') / 'crm_C_after.csv').read_bytes()
    seed()
    assert (settings.path('demo_dir') / 'crm_C_after.csv').read_bytes() == before
    assert client.get('/api/v1/summary').json()['event_count'] == 18


def test_exact_time_window_boundaries(client, dataset):
    ids = dataset['ids']
    with SessionLocal.begin() as db:
        source = db.get(Source, UUID(ids['source_a']))
        cutoff = source.coverage_to
        event = db.scalar(select(Event).where(Event.source_id == source.id, Event.external_event_id == 'A-001'))
        event.occurred_at = cutoff - timedelta(days=90)
    endpoint = f'/api/v1/segments/{ids["segment"]}/members'
    assert client.get(endpoint).json()['evaluation']['eligible_count'] == 4
    with SessionLocal.begin() as db:
        db.scalar(select(Event).where(Event.external_event_id == 'A-001')).occurred_at = cutoff
    assert client.get(endpoint).json()['evaluation']['eligible_count'] == 5
    with SessionLocal.begin() as db:
        db.scalar(select(Event).where(Event.external_event_id == 'A-001')).occurred_at = cutoff + timedelta(seconds=1)
    assert client.get(endpoint).json()['evaluation']['eligible_count'] == 4


def test_write_routes_and_consistency(client, dataset):
    definition = dataset['segment']['definition']
    created = client.post('/api/v1/segments', json={'name': 'New segment', 'definition': definition})
    assert created.status_code == 201
    sid = created.json()['id']
    assert client.put(f'/api/v1/segments/{sid}', json={'name': 'Updated segment', 'definition': definition}).status_code == 200
    rule = client.get('/api/v1/recommendation-rules').json()['items'][0]
    rule_body = {k: v for k, v in rule.items() if k != 'id'}
    rule_body['segment_id'] = sid
    created_rule = client.post('/api/v1/recommendation-rules', json=rule_body)
    assert created_rule.status_code == 201, created_rule.text
    rid = created_rule.json()['id']
    campaign = client.post('/api/v1/campaigns', json={'name': 'SMS', 'segment_id': sid, 'recommendation_rule_id': rid, 'channel': 'sms'})
    assert campaign.status_code == 201
    assert client.get(f'/api/v1/campaigns/{campaign.json()["id"]}/preview').json()['eligible_count'] == 4
    bad = {**definition, 'exclude_any': []}
    assert client.put(f'/api/v1/segments/{sid}', json={'name': 'Bad', 'definition': bad}).status_code == 409
    rule_body['segment_id'] = dataset['ids']['segment']
    assert client.put(f'/api/v1/recommendation-rules/{rid}', json=rule_body).status_code == 409
    assert client.post('/api/v1/segments', json={'name': 'Invalid', 'definition': {**definition, 'require_complete_coverage': False}}).status_code == 422


def test_duplicate_import_new_job_and_file_restrictions(client, dataset):
    sid = dataset['ids']['source_c']
    response = client.post(f'/api/v1/sources/{sid}/imports', files={'file': ('bad.xlsm', b'not a workbook')})
    assert response.status_code == 415
    response = client.post(f'/api/v1/sources/{sid}/imports', files={'file': ('crm_C_initial.csv', (settings.path('demo_dir') / 'crm_C_initial.csv').read_bytes())})
    service.process_job(response.json()['id'])
    result = client.get(f'/api/v1/imports/{response.json()["id"]}').json()
    assert result['duplicate_rows'] == 1 and result['accepted_rows'] == 0
    assert client.get('/api/v1/summary').json()['event_count'] == 18
    assert client.post('/api/v1/auth/logout').status_code == 204
    assert client.get('/api/v1/auth/me').status_code == 401
