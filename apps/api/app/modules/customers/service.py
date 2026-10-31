import hashlib
import json
import re
from decimal import Decimal

from sqlalchemy import select

from app.contracts import NormalizedEvent
from app.core.db import lock
from app.core.errors import AppError
from app.models import Customer, CustomerContact, Event, ExternalIdentity, Source


def normalize_contact(channel, value):
    if not value:
        return None
    value = value.strip()
    if channel == 'email':
        return value.lower() if re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value) else None
    if channel == 'sms':
        value = re.sub(r'[\s()\-]', '', value)
        return value if re.fullmatch(r'\+\d{8,15}', value) else None
    return value or None


def resolve_customer(db, source: Source, data: NormalizedEvent):
    keys = [f'identity:{source.id}:{data.external_customer_id}']
    if data.global_customer_key:
        keys.append(f'customer:{source.mall_id}:{data.global_customer_key}')
    for key in sorted(keys):
        lock(db, key)
    external = db.scalar(select(ExternalIdentity).where(ExternalIdentity.source_id == source.id, ExternalIdentity.external_customer_id == data.external_customer_id))
    global_profile = db.scalar(select(Customer).where(Customer.mall_id == source.mall_id, Customer.global_customer_key == data.global_customer_key)) if data.global_customer_key else None
    if external:
        customer = db.get(Customer, external.customer_id)
        if data.global_customer_key and customer.global_customer_key != data.global_customer_key:
            if customer.global_customer_key or (global_profile and global_profile.id != customer.id):
                raise AppError('identity_conflict', 'Внешний ID связан с другим единым ключом')
            customer.global_customer_key = data.global_customer_key
            customer.identity_status = 'verified'
    else:
        customer = global_profile
        if not customer:
            customer = Customer(mall_id=source.mall_id, global_customer_key=data.global_customer_key, display_name=data.display_name, identity_status='verified' if data.global_customer_key else 'source_only')
            db.add(customer)
            db.flush()
        db.add(ExternalIdentity(source_id=source.id, external_customer_id=data.external_customer_id, customer_id=customer.id))
    return customer


def ingest_event(db, source, data: NormalizedEvent):
    canonical = data.model_dump(mode='json')
    if data.amount is not None:
        canonical['amount'] = f'{data.amount.quantize(Decimal("0.01")):.2f}'
    for field, channel in [('email', 'email'), ('phone', 'sms'), ('push_token', 'push')]:
        canonical[field] = normalize_contact(channel, getattr(data, field)) or getattr(data, field)
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    lock(db, f'event:{source.id}:{data.external_event_id}')
    existing = db.scalar(select(Event).where(Event.source_id == source.id, Event.external_event_id == data.external_event_id))
    if existing:
        if existing.payload_hash != digest:
            raise AppError('event_conflict', 'ID события уже существует с другим содержимым')
        return 'duplicate', existing.id
    customer = resolve_customer(db, source, data)
    for channel, value in [('email', data.email), ('sms', data.phone), ('push', data.push_token)]:
        if value and not db.scalar(select(CustomerContact.id).where(CustomerContact.customer_id == customer.id, CustomerContact.source_id == source.id, CustomerContact.external_customer_id == data.external_customer_id, CustomerContact.channel == channel, CustomerContact.value == value)):
            db.add(CustomerContact(customer_id=customer.id, source_id=source.id, external_customer_id=data.external_customer_id, channel=channel, value=value, normalized_value=normalize_contact(channel, value)))
    event = Event(mall_id=source.mall_id, tenant_id=source.tenant_id, source_id=source.id, customer_id=customer.id, external_event_id=data.external_event_id, event_type=data.event_type, occurred_at=data.occurred_at, amount=data.amount, currency=data.currency, payload_hash=digest, metadata_json=data.metadata)
    db.add(event)
    db.flush()
    return 'accepted', event.id
