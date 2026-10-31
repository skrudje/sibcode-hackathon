from collections import defaultdict
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select

from app.core.config import Clock
from app.core.db import json_value
from app.core.errors import AppError
from app.models import Customer, Event, RecommendationRule, Segment, Source, Tenant


def scoped(db, model, identifier, mall_id):
    value = db.scalar(select(model).where(model.id == identifier, model.mall_id == mall_id))
    if not value:
        raise AppError('not_found', 'Запись не найдена', 404)
    return value


def validate_definition(db, definition, mall_id):
    for condition in definition['include_all'] + definition['exclude_any']:
        scoped(db, Tenant, UUID(str(condition['tenant_id'])), mall_id)


def destination_compatible(definition, tenant_id):
    return any(str(x['tenant_id']) == str(tenant_id) and bool({'interaction', 'purchase'} & set(x['event_types'])) for x in definition['exclude_any'])


def evaluate(db, segment, as_of=None, customer_id=None):
    definition = segment.definition
    conditions = definition['include_all'] + definition['exclude_any']
    tenants = {UUID(c['tenant_id']) for c in conditions}
    sources = {s.tenant_id: s for s in db.scalars(select(Source).where(Source.mall_id == segment.mall_id, Source.tenant_id.in_(tenants)))}
    now = Clock.now()
    if as_of and (as_of.tzinfo is None or as_of > now):
        raise AppError('invalid_as_of', 'Дата среза должна иметь часовой пояс и не быть в будущем')
    if as_of is None:
        ends = [sources[t].coverage_to for t in tenants if t in sources and sources[t].coverage_to]
        as_of = min(ends + [now]) if len(ends) == len(tenants) else now
    start = as_of - timedelta(days=definition['lookback_days'])
    covered = all((s := sources.get(UUID(c['tenant_id']))) and s.coverage_from and s.coverage_to and s.coverage_from <= start and s.coverage_to >= as_of and set(c['event_types']) <= set(s.covered_event_types) for c in conditions)
    query = select(Customer).where(Customer.mall_id == segment.mall_id)
    if customer_id:
        query = query.where(Customer.id == customer_id)
    customers = db.scalars(query.order_by(Customer.global_customer_key, Customer.id)).all()
    hits = defaultdict(list)
    if customers:
        events = db.scalars(select(Event).where(Event.mall_id == segment.mall_id, Event.customer_id.in_([c.id for c in customers]), Event.tenant_id.in_(tenants), Event.occurred_at > start, Event.occurred_at <= as_of).order_by(Event.occurred_at.desc(), Event.id.desc())).all()
        for event in events:
            hits[event.customer_id].append(event)
    result = {'eligible': [], 'ineligible': [], 'unknown': [], 'reasons': {}, 'evidence': {}, 'as_of': as_of, 'evaluated_at': now, 'window_start': start}

    def match(events, condition):
        return [e for e in events if str(e.tenant_id) == condition['tenant_id'] and e.event_type in condition['event_types']]

    for customer in customers:
        if customer.identity_status != 'verified':
            result['unknown'].append(customer)
            result['reasons'][customer.id] = 'identity_unverified'
        elif not covered:
            result['unknown'].append(customer)
            result['reasons'][customer.id] = 'insufficient_history'
        else:
            events = hits[customer.id]
            included = [match(events, c) for c in definition['include_all']]
            if all(included) and not any(match(events, c) for c in definition['exclude_any']):
                result['eligible'].append(customer)
                result['evidence'][customer.id] = [group[0] for group in included]
            else:
                result['ineligible'].append(customer)
                result['reasons'][customer.id] = 'no_matching_rules'
    return result


def evaluation_summary(result):
    return json_value({'as_of': result['as_of'], 'evaluated_at': result['evaluated_at'], **{f'{k}_count': len(result[k]) for k in ['eligible', 'ineligible', 'unknown']}})


def active_rule(db, rule):
    tenant = db.get(Tenant, rule.destination_tenant_id)
    return rule.is_active and tenant.is_active and rule.valid_from <= Clock.now() < rule.valid_until


def recommendation_item(db, rule, result, customer_id, segment=None):
    destination = db.get(Tenant, rule.destination_tenant_id)
    segment = segment if segment is not None else db.get(Segment, rule.segment_id)
    evidence = result['evidence'][customer_id]
    names = {t.id: t.name for t in db.scalars(select(Tenant).where(Tenant.mall_id == rule.mall_id))}
    excluded_types = {kind for condition in segment.definition['exclude_any'] if str(condition['tenant_id']) == str(destination.id) for kind in condition['event_types']}
    missing = 'взаимодействия' if 'interaction' in excluded_types else 'события покупки'
    explanation = f'Есть события: {", ".join(names[e.tenant_id] for e in evidence)}. Нет зарегистрированного {missing} в «{destination.name}» за {segment.definition["lookback_days"]} дней до даты среза.'
    return json_value(dict(rule_id=rule.id, segment_id=rule.segment_id, destination_tenant_id=destination.id, destination_tenant_name=destination.name, priority=rule.priority, offer_title=rule.offer_title, offer_description=rule.offer_description, explanation=explanation, observed_events=[dict(event_id=e.id, tenant_id=e.tenant_id, event_type=e.event_type, occurred_at=e.occurred_at) for e in evidence], absence_checks=[dict(tenant_id=c['tenant_id'], event_types=c['event_types'], window_start=result['window_start'], window_end=result['as_of'], observed_count=0, coverage_complete=True) for c in segment.definition['exclude_any']]))


def recommendations(db, customer, as_of=None):
    rules = db.scalars(select(RecommendationRule).where(RecommendationRule.mall_id == customer.mall_id).order_by(RecommendationRule.priority.desc(), RecommendationRule.id)).all()
    items, evaluations, reasons = [], {}, set()
    for rule in rules:
        if not active_rule(db, rule):
            continue
        result = evaluations.setdefault(rule.segment_id, None)
        if result is None:
            result = evaluate(db, db.get(Segment, rule.segment_id), as_of, customer.id)
            evaluations[rule.segment_id] = result
        if customer.id in result['evidence']:
            items.append(recommendation_item(db, rule, result, customer.id))
        elif customer.id in result['reasons']:
            reasons.add(result['reasons'][customer.id])
    unique = {}
    for item in items:
        unique.setdefault(item['destination_tenant_id'], item)
    items = sorted(unique.values(), key=lambda i: (-i['priority'], i['destination_tenant_id']))[:5]
    reason = None
    if not items:
        reason = 'identity_unverified' if customer.identity_status != 'verified' else 'insufficient_history' if 'insufficient_history' in reasons else 'no_active_offers' if not evaluations else 'no_matching_rules'
    effective = next(iter(evaluations.values()))['as_of'] if evaluations else as_of or Clock.now()
    return json_value(dict(customer_id=customer.id, as_of=effective, evaluated_at=Clock.now(), items=items, empty_reason=reason))
