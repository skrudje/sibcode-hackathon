from sqlalchemy import select

from app.core.config import Clock
from app.core.errors import AppError
from app.models import Source

from .contracts import SourceCoveragePatch


def update_coverage(db, source_id, mall_id, patch: SourceCoveragePatch):
    # Serialize partial updates so each validates against the latest stored pair.
    source = db.scalar(select(Source).where(
        Source.id == source_id, Source.mall_id == mall_id,
    ).with_for_update())
    if source is None:
        raise AppError('not_found', 'Источник не найден', 404)

    changes = patch.model_dump(exclude_unset=True)
    start = changes.get('coverage_from', source.coverage_from)
    end = changes.get('coverage_to', source.coverage_to)
    if (start is None) != (end is None):
        raise AppError('invalid_coverage', 'Начало и конец покрытия задаются вместе; для сброса передайте обе даты как null', details=[
            {'field': 'coverage_from', 'message': 'Обе даты должны быть заполнены либо обе равны null'},
            {'field': 'coverage_to', 'message': 'Обе даты должны быть заполнены либо обе равны null'},
        ])
    if start is not None:
        if start >= end:
            raise AppError('invalid_coverage', 'Начало покрытия должно быть раньше окончания', details=[
                {'field': 'coverage_to', 'message': 'Дата окончания должна быть позже начала'},
            ])
        if end > Clock.now():
            raise AppError('invalid_coverage', 'Нельзя заявлять полноту истории за будущий период', details=[
                {'field': 'coverage_to', 'message': 'Дата окончания не должна быть в будущем'},
            ])

    for field, value in changes.items():
        setattr(source, field, value)
    return source
