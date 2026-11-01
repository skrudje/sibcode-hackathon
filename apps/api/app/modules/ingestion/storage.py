"""Serialize upload budgets and expire only terminal jobs' private input files."""
import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import func, select

from app.core.config import Clock, settings
from app.core.db import SessionLocal, lock
from app.core.errors import AppError
from app.models import ImportJob, Source
from .adapters import MAX_BYTES

ACTIVE = ('queued', 'running')


def managed_path(value):
    if not value:
        return None
    path = Path(value).resolve()
    return path if path.is_relative_to(settings.path('upload_dir').resolve()) else None


def check_storage(db, mall_id, size):
    # Global lock also serializes budgets across different malls sharing this volume.
    lock(db, 'import-storage-budget')
    root = settings.path('upload_dir')
    stored = [path for path in root.glob('*') if path.is_file()]
    total = sum(path.stat().st_size for path in stored)
    own = 0
    for value, owner in db.execute(select(ImportJob.file_path, Source.mall_id).join(Source)
                                   .where(ImportJob.file_path.is_not(None))):
        path = managed_path(value)
        try:
            current = path.stat().st_size if path else 0
        except FileNotFoundError:
            current = 0
        if owner == mall_id:
            own += current
    if (len(stored) >= 10000 or own + size > settings.max_upload_bytes_per_mall
            or total + size > settings.max_upload_bytes_total):
        raise AppError('upload_quota_exceeded', 'Лимит хранения загрузок исчерпан. Обратитесь к администратору.', 429,
                       headers={'Retry-After': '60'})


def write_payload(db, source, content, suffix, identifier):
    if suffix not in {'.csv', '.xlsx', '.json'} or len(content) > MAX_BYTES:
        raise AppError('file_too_large', 'Максимальный размер файла — 10 MiB', 413)
    check_storage(db, source.mall_id, len(content))
    directory = settings.path('upload_dir')
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'{identifier}{suffix}'
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(content)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return path


def check_queue_budget(db, source):
    lock(db, 'import-storage-budget')
    active = select(ImportJob).join(Source).where(Source.mall_id == source.mall_id, ImportJob.status.in_(ACTIVE))
    count = db.scalar(select(func.count()).select_from(active.subquery()))
    source_count = db.scalar(select(func.count()).select_from(ImportJob).where(
        ImportJob.source_id == source.id, ImportJob.status.in_(ACTIVE)))
    if count >= settings.max_active_imports_per_mall or source_count >= settings.max_active_imports_per_source:
        raise AppError('import_queue_full', 'Дождитесь завершения предыдущих загрузок.', 429,
                       headers={'Retry-After': '30'})


def create_file_import(db, source, content, suffix):
    check_queue_budget(db, source)
    identifier = uuid4()
    path = write_payload(db, source, content, suffix, identifier)
    try:
        job = ImportJob(id=identifier, source_id=source.id, file_path=str(path))
        db.add(job)
        db.commit()
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return job


def cleanup_import_files():
    cutoff = Clock.now() - timedelta(hours=settings.import_file_retention_hours)
    with SessionLocal.begin() as db:
        lock(db, 'import-storage-budget')
        jobs = db.scalars(select(ImportJob).where(ImportJob.status.not_in(ACTIVE),
            ImportJob.finished_at < cutoff,
            ImportJob.file_path.startswith(str(settings.path('upload_dir')) + '/'))
            .limit(100).with_for_update(skip_locked=True)).all()
        for job in jobs:
            path = managed_path(job.file_path)
            if path:
                path.unlink(missing_ok=True)
                job.file_path = None
