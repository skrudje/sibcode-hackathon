"""Read-only draft previews and atomic, idempotent campaign preparation."""
import hashlib
import json
from uuid import UUID, uuid5

from sqlalchemy.orm import Session

from app.core.db import engine, json_value, lock
from app.core.errors import AppError
from app.models import Campaign, RecommendationRule, Segment, Tenant
from app.modules.exports.service import preview
from app.modules.radar.contracts import RadarOptions
from app.modules.radar.service import analyze
from app.modules.segments.names import audience_name
from app.modules.segments.service import active_rule, destination_compatible, evaluate, scoped, validate_definition
from .contracts import CampaignWizardDraft, WizardAudience


def identifiers(mall_id, body):
    # The preview token is intentionally excluded: retries must work after data changes.
    draft = CampaignWizardDraft.model_validate(body.model_dump(include=set(CampaignWizardDraft.model_fields)))
    signature = hashlib.sha256(draft.model_dump_json().encode()).hexdigest()
    campaign_id = uuid5(mall_id, f'campaign-wizard:{draft.idempotency_key}')
    return campaign_id, uuid5(campaign_id, f'segment:{signature}'), uuid5(campaign_id, f'rule:{signature}')


def resolve_audience(db, mall_id, body: WizardAudience, identifier):
    if body.kind == 'segment':
        return scoped(db, Segment, body.segment_id, mall_id), False
    if body.kind == 'radar':
        report, _, _ = analyze(db, mall_id, body.options or RadarOptions())
        item = next((item for item in report['opportunities'] if item['id'] == body.opportunity_id), None)
        if not item:
            raise AppError('radar_opportunity_changed', 'Возможность изменилась. Вернитесь к выбору аудитории и обновите радар.', 409)
        definition = item['definition']
        name = audience_name([item['name'] for item in item['origins']], item['destination']['name'], definition['lookback_days'])
    else:
        definition = body.definition.model_dump(mode='json')
        validate_definition(db, definition, mall_id)
        origins = [scoped(db, Tenant, UUID(condition['tenant_id']), mall_id).name for condition in definition['include_all']]
        targets = [scoped(db, Tenant, UUID(condition['tenant_id']), mall_id).name for condition in definition['exclude_any']]
        name = body.name or audience_name(origins, ' + '.join(targets) or 'выбранного арендатора', definition['lookback_days'])
    return Segment(id=identifier, mall_id=mall_id, name=name, definition=definition), True


def audience_preview(mall_id, body):
    identifier = uuid5(mall_id, 'wizard-audience-preview')
    with Session(engine.execution_options(isolation_level='REPEATABLE READ')) as db, db.begin():
        segment, _ = resolve_audience(db, mall_id, body, identifier)
        result = evaluate(db, segment)
        return json_value(dict(name=segment.name, definition=segment.definition, as_of=result['as_of'],
            eligible_count=len(result['eligible']), ineligible_count=len(result['ineligible']), unknown_count=len(result['unknown'])))


def resolve_draft(db, mall_id, body):
    campaign_id, segment_id, rule_id = identifiers(mall_id, body)
    segment, new_segment = resolve_audience(db, mall_id, body.audience, segment_id)
    if body.offer.rule_id:
        source = scoped(db, RecommendationRule, body.offer.rule_id, mall_id)
        if not active_rule(db, source):
            raise AppError('wizard_offer_unavailable', 'Предложение больше не действует. Вернитесь к шагу «Предложение».', 409)
        destination_id = source.destination_tenant_id
        new_rule = source.segment_id != segment.id
        if not new_rule:
            rule = source
        else:
            rule = RecommendationRule(id=rule_id, mall_id=mall_id, segment_id=segment.id,
                name=f'Правило: {body.name}'[:120], destination_tenant_id=destination_id, priority=source.priority,
                offer_title=source.offer_title, offer_description=source.offer_description,
                valid_from=source.valid_from, valid_until=source.valid_until, is_active=True)
    else:
        offer = body.offer.draft
        destination_id = offer.destination_tenant_id
        new_rule = True
        rule = RecommendationRule(id=rule_id, mall_id=mall_id, segment_id=segment.id,
            name=f'Правило: {body.name}'[:120], destination_tenant_id=destination_id, priority=offer.priority,
            offer_title=offer.title, offer_description=offer.description,
            valid_from=offer.valid_from, valid_until=offer.valid_until, is_active=True)
    destination = scoped(db, Tenant, destination_id, mall_id)
    if not destination.is_active:
        raise AppError('wizard_offer_unavailable', 'Арендатор отключён. Выберите другое назначение.', 409)
    if not destination_compatible(segment.definition, destination_id):
        raise AppError('invalid_destination', 'У выбранного арендатора в аудитории должно быть исключено взаимодействие или покупка')
    campaign = Campaign(id=campaign_id, mall_id=mall_id, name=body.name, segment_id=segment.id,
        recommendation_rule_id=rule.id, channel=body.channel)
    return campaign, segment, rule, destination, new_segment, new_rule


def draft_preview(db, campaign, segment, rule, destination):
    result = evaluate(db, segment)
    report, recipients = preview(db, campaign, segment=segment, rule=rule, evaluation=result)
    # Include all recipients, not just the sample. Exclude evaluated_at, which changes on every request.
    facts = dict(definition=segment.definition, as_of=report['as_of'], base_count=report['base_count'],
        excluded_counts=report['excluded_counts'], recipients=recipients, unknown_count=len(result['unknown']),
        offer=dict(title=rule.offer_title, description=rule.offer_description, valid_from=rule.valid_from,
                   valid_until=rule.valid_until, priority=rule.priority, active=rule.is_active),
        destination_id=rule.destination_tenant_id, channel=campaign.channel)
    token = hashlib.sha256(json.dumps(json_value(facts), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return dict(preview_token=token, audience_name=segment.name, definition=segment.definition,
        destination_name=destination.name, offer_title=rule.offer_title, unknown_count=len(result['unknown']),
        **{key: report[key] for key in ['channel', 'as_of', 'evaluated_at', 'base_count', 'eligible_count', 'excluded_counts', 'sample', 'limitations']})


def preview_campaign(mall_id, body):
    with Session(engine.execution_options(isolation_level='REPEATABLE READ')) as db, db.begin():
        campaign, segment, rule, destination, _, _ = resolve_draft(db, mall_id, body)
        return json_value(draft_preview(db, campaign, segment, rule, destination))


def create_campaign(mall_id, body):
    campaign_id, planned_segment_id, planned_rule_id = identifiers(mall_id, body)
    with Session(engine, expire_on_commit=False) as db, db.begin():
        lock(db, f'campaign-wizard:{campaign_id}')
        existing = db.get(Campaign, campaign_id)
        if existing:
            expected_segment = body.audience.segment_id if body.audience.kind == 'segment' else planned_segment_id
            allowed_rules = {planned_rule_id, body.offer.rule_id} if body.offer.rule_id else {planned_rule_id}
            if (existing.mall_id != mall_id or existing.name != body.name or existing.channel != body.channel
                    or existing.segment_id != expected_segment or existing.recommendation_rule_id not in allowed_rules):
                raise AppError('idempotency_conflict', 'Этот ключ уже использован для другой кампании', 409)
            return dict(campaign_id=existing.id, segment_id=existing.segment_id,
                recommendation_rule_id=existing.recommendation_rule_id, created=False)
        campaign, segment, rule, destination, new_segment, new_rule = resolve_draft(db, mall_id, body)
        current = draft_preview(db, campaign, segment, rule, destination)
        if current['preview_token'] != body.preview_token:
            raise AppError('wizard_preview_changed', 'Данные изменились. Проверьте обновлённый предпросмотр и создайте кампанию ещё раз.', 409)
        if not current['eligible_count']:
            raise AppError('no_exportable_recipients', 'Нет контактов для выбранного канала. Проверьте причины исключения.', 409)
        if new_segment:
            db.add(segment)
            db.flush()
        if new_rule:
            db.add(rule)
            db.flush()
        db.add(campaign)
        db.flush()
        return dict(campaign_id=campaign.id, segment_id=segment.id, recommendation_rule_id=rule.id, created=True)
