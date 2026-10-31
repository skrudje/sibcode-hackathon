from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.config import Clock, settings
from app.core.db import SessionLocal
from app.main import app
from app.models import Campaign, Mall, RecommendationRule, Segment
from app.modules.campaigns.contracts import CampaignWizardCreate
from app.modules.campaigns.service import create_campaign
from app.modules.ingestion.service import process_job

BASE = '/api/v1/campaigns'


def counts():
    with SessionLocal() as db:
        return tuple(db.scalar(select(func.count(model.id))) for model in [Segment, RecommendationRule, Campaign])


def body_for(dataset):
    return dict(name='Кампания из мастера', channel='email', idempotency_key=str(uuid4()),
        audience={'kind': 'segment', 'segment_id': dataset['ids']['segment']},
        offer={'rule_id': dataset['ids']['recommendation_rule']})


def checked(client, body):
    response = client.post(f'{BASE}/preview', json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_previews_are_read_only_and_match_export_preview(client, dataset):
    body = body_for(dataset)
    before = counts()
    audience = client.post(f'{BASE}/audience-preview', json=body['audience'])
    assert audience.status_code == 200, audience.text
    preview = checked(client, body)
    existing = client.get(f"{BASE}/{dataset['ids']['campaign']}/preview").json()
    assert preview['base_count'] == existing['base_count'] == audience.json()['eligible_count']
    assert preview['eligible_count'] == existing['eligible_count'] > 0
    assert preview['excluded_counts'] == existing['excluded_counts']
    assert preview['sample'] == existing['sample']
    assert checked(client, body)['preview_token'] == preview['preview_token']
    assert counts() == before


def test_existing_segment_and_rule_are_reused_and_retries_are_idempotent(client, dataset):
    body = body_for(dataset)
    preview = checked(client, body)
    before = counts()
    request = {**body, 'preview_token': preview['preview_token']}
    first = client.post(f'{BASE}/prepare', json=request)
    assert first.status_code == 201, first.text
    assert first.json()['segment_id'] == dataset['ids']['segment']
    assert first.json()['recommendation_rule_id'] == dataset['ids']['recommendation_rule']
    assert counts() == (before[0], before[1], before[2] + 1)
    repeat = client.post(f'{BASE}/prepare', json=request)
    assert repeat.status_code == 200 and repeat.json() == {**first.json(), 'created': False}
    changed = client.post(f'{BASE}/prepare', json={**request, 'name': 'Другая кампания'})
    assert changed.status_code == 409 and changed.json()['error']['code'] == 'idempotency_conflict'
    actual = client.get(f"{BASE}/{first.json()['campaign_id']}/preview").json()
    assert actual['eligible_count'] == preview['eligible_count']


def test_custom_audience_and_offer_are_saved_together_without_changing_source(client, dataset):
    body = body_for(dataset)
    source = client.get(f"/api/v1/segments/{dataset['ids']['segment']}").json()
    rule = client.get('/api/v1/recommendation-rules').json()['items'][0]
    body['audience'] = {'kind': 'custom', 'definition': source['definition'], 'name': 'Моя аудитория'}
    body['offer'] = {'draft': dict(destination_tenant_id=rule['destination_tenant_id'], title='Новое предложение',
        description='Подробности', priority=65, valid_from=(Clock.now()-timedelta(days=1)).isoformat(),
        valid_until=(Clock.now()+timedelta(days=10)).isoformat())}
    before = counts()
    preview = checked(client, body)
    assert counts() == before
    response = client.post(f'{BASE}/prepare', json={**body, 'preview_token': preview['preview_token']})
    assert response.status_code == 201, response.text
    assert counts() == tuple(value+1 for value in before)
    assert client.get(f"/api/v1/segments/{source['id']}").json() == source
    with SessionLocal() as db:
        segment = db.get(Segment, UUID(response.json()['segment_id']))
        created = db.get(RecommendationRule, UUID(response.json()['recommendation_rule_id']))
        assert segment.name == 'Моя аудитория' and segment.definition == source['definition']
        assert created.offer_title == 'Новое предложение' and created.priority == 65


def test_changed_contacts_reject_stale_preview_without_partial_objects(client, dataset):
    body = body_for(dataset)
    body['audience'] = {'kind': 'custom', 'definition': client.get(f"/api/v1/segments/{dataset['ids']['segment']}").json()['definition']}
    preview = checked(client, body)
    before = counts()
    exported = client.post(f"{BASE}/{dataset['ids']['campaign']}/exports", headers={'Idempotency-Key': str(uuid4())})
    assert exported.status_code == 201, exported.text
    stale = client.post(f'{BASE}/prepare', json={**body, 'preview_token': preview['preview_token']})
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'wizard_preview_changed'
    assert counts() == before
    fresh = checked(client, body)
    assert fresh['eligible_count'] == 0
    empty = client.post(f'{BASE}/prepare', json={**body, 'preview_token': fresh['preview_token']})
    assert empty.status_code == 409 and empty.json()['error']['code'] == 'no_exportable_recipients'
    assert counts() == before


def test_parallel_creation_creates_one_campaign(client, dataset):
    body = body_for(dataset)
    preview = checked(client, body)
    request = CampaignWizardCreate(**body, preview_token=preview['preview_token'])
    with SessionLocal() as db:
        mall_id = db.get(Segment, UUID(dataset['ids']['segment'])).mall_id
    before = counts()
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(lambda _: create_campaign(mall_id, request), range(2)))
    assert sum(result['created'] for result in results) == 1
    assert len({result['campaign_id'] for result in results}) == 1
    assert counts() == (before[0], before[1], before[2]+1)


def test_scope_and_invalid_sources_are_rejected(client, dataset):
    body = body_for(dataset)
    before = counts()
    with SessionLocal.begin() as db:
        mall = Mall(name='Чужой ТЦ')
        db.add(mall); db.flush()
        original = db.get(Segment, UUID(dataset['ids']['segment']))
        foreign = Segment(mall_id=mall.id, name='Чужая аудитория', definition=original.definition)
        db.add(foreign); db.flush()
        foreign_id = str(foreign.id)
    assert client.post(f'{BASE}/audience-preview', json={'kind': 'segment', 'segment_id': foreign_id}).status_code == 404
    assert client.post(f'{BASE}/preview', json={**body, 'audience': {'kind': 'segment', 'segment_id': foreign_id}}).status_code == 404
    assert client.post(f'{BASE}/preview', json={**body, 'offer': {'rule_id': str(uuid4())}}).status_code == 404
    assert client.post(f'{BASE}/audience-preview', json={'kind': 'custom'}).status_code == 422
    assert client.post(f'{BASE}/audience-preview', json={**body['audience'], 'definition': {}}).status_code == 422
    assert client.post(f'{BASE}/preview', json={**body, 'offer': {}}).status_code == 422
    assert client.post(f'{BASE}/preview', json={**body, 'channel': 'push'}).status_code == 422
    anonymous = TestClient(app, headers={'Origin': settings.allowed_origins.split(',')[0]})
    assert anonymous.post(f'{BASE}/preview', json=body).status_code == 401
    assert counts() == (before[0]+1, before[1], before[2])


def test_radar_entry_uses_verified_definition_and_existing_offer(admin_client):
    response = admin_client.post('/api/v1/demo/radar', json={'stage': 'initial'})
    assert response.status_code == 202
    for identifier in response.json()['job_ids']:
        process_job(identifier)
    item = admin_client.get('/api/v1/radar').json()['opportunities'][0]
    body = dict(name='Радар через мастер', channel='email', idempotency_key=str(uuid4()),
        audience={'kind': 'radar', 'opportunity_id': item['id']}, offer={'rule_id': item['offers'][0]['rule_id']})
    audience = admin_client.post(f'{BASE}/audience-preview', json=body['audience'])
    assert audience.status_code == 200 and audience.json()['definition'] == item['definition']
    preview = checked(admin_client, body)
    assert preview['eligible_count'] == item['candidate_count']
    first = admin_client.post(f'{BASE}/prepare', json={**body, 'preview_token': preview['preview_token']})
    assert first.status_code == 201, first.text
    with SessionLocal() as db:
        segment = db.get(Segment, UUID(first.json()['segment_id']))
        assert segment.definition == item['definition']
