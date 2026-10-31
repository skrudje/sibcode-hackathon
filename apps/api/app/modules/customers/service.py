import hashlib
import json
import re
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import and_, or_, select, update

from app.contracts import NormalizedEvent
from app.core.contacts import normalize_contact
from app.core.db import lock
from app.core.errors import AppError
from app.models import CampaignRecipient, Customer, CustomerContact, Event, ExternalIdentity, Source


def has_identity_contact(db, customer_id):
    return db.scalar(select(CustomerContact.id).where(
        CustomerContact.customer_id == customer_id,
        CustomerContact.channel.in_(['email', 'sms']),
        CustomerContact.normalized_value.is_not(None),
    ).limit(1)) is not None


def attach_unidentified_profile(db, customer, target):
    # A local profile with no usable email/phone may acquire a contact later.
    # Preserve its history and provenance when that contact identifies a profile.
    if not target.display_name:
        target.display_name = customer.display_name
    target.created_at = min(customer.created_at, target.created_at)
    for model in [Event, ExternalIdentity, CustomerContact, CampaignRecipient]:
        db.execute(update(model).where(model.customer_id == customer.id).values(customer_id=target.id))
    db.delete(customer)
    db.flush()
    return target


def resolve_customer(db, source: Source, data: NormalizedEvent):
    contacts = [(channel, value) for channel, raw in [('email', data.email), ('sms', data.phone)]
                if (value := normalize_contact(channel, raw))]
    keys = [f'identity:{source.id}:{data.external_customer_id}']
    keys.extend(f'identity-contact:{source.mall_id}:{channel}:{value}' for channel, value in contacts)
    for key in sorted(keys):
        lock(db, key)
    external = db.scalar(select(ExternalIdentity).where(ExternalIdentity.source_id == source.id, ExternalIdentity.external_customer_id == data.external_customer_id))
    candidates = db.scalars(select(Customer).join(CustomerContact).where(
        Customer.mall_id == source.mall_id,
        or_(*(and_(CustomerContact.channel == channel, CustomerContact.normalized_value == value)
              for channel, value in contacts)),
    ).distinct()).all() if contacts else []
    if len(candidates) > 1:
        raise AppError('identity_conflict', 'Телефон и email связаны с разными профилями или контакт неоднозначен')
    matched = candidates[0] if candidates else None
    if external:
        customer = db.get(Customer, external.customer_id)
        if matched and matched.id != customer.id:
            if has_identity_contact(db, customer.id):
                raise AppError('identity_conflict', 'Контакты относятся к другому профилю, чем ID клиента в источнике')
            customer = attach_unidentified_profile(db, customer, matched)
    else:
        customer = matched
        if not customer:
            identifier = uuid4()
            customer = Customer(id=identifier, mall_id=source.mall_id, global_customer_key=f'CDP-{identifier.hex}', display_name=data.display_name, identity_status='verified' if contacts else 'source_only')
            db.add(customer)
            db.flush()
        db.add(ExternalIdentity(source_id=source.id, external_customer_id=data.external_customer_id, customer_id=customer.id))
    if contacts:
        customer.identity_status = 'verified'
    if not customer.display_name and data.display_name:
        customer.display_name = data.display_name
    return customer


def event_fingerprint(data, legacy_contacts=False):
    canonical = data.model_dump(mode='json')
    if data.amount is not None:
        canonical['amount'] = f'{data.amount.quantize(Decimal("0.01")):.2f}'
    for field, channel in [('email', 'email'), ('phone', 'sms'), ('push_token', 'push')]:
        canonical[field] = normalize_contact(channel, getattr(data, field)) or getattr(data, field)
    if legacy_contacts and data.email:
        canonical['email'] = data.email.lower() if re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', data.email) else data.email
    if legacy_contacts and data.phone:
        # Exact reimports of events accepted before contact normalization changed
        # must remain duplicates, including old domestic phone representations.
        phone = re.sub(r'[\s()\-]', '', data.phone.strip())
        canonical['phone'] = phone if re.fullmatch(r'\+\d{8,15}', phone) else data.phone
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def ingest_event(db, source, data: NormalizedEvent):
    digest = event_fingerprint(data)
    lock(db, f'event:{source.id}:{data.external_event_id}')
    existing = db.scalar(select(Event).where(Event.source_id == source.id, Event.external_event_id == data.external_event_id))
    if existing:
        if existing.payload_hash != digest and existing.payload_hash != event_fingerprint(data, legacy_contacts=True):
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
