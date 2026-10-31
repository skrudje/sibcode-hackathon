import csv
import io
from datetime import timedelta
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Clock
from app.core.db import engine, json_value, lock
from app.core.errors import AppError
from app.models import Campaign, CampaignRecipient, ContactChannelState, CustomerContact, Export, RecommendationRule, Segment
from app.modules.segments.service import active_rule, evaluate, recommendation_item, scoped

REASONS = ['offer_inactive', 'missing_contact', 'contact_conflict', 'duplicate_contact', 'already_exported', 'cooldown']


def preview(db, campaign, reserve_locks=False, *, segment=None, rule=None, evaluation=None):
    rule = rule if rule is not None else db.get(RecommendationRule, campaign.recommendation_rule_id)
    segment = segment if segment is not None else db.get(Segment, campaign.segment_id)
    result = evaluation if evaluation is not None else evaluate(db, segment)
    candidates = result['eligible']
    excluded = dict.fromkeys(REASONS, 0)
    recipients = []
    if not active_rule(db, rule):
        excluded['offer_inactive'] = len(candidates)
    else:
        contacts = {}
        for contact in db.scalars(select(CustomerContact).where(CustomerContact.customer_id.in_([c.id for c in candidates]), CustomerContact.channel == campaign.channel, CustomerContact.normalized_value.is_not(None))):
            contacts.setdefault(contact.customer_id, set()).add(contact.normalized_value)
        seen = set()
        pending = []
        for customer in candidates:
            values = contacts.get(customer.id, set())
            if not values:
                excluded['missing_contact'] += 1
                continue
            if len(values) > 1:
                excluded['contact_conflict'] += 1
                continue
            contact = next(iter(values))
            if contact in seen:
                excluded['duplicate_contact'] += 1
                continue
            seen.add(contact)
            pending.append((customer, contact))
        if reserve_locks:
            for contact in sorted(seen):
                lock(db, f'export-contact:{campaign.mall_id}:{campaign.channel}:{contact}')
        previous = set(db.scalars(select(CampaignRecipient.contact_normalized).where(CampaignRecipient.campaign_id == campaign.id)))
        states = {s.contact_normalized: s for s in db.scalars(select(ContactChannelState).where(ContactChannelState.mall_id == campaign.mall_id, ContactChannelState.channel == campaign.channel, ContactChannelState.contact_normalized.in_(list(seen))))}
        for customer, contact in pending:
            if contact in previous:
                excluded['already_exported'] += 1
                continue
            state = states.get(contact)
            if state and state.last_exported_at and state.last_exported_at > Clock.now() - timedelta(days=7):
                excluded['cooldown'] += 1
                continue
            item = recommendation_item(db, rule, result, customer.id, segment=segment)
            recipients.append(dict(customer_id=str(customer.id), global_customer_key=customer.global_customer_key, display_name=customer.display_name, contact=contact, destination_tenant_id=str(rule.destination_tenant_id), offer_title=rule.offer_title, reason=item['explanation']))
    return json_value(dict(campaign_id=campaign.id, channel=campaign.channel, as_of=result['as_of'], evaluated_at=Clock.now(), base_count=len(candidates), eligible_count=len(recipients), excluded_counts=excluded, sample=recipients[:20], limitations=['Выгрузка не отправляет сообщения.', 'Частота ограничена по фактам выгрузки; справочник отписок не подключён.'])), recipients


def export_public(row):
    return json_value(dict(id=row.id, campaign_id=row.campaign_id, status=row.status, recipient_count=row.recipient_count, as_of=row.as_of, created_at=row.created_at, download_url=f'/api/v1/exports/{row.id}/download'))


def safe_csv(value):
    value = str(value)
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@')) else value


def create_export(campaign_id, mall_id, key):
    for attempt in range(3):
        try:
            with Session(engine.execution_options(isolation_level='REPEATABLE READ'), expire_on_commit=False) as db, db.begin():
                campaign = db.scalar(select(Campaign).where(Campaign.id == campaign_id, Campaign.mall_id == mall_id).with_for_update())
                if not campaign:
                    raise AppError('not_found', 'Кампания не найдена', 404)
                existing = db.scalar(select(Export).where(Export.campaign_id == campaign.id, Export.idempotency_key == key))
                if existing:
                    return export_public(existing), False
                report, recipients = preview(db, campaign, reserve_locks=True)
                if not recipients:
                    raise AppError('no_exportable_recipients', 'Нет контактов, подходящих для выгрузки', 409)
                output = io.StringIO(newline='')
                writer = csv.writer(output)
                writer.writerow(['campaign_id', 'customer_id', 'channel', 'contact', 'destination_tenant', 'offer_title', 'reason', 'as_of'])
                export = Export(id=uuid4(), campaign_id=campaign.id, idempotency_key=key, status='ready', recipient_count=len(recipients), as_of=report['as_of'], file_content=b'')
                db.add(export)
                db.flush()
                for recipient in recipients:
                    writer.writerow([safe_csv(v) for v in [campaign.id, recipient['customer_id'], campaign.channel, recipient['contact'], recipient['destination_tenant_id'], recipient['offer_title'], recipient['reason'], report['as_of']]])
                    db.add(CampaignRecipient(export_id=export.id, campaign_id=campaign.id, customer_id=recipient['customer_id'], channel=campaign.channel, contact_normalized=recipient['contact']))
                    state = db.get(ContactChannelState, (mall_id, campaign.channel, recipient['contact']))
                    if not state:
                        state = ContactChannelState(mall_id=mall_id, channel=campaign.channel, contact_normalized=recipient['contact'])
                        db.add(state)
                    state.last_exported_at = Clock.now()
                export.file_content = output.getvalue().encode('utf-8-sig')
                db.flush()
                return export_public(export), True
        except DBAPIError as exc:
            code = getattr(exc.orig, 'sqlstate', None)
            if code not in ['40001', '40P01', '23505']:
                raise
            if attempt == 2:
                raise AppError('export_busy', 'Выгрузка занята. Повторите операцию с тем же ключом.', 503) from exc
