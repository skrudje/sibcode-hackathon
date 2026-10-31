"""Observed affinities, never movement tracking or conversion probabilities.

Each pattern uses the same source watermark and event types as its generated
segment. Counts are distinct verified customers, not transaction counts.
"""
import hashlib
import json
from collections import defaultdict
from datetime import timedelta
from itertools import combinations
from uuid import UUID, uuid5

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Clock
from app.core.db import dump, engine, json_value, lock
from app.core.errors import AppError
from app.models import Campaign, Customer, Event, RecommendationRule, Segment, Source, Tenant
from app.modules.segments.service import active_rule, scoped
from .contracts import RadarCampaignWrite, RadarOptions

EVENT_TYPES = ('visit', 'purchase', 'booking', 'interaction')


def node_public(tenant, source, options, now):
    types = [kind for kind in EVENT_TYPES if source and kind in source.covered_event_types]
    if not source or not source.last_success_at:
        status = 'not_loaded'
    elif not types:
        status = 'no_event_types'
    elif (not source.coverage_from or not source.coverage_to
          or source.coverage_to > now
          or source.coverage_from > source.coverage_to - timedelta(days=options.lookback_days)):
        status = 'incomplete_history'
    else:
        status = 'ready'
    return dict(tenant_id=tenant.id, code=tenant.code, name=tenant.name,
                category=tenant.category, event_types=types,
                coverage_from=source.coverage_from if source else None,
                coverage_to=source.coverage_to if source else None,
                coverage_status=status)


def analyze(db, mall_id, options):
    now = Clock.now()
    tenants = db.scalars(select(Tenant).where(Tenant.mall_id == mall_id, Tenant.is_active.is_(True)).order_by(Tenant.code, Tenant.id)).all()
    sources = {s.tenant_id: s for s in db.scalars(select(Source).where(Source.mall_id == mall_id))}
    nodes = {t.id: node_public(t, sources.get(t.id), options, now) for t in tenants}
    customers = {c.id: c for c in db.scalars(select(Customer).where(Customer.mall_id == mall_id).order_by(Customer.global_customer_key, Customer.id))}
    verified = {c.id for c in customers.values() if c.identity_status == 'verified'}
    # Also verify joined ownership, so corrupted foreign references cannot
    # participate in the comparison population or evidence.
    events = db.scalars(select(Event).join(Customer, Event.customer_id == Customer.id)
        .join(Source, Event.source_id == Source.id).join(Tenant, Event.tenant_id == Tenant.id)
        .where(Event.mall_id == mall_id, Customer.mall_id == mall_id, Source.mall_id == mall_id,
               Tenant.mall_id == mall_id, Tenant.is_active.is_(True), Event.tenant_id.in_(list(nodes)),
               Event.event_type.in_(EVENT_TYPES), Source.tenant_id == Event.tenant_id,
               Event.occurred_at <= now).order_by(Event.occurred_at.desc(), Event.id)).all()
    ready = [tid for tid, node in nodes.items() if node['coverage_status'] == 'ready']
    offers = defaultdict(list)
    seen_offers = set()
    for rule in db.scalars(select(RecommendationRule).where(RecommendationRule.mall_id == mall_id).order_by(RecommendationRule.priority.desc(), RecommendationRule.id)):
        signature = (rule.destination_tenant_id, rule.offer_title, rule.offer_description, rule.valid_from, rule.valid_until)
        if rule.destination_tenant_id in nodes and active_rule(db, rule) and signature not in seen_offers:
            seen_offers.add(signature)
            offers[rule.destination_tenant_id].append(dict(rule_id=rule.id, title=rule.offer_title, description=rule.offer_description, valid_until=rule.valid_until))

    windows = {}
    opportunities, contexts = [], {}
    complete_patterns = 0
    for destination in ready:
        destination_type = 'interaction' if 'interaction' in sources[destination].covered_event_types else 'purchase'
        if destination_type not in sources[destination].covered_event_types:
            continue
        origins = [tid for tid in ready if tid != destination]
        for size in (1, 2):
            for origin_ids in combinations(origins, size):
                participating = (*origin_ids, destination)
                as_of = min(sources[tid].coverage_to for tid in participating)
                start = as_of - timedelta(days=options.lookback_days)
                if any(sources[tid].coverage_from > start for tid in participating):
                    continue
                complete_patterns += 1
                # Different source watermarks use independent comparison windows.
                if as_of not in windows:
                    hits, buyers, evidence, population = defaultdict(set), defaultdict(set), {}, set()
                    for event in events:
                        if event.customer_id not in verified or not start < event.occurred_at <= as_of:
                            continue
                        population.add(event.customer_id)
                        if event.event_type in nodes[event.tenant_id]['event_types']:
                            hits[event.tenant_id].add(event.customer_id)
                            evidence.setdefault((event.customer_id, event.tenant_id, 'any'), event)
                        if event.event_type in ('purchase', 'interaction'):
                            buyers[(event.tenant_id, event.event_type)].add(event.customer_id)
                            evidence.setdefault((event.customer_id, event.tenant_id, event.event_type), event)
                    windows[as_of] = hits, buyers, evidence, population
                hits, buyers, evidence, population = windows[as_of]
                cohort = set.intersection(*(hits[tid] for tid in origin_ids))
                target_customers = buyers[(destination, destination_type)]
                shared = cohort & target_customers
                candidates = cohort - target_customers
                if not candidates or len(shared) < options.min_shared_customers:
                    continue
                conditional = len(shared) / len(cohort)
                baseline = len(target_customers) / len(population)
                lift = conditional / baseline
                if lift < options.min_lift:
                    continue
                definition = dict(lookback_days=options.lookback_days,
                    include_all=[dict(tenant_id=str(tid), event_types=nodes[tid]['event_types']) for tid in origin_ids],
                    exclude_any=[dict(tenant_id=str(destination), event_types=[destination_type])],
                    require_verified_identity=True, require_complete_coverage=True)
                identifier = uuid5(mall_id, 'radar:' + json.dumps(definition, sort_keys=True))
                origin_names = ' + '.join(nodes[tid]['name'] for tid in origin_ids)
                noun = 'взаимодействие' if destination_type == 'interaction' else 'покупку'
                explanation = (f'Среди {len(cohort)} клиентов с контактами и событиями в «{origin_names}» '
                    f'{len(shared)} имеют {noun} в «{nodes[destination]["name"]}» за то же окно. '
                    f'Частота {conditional:.1%}, в общей активной базе — {baseline:.1%}; отношение {lift:.2f}. '
                    f'У {len(candidates)} клиентов такого события в полной доступной истории нет.')
                item = dict(id=identifier, origins=[nodes[tid] for tid in origin_ids], destination=nodes[destination],
                    definition=definition, as_of=as_of, window_start=start,
                    population_count=len(population), cohort_count=len(cohort), shared_count=len(shared),
                    destination_count=len(target_customers), candidate_count=len(candidates),
                    unknown_count=len(customers) - len(verified), conditional_rate=conditional,
                    baseline_rate=baseline, lift=lift, explanation=explanation, offers=offers[destination])
                opportunities.append(item)
                contexts[identifier] = (candidates, shared, evidence, origin_ids, destination, destination_type)
    opportunities.sort(key=lambda x: (-x['lift'], -x['shared_count'], -x['candidate_count'], str(x['id'])))
    empty = None if opportunities else ('no_data' if not events else 'insufficient_history' if not complete_patterns else 'insufficient_support')
    report = dict(evaluated_at=now, options=options.model_dump(), customer_count=len(customers),
        verified_customer_count=len(verified), unknown_customer_count=len(customers)-len(verified),
        nodes=list(nodes.values()), opportunities=opportunities[:100], total_opportunity_count=len(opportunities), empty_reason=empty)
    return report, contexts, customers


def snapshot(mall_id, options, opportunity_id=None, limit=20, offset=0):
    with Session(engine.execution_options(isolation_level='REPEATABLE READ')) as db, db.begin():
        report, contexts, customers = analyze(db, mall_id, options)
        if opportunity_id is None:
            return json_value(report)
        item = next((x for x in report['opportunities'] if x['id'] == opportunity_id), None)
        if item is None:
            raise AppError('radar_opportunity_not_found', 'Возможность больше не соответствует фильтрам. Обновите радар.', 404)
        candidates, shared, evidence, origins, destination, destination_type = contexts[opportunity_id]

        def customer_public(customer, include_destination=False):
            observed = [evidence[(customer.id, tid, 'any')] for tid in origins]
            if include_destination:
                observed.append(evidence[(customer.id, destination, destination_type)])
            return dict(id=customer.id, global_customer_key=customer.global_customer_key, display_name=customer.display_name,
                observed_events=[dict(event_id=e.id, tenant_id=e.tenant_id, event_type=e.event_type, occurred_at=e.occurred_at) for e in observed])

        ordered = [c for c in customers.values() if c.id in candidates]
        examples = [c for c in customers.values() if c.id in shared][:3]
        return json_value(dict(opportunity=item, items=[customer_public(c) for c in ordered[offset:offset+limit]],
            total=len(ordered), limit=limit, offset=offset, shared_examples=[customer_public(c, True) for c in examples]))


def launch(mall_id, body: RadarCampaignWrite):
    # Lock first, then read the latest committed data. A repeat of the same
    # action returns its saved objects even after new events arrive.
    with Session(engine, expire_on_commit=False) as db, db.begin():
        campaign_id = uuid5(mall_id, f'radar-campaign:{body.idempotency_key}')
        lock(db, f'radar-campaign:{campaign_id}')
        signature = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
        segment_id = uuid5(campaign_id, 'segment:' + signature)
        rule_id = uuid5(campaign_id, 'rule:' + signature)
        existing = db.get(Campaign, campaign_id)
        if existing:
            if existing.segment_id != segment_id or existing.mall_id != mall_id:
                raise AppError('idempotency_conflict', 'Этот ключ уже использован для другого действия', 409)
            return dict(campaign_id=existing.id, segment_id=existing.segment_id, recommendation_rule_id=existing.recommendation_rule_id, created=False)
        report, _, _ = analyze(db, mall_id, RadarOptions(**body.model_dump(include=set(RadarOptions.model_fields))))
        opportunity = next((x for x in report['opportunities'] if x['id'] == body.opportunity_id), None)
        if not opportunity:
            raise AppError('radar_opportunity_changed', 'Возможность изменилась. Обновите радар и проверьте аудиторию.', 409)
        offer = scoped(db, RecommendationRule, body.offer_rule_id, mall_id)
        if offer.destination_tenant_id != opportunity['destination']['tenant_id'] or not active_rule(db, offer):
            raise AppError('radar_offer_unavailable', 'Выберите действующее предложение целевого арендатора', 409)
        definition = opportunity['definition']
        segment = Segment(id=segment_id, mall_id=mall_id, name=body.name, definition=definition)
        db.add(segment)
        db.flush()
        rule = RecommendationRule(id=rule_id, mall_id=mall_id, name=body.name, segment_id=segment.id,
            destination_tenant_id=offer.destination_tenant_id, priority=offer.priority,
            offer_title=offer.offer_title, offer_description=offer.offer_description,
            valid_from=offer.valid_from, valid_until=offer.valid_until, is_active=True)
        db.add(rule)
        db.flush()
        campaign = Campaign(id=campaign_id, mall_id=mall_id, name=body.name, segment_id=segment.id,
            recommendation_rule_id=rule.id, channel=body.channel)
        db.add(campaign)
        db.flush()
        return dict(campaign_id=campaign.id, segment_id=segment.id, recommendation_rule_id=rule.id, created=True)
