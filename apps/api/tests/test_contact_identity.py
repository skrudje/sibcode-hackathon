from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import func, select, text

from app.contracts import NormalizedEvent
from app.core.config import Clock
from app.core.contacts import normalize_contact
from app.core.db import SessionLocal, engine
from app.core.errors import AppError
from app.models import Customer, CustomerContact, Event, ExternalIdentity, Mall, Source, Tenant
from app.modules.customers.service import ingest_event
from app.modules.ingestion.service import process_job


def source_ids():
    with SessionLocal() as db:
        return {s.kind: s.id for s in db.scalars(select(Source))}


def ingest(source_id, external_customer_id, **values):
    data = NormalizedEvent(external_customer_id=external_customer_id, external_event_id=str(uuid4()),
                           event_type='visit', occurred_at=Clock.now(), **values)
    with SessionLocal.begin() as db:
        _, event_id = ingest_event(db, db.get(Source, source_id), data)
        return db.get(Event, event_id).customer_id


@pytest.mark.parametrize(('channel', 'raw', 'expected'), [
    ('email', '  USER@Example.COM  ', 'user@example.com'),
    ('email', 'not-an-email', None),
    ('email', 'user @example.com', None),
    ('email', 'a' * 320 + '@example.com', None),
    ('sms', '8 (913) 123-45-67', '+79131234567'),
    ('sms', '+7 913 123 45 67', '+79131234567'),
    ('sms', '79131234567', '+79131234567'),
    ('sms', '9131234567', '+79131234567'),
    ('sms', '0079131234567', '+79131234567'),
    ('sms', '+44 (20) 1234-5678', '+442012345678'),
    ('sms', '+09131234567', None),
    ('sms', 'телефон 89131234567', None),
    ('sms', '123', None),
])
def test_contact_normalization(channel, raw, expected):
    assert normalize_contact(channel, raw) == expected


@pytest.mark.parametrize(('first', 'second'), [
    ({'email': ' Buyer@Example.invalid '}, {'email': 'buyer@example.invalid'}),
    ({'phone': '8 (913) 123-45-67'}, {'phone': '+79131234567'}),
    ({'phone': '9131234567', 'email': 'old@example.invalid'},
     {'phone': '79131234567', 'email': 'new@example.invalid'}),
])
def test_unconnected_sources_match_without_global_key(client, first, second):
    sources = source_ids()
    first_id = ingest(sources['rest_api'], 'cinema-123', **first)
    second_id = ingest(sources['pos_xlsx'], 'cash-456', **second)
    assert first_id == second_id
    profile = client.get(f'/api/v1/customers/{first_id}').json()
    assert profile['identity_status'] == 'verified'
    assert profile['global_customer_key'].startswith('CDP-')
    assert len(profile['external_identities']) == 2 and profile['event_count'] == 2
    assert len({c['source_id'] for c in profile['contacts']}) == 2


def test_source_keys_do_not_control_identity(client):
    sources = source_ids()
    first = ingest(sources['rest_api'], '123', email='one@example.invalid', global_customer_key='local-1')
    same = ingest(sources['pos_xlsx'], '456', email='ONE@example.invalid', global_customer_key='different')
    other = ingest(sources['crm_csv'], '789', email='two@example.invalid', global_customer_key='local-1')
    assert first == same and other != first


def test_missing_invalid_contacts_and_push_do_not_merge(client):
    sources = source_ids()
    first = ingest(sources['rest_api'], '123', display_name='Одинаковое имя',
                   email='invalid', phone='123', push_token='shared', global_customer_key='same')
    second = ingest(sources['pos_xlsx'], '456', display_name='Одинаковое имя',
                    email='invalid', phone='123', push_token='shared', global_customer_key='same')
    assert first != second
    assert client.get(f'/api/v1/customers/{first}').json()['identity_status'] == 'source_only'
    assert client.get(f'/api/v1/customers/{second}').json()['identity_status'] == 'source_only'
    assert ingest(sources['rest_api'], '123') == first


def test_push_token_does_not_enter_the_contact_identity_index(client):
    sources = source_ids()
    customer = ingest(sources['rest_api'], '123', push_token='😀' * 1000)
    detail = client.get(f'/api/v1/customers/{customer}').json()
    assert detail['identity_status'] == 'source_only'
    assert detail['contacts'][0]['value'] == '😀' * 1000


def test_conflicting_contacts_are_reported_without_partial_changes(client):
    sources = source_ids()
    first = ingest(sources['rest_api'], '123', email='one@example.invalid', phone='+79131234567')
    second = ingest(sources['pos_xlsx'], '456', email='two@example.invalid', phone='+79131234568')
    content = ('customer_id,event_id,event_type,event_time,email,phone\n'
               f'789,conflict,visit,{Clock.now().isoformat()},one@example.invalid,+79131234568\n')
    job = client.post(f'/api/v1/sources/{sources["crm_csv"]}/imports',
                      files={'file': ('contacts.csv', content.encode())}).json()
    process_job(job['id'])
    result = client.get(f'/api/v1/imports/{job["id"]}').json()
    errors = client.get(f'/api/v1/imports/{job["id"]}/errors').json()
    assert result['accepted_rows'] == 0 and result['rejected_rows'] == 1
    assert errors['items'][0]['code'] == 'identity_conflict'
    assert client.get('/api/v1/summary').json()['event_count'] == 2
    with SessionLocal() as db:
        assert db.scalar(select(func.count(ExternalIdentity.id))) == 2
        assert db.scalar(select(func.count(CustomerContact.id))) == 4
    assert first != second


def test_existing_external_id_cannot_switch_to_another_identified_customer(client):
    sources = source_ids()
    first = ingest(sources['rest_api'], '123', email='one@example.invalid')
    ingest(sources['pos_xlsx'], '456', email='two@example.invalid')
    with pytest.raises(AppError, match='Контакты относятся к другому профилю'):
        ingest(sources['rest_api'], '123', email='two@example.invalid')
    assert ingest(sources['rest_api'], '123') == first


def test_ambiguous_historical_contact_does_not_silently_merge_profiles(client):
    sources = source_ids()
    with SessionLocal.begin() as db:
        for kind, external_id in [('rest_api', '123'), ('pos_xlsx', '456')]:
            source = db.get(Source, sources[kind])
            customer = Customer(mall_id=source.mall_id, identity_status='verified')
            db.add(customer)
            db.flush()
            db.add(CustomerContact(customer_id=customer.id, source_id=source.id, external_customer_id=external_id,
                                   channel='email', value='shared@example.invalid', normalized_value='shared@example.invalid'))
    with pytest.raises(AppError, match='контакт неоднозначен'):
        ingest(sources['crm_csv'], '789', email='shared@example.invalid')
    assert client.get('/api/v1/summary').json()['customer_count'] == 2
    assert client.get('/api/v1/summary').json()['event_count'] == 0


def test_unidentified_history_is_attached_when_contact_arrives(client):
    sources = source_ids()
    orphan = ingest(sources['rest_api'], '123', email='invalid')
    target = ingest(sources['pos_xlsx'], '456', phone='+79131234567')
    assert orphan != target
    assert ingest(sources['rest_api'], '123', phone='8 (913) 123-45-67') == target
    detail = client.get(f'/api/v1/customers/{target}').json()
    assert detail['event_count'] == 3 and len(detail['external_identities']) == 2
    assert detail['identity_status'] == 'verified'
    assert client.get(f'/api/v1/customers/{orphan}').status_code == 404
    assert any(c['value'] == 'invalid' for c in detail['contacts'])


def test_local_profile_becomes_eligible_for_identity_when_contact_arrives(client):
    sources = source_ids()
    customer = ingest(sources['rest_api'], '123')
    assert ingest(sources['rest_api'], '123', email='new@example.invalid') == customer
    assert client.get(f'/api/v1/customers/{customer}').json()['identity_status'] == 'verified'


def test_same_contact_in_different_malls_is_not_merged(client):
    sources = source_ids()
    first = ingest(sources['rest_api'], '123', email='one@example.invalid')
    with SessionLocal.begin() as db:
        mall = Mall(name='Другой ТЦ')
        db.add(mall)
        db.flush()
        tenant = Tenant(mall_id=mall.id, code='X', name='Магазин', category='Другое')
        db.add(tenant)
        db.flush()
        source = Source(mall_id=mall.id, tenant_id=tenant.id, name='CRM', kind='crm_csv')
        db.add(source)
        db.flush()
        other_source = source.id
    second = ingest(other_source, '456', email='one@example.invalid')
    assert first != second
    assert client.get(f'/api/v1/customers/{second}').status_code == 404


def test_concurrent_imports_reserve_the_normalized_contact(client):
    sources = source_ids()
    def run(item):
        source_id, external_id, phone = item
        return ingest(source_id, external_id, phone=phone)
    with ThreadPoolExecutor(2) as pool:
        ids = list(pool.map(run, [(sources['rest_api'], '123', '8 (913) 123-45-67'),
                                  (sources['pos_xlsx'], '456', '+79131234567')]))
    assert ids[0] == ids[1]
    assert client.get('/api/v1/summary').json()['customer_count'] == 1
    assert client.get(f'/api/v1/customers/{ids[0]}').json()['event_count'] == 2


def test_search_uses_the_same_contact_normalization(client):
    sources = source_ids()
    customer = ingest(sources['rest_api'], 'cinema-123', phone='8 (913) 123-45-67', email='BUYER@example.invalid')
    for query in ['+79131234567', '9131234567', 'buyer@example.invalid', 'cinema-123']:
        result = client.get('/api/v1/customers', params={'q': query}).json()
        assert [item['id'] for item in result['items']] == [str(customer)]


def test_duplicate_event_still_uses_immutable_content(client):
    sources = source_ids()
    data = NormalizedEvent(external_customer_id='123', external_event_id='one-event',
                           occurred_at=Clock.now(), event_type='visit', email='BUYER@example.invalid',
                           phone='8 (913) 123-45-67')
    with SessionLocal.begin() as db:
        source = db.get(Source, sources['rest_api'])
        assert ingest_event(db, source, data)[0] == 'accepted'
        same = data.model_copy(update={'email': 'buyer@example.invalid', 'phone': '+79131234567'})
        assert ingest_event(db, source, same)[0] == 'duplicate'
        with pytest.raises(AppError, match='другим содержимым'):
            ingest_event(db, source, data.model_copy(update={'email': 'changed@example.invalid'}))


@pytest.mark.parametrize('values', [{'phone': '8 (913) 123-45-67'}, {'email': 'A' * 321 + '@example.invalid'}])
def test_exact_reimport_of_legacy_contacts_keeps_event_idempotency(client, values):
    sources = source_ids()
    data = NormalizedEvent(external_customer_id='123', external_event_id='legacy-event',
                           occurred_at=Clock.now(), event_type='visit', **values)
    # The previous release retained non-international phones in the fingerprint.
    old_payload = data.model_dump(mode='json')
    if data.email:
        old_payload['email'] = data.email.lower()
    old_digest = hashlib.sha256(json.dumps(old_payload, sort_keys=True, ensure_ascii=False,
                                           separators=(',', ':')).encode()).hexdigest()
    with SessionLocal.begin() as db:
        source = db.get(Source, sources['rest_api'])
        _, event_id = ingest_event(db, source, data)
        db.get(Event, event_id).payload_hash = old_digest
        db.flush()
        assert ingest_event(db, source, data) == ('duplicate', event_id)


def test_migration_normalizes_saved_contacts_and_reclassifies_profiles(client, monkeypatch):
    sources = source_ids()
    with SessionLocal.begin() as db:
        source = db.get(Source, sources['rest_api'])
        old_verified = Customer(mall_id=source.mall_id, global_customer_key='OLD-KEY', identity_status='verified')
        old_local = Customer(mall_id=source.mall_id, identity_status='source_only')
        db.add_all([old_verified, old_local])
        db.flush()
        contact = CustomerContact(customer_id=old_local.id, source_id=source.id, external_customer_id='123',
                                  channel='sms', value='8 (913) 123-45-67', normalized_value=None)
        db.add(contact)
        db.flush()
        verified_id, local_id, contact_id = old_verified.id, old_local.id, contact.id
    # Run the real data migration in a rollback-only transaction; the test schema
    # stays at head and no other database or saved export is touched.
    from importlib.util import module_from_spec, spec_from_file_location
    from app.core.config import ROOT
    spec = spec_from_file_location('contact_migration', ROOT / 'apps/api/alembic/versions/6bc2e5a19041_contact_identity.py')
    migration = module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            connection.execute(text('DROP INDEX ix_contact_identity'))
            monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
            migration.upgrade()
            assert connection.execute(text('SELECT normalized_value FROM customer_contacts WHERE id=:id'),
                                      {'id': contact_id}).scalar_one() == '+79131234567'
            states = dict(connection.execute(text('SELECT id, identity_status FROM customers')).all())
            assert states[verified_id] == 'source_only'
            assert states[local_id] == 'verified'
        finally:
            transaction.rollback()
