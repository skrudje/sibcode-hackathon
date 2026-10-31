import json
from uuid import UUID, uuid5

from app.core.config import ROOT
from app.core.db import SessionLocal
from app.models import Event, ImportJob, Segment
from app.modules.segments.names import audience_name
from app.workspace_seed import CATALOG, prepare
from sqlalchemy import func, select


def test_audience_name_preserves_window_with_long_tenant_names():
    name = audience_name(['И' * 120, 'О' * 120], 'Н' * 120, 365)
    assert len(name) <= 120
    assert 'без записей в' in name and name.endswith('365 дн.')


def test_workspace_renames_only_untouched_legacy_segments():
    prepare()
    manifest = json.loads((ROOT / 'demo/templates/demo_scenario.json').read_text())
    mall_id = UUID(manifest['ids']['mall'])
    def segment_id(index):
        tenant_id = UUID(manifest['sources'][index]['tenant_id']) if index < 3 else uuid5(mall_id, f'workspace-tenant:{index}')
        return uuid5(tenant_id, 'workspace-segment')

    with SessionLocal.begin() as db:
        original = db.get(Segment, segment_id(7))
        assert original.name == audience_name([CATALOG[0][0]], CATALOG[7][0], 90)
        original.name = f'Новое знакомство: {CATALOG[7][0]}'
        custom = db.get(Segment, segment_id(6))
        custom.name = 'Моя аудитория'
        changed = db.get(Segment, segment_id(5))
        changed.name = f'Новое знакомство: {CATALOG[5][0]}'
        changed.definition = {**changed.definition, 'lookback_days': 30}
        jobs_before = db.scalar(select(func.count(ImportJob.id)))
        events_before = db.scalar(select(func.count(Event.id)))
    assert prepare() == []
    with SessionLocal() as db:
        assert db.get(Segment, segment_id(7)).name == audience_name([CATALOG[0][0]], CATALOG[7][0], 90)
        assert db.get(Segment, segment_id(6)).name == 'Моя аудитория'
        assert db.get(Segment, segment_id(5)).name == f'Новое знакомство: {CATALOG[5][0]}'
        assert db.get(Segment, segment_id(5)).definition['lookback_days'] == 30
        assert db.scalar(select(func.count(ImportJob.id))) == jobs_before
        assert db.scalar(select(func.count(Event.id))) == events_before
