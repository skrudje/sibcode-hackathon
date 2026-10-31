"""Explicit, repeatable fictional workspace; never resets existing history."""
import json
from datetime import timedelta
from uuid import UUID, uuid5

from sqlalchemy import select

from app.core.config import Clock, settings
from app.core.db import SessionLocal, lock
from app.models import Customer, ImportJob, Mall, RecommendationRule, Segment, Source, Tenant

CATALOG = [
    ('Кинотеатр «Кадр»', 'Кино и развлечения'),
    ('Кафе «Тёплый хлеб»', 'Кафе и рестораны'),
    ('Книжный «Лист и слово»', 'Книги'),
    ('Спорттовары «Пульс»', 'Спорт'),
    ('Одежда «Линия»', 'Мода'),
    ('Электроника «Спектр»', 'Электроника'),
    ('Цветы «Листва»', 'Цветы и подарки'),
    ('Детский центр «Точка игры»', 'Семья и досуг'),
    ('Товары для дома «Уют»', 'Дом'),
]


def prepare():
    from app.core.config import ROOT
    manifest = json.loads((ROOT / 'apps/api/fixtures/demo_scenario.json').read_text())
    mall_id = UUID(manifest['ids']['mall'])
    jobs = []
    with SessionLocal.begin() as db:
        lock(db, f'workspace-seed:{mall_id}')
        mall = db.get(Mall, mall_id)
        reference = mall.demo_reference_time
        first_setup = not db.get(Source, UUID(manifest['ids']['source_a'])).config.get('workspace_prepared')
        tenants = []
        for index, (name, category) in enumerate(CATALOG):
            identifier = UUID(manifest['sources'][index]['tenant_id']) if index < 3 else uuid5(mall.id, f'workspace-tenant:{index}')
            tenant = db.get(Tenant, identifier)
            if not tenant:
                tenant = Tenant(id=identifier, mall_id=mall.id, code=f'shop{index+1}', name=name, category=category)
                db.add(tenant); db.flush()
            tenant.name, tenant.category = name, category
            tenants.append(tenant)
            source = db.scalar(select(Source).where(Source.tenant_id == tenant.id))
            if not source:
                source = Source(id=uuid5(tenant.id, 'source'), mall_id=mall.id, tenant_id=tenant.id, name=name, kind='contacts')
                db.add(source); db.flush()
            source.name, source.kind = name, 'contacts'
            # These ranges are declared by the generated provider dataset.
            if not source.config.get('workspace_prepared'):
                # The provider's explicit declaration is applied only after its
                # first complete import, not while thousands of rows are queued.
                source.coverage_from, source.coverage_to = None, None
                source.last_success_at = None
                source.covered_event_types = ['interaction']
                source.config = {**source.config, 'api_url': f'http://mock-source:8011/contacts/{index+1}',
                    'interval_minutes': 15, 'enabled': True, 'next_sync_at': Clock.now().isoformat(),
                    'credential_env': None, 'last_error': None, 'workspace_prepared': True}
            rows = []
            for number in range(1, 601):
                # Deliberate, varied overlaps: cinema/cafe/books and sports/clothes.
                group = ((number <= 320) if index == 0 else
                         (number <= 240 or 400 < number <= 510) if index == 1 else
                         (number <= 135 or 550 < number <= 590) if index == 2 else
                         (200 < number <= 430) if index == 3 else
                         (220 < number <= 360 or 500 < number <= 570) if index == 4 else
                         (number % 3 == 0) if index == 5 else
                         (number % 5 == 0 or 100 < number <= 170) if index == 6 else
                         (number % 4 == 0 or 360 < number <= 430) if index == 7 else
                         (number % 7 == 0 or 440 < number <= 520))
                if not group:
                    continue
                for repeat in range(1 + (number + index) % 3):
                    rows.append({'phone': f'+790000{number:05d}', 'email': f'client{number:04d}@example.invalid',
                        'time': (reference-timedelta(days=2+(number*7+index*11+repeat*17)%150, hours=(number+repeat)%20)).isoformat()})
            payload = {'records': rows, 'next_cursor': str(len(rows)), 'has_more': False,
                       'coverage_from': (reference-timedelta(days=200)).isoformat(), 'coverage_to': reference.isoformat()}
            settings.path('demo_dir').mkdir(parents=True, exist_ok=True)
            (settings.path('demo_dir') / f'contacts-{index+1}.json').write_text(json.dumps(payload))
            # First load uses the same durable import pipeline as files and pulls.
            marker = f'workspace-{index+1}.json'
            path = settings.path('upload_dir') / marker
            path.parent.mkdir(parents=True, exist_ok=True)
            if not db.scalar(select(ImportJob.id).where(ImportJob.source_id == source.id, ImportJob.file_path == str(path))):
                path.write_text(json.dumps(payload))
                job = ImportJob(source_id=source.id, file_path=str(path))
                db.add(job); db.flush(); jobs.append(job.id)
            if index > 0:
                sid = uuid5(tenant.id, 'workspace-segment')
                segment = db.get(Segment, sid)
                if not segment:
                    segment = Segment(id=sid, mall_id=mall.id, name=f'Новое знакомство: {name}', definition={
                        'lookback_days': 90, 'include_all': [{'tenant_id': str(tenants[0].id), 'event_types': ['interaction']}],
                        'exclude_any': [{'tenant_id': str(tenant.id), 'event_types': ['interaction']}],
                        'require_verified_identity': True, 'require_complete_coverage': True})
                    db.add(segment); db.flush()
                rid = uuid5(tenant.id, 'workspace-rule')
                if not db.get(RecommendationRule, rid):
                    db.add(RecommendationRule(id=rid, mall_id=mall.id, name=f'Приглашение: {name}', segment_id=sid,
                        destination_tenant_id=tenant.id, priority=90-index, offer_title=f'Откройте для себя {name}',
                        offer_description='Специальное предложение для гостей торгового центра. Подробности у арендатора.',
                        valid_from=reference-timedelta(days=1), valid_until=reference+timedelta(days=60), is_active=True))
        # Remove technical alphabetic suffixes in the initial, known fixture objects.
        if first_setup:
            legacy_segment = db.get(Segment, UUID(manifest['ids']['segment']))
            legacy_segment.name = 'После кино и кафе — новое знакомство'
            legacy_segment.definition = {**legacy_segment.definition,
                'include_all': [{'tenant_id': str(tenants[0].id), 'event_types': ['interaction']}, {'tenant_id': str(tenants[1].id), 'event_types': ['interaction']}],
                'exclude_any': [{'tenant_id': str(tenants[2].id), 'event_types': ['interaction']}]}
            rule = db.get(RecommendationRule, UUID(manifest['ids']['recommendation_rule']))
            rule.name = 'Книги после кино и кафе'
            rule.offer_title = 'Откройте книжный «Лист и слово»'
            rule.offer_description = 'Подборка книг и специальное предложение для новых гостей.'
            from app.models import Campaign
            campaign = db.get(Campaign, UUID(manifest['ids']['campaign']))
            campaign.name = 'Знакомство с книжным «Лист и слово»'
        for customer in db.scalars(select(Customer).where(Customer.mall_id == mall.id)):
            if customer.display_name and 'демо' in customer.display_name.lower():
                customer.display_name = customer.display_name.replace('Демо · ', '').replace('Демо ', '').replace('демо ', '')
    return jobs


if __name__ == '__main__':
    from app.modules.ingestion.service import process_job
    for job_id in prepare():
        process_job(job_id)
    print('Fictional workspace prepared through durable imports.')
