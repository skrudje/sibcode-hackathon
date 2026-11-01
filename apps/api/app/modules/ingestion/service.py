import json
from collections import Counter
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from pydantic import ValidationError
from sqlalchemy import select

from app.contracts import NormalizedEvent
from app.core.config import Clock, settings
from app.core.db import SessionLocal
from app.core.errors import AppError, LeaseLost
from app.models import ImportJob, ImportRowResult, Source
from app.modules.customers.service import ingest_event
from .adapters import MAX_BYTES, normalize, read_rows
from app.modules.integrations.service import fetch_contacts
from .storage import write_payload


def guarded_job(db, job_id, token):
    job = db.scalar(select(ImportJob).where(ImportJob.id == job_id).with_for_update())
    if not job or job.status != 'running' or job.lease_token != token or job.lease_until < Clock.now():
        raise LeaseLost()
    job.heartbeat_at = Clock.now()
    job.lease_until = Clock.now() + timedelta(seconds=60)
    return job


def fetch_api(source_id):
    with SessionLocal() as db:
        source = db.get(Source, source_id)
        if not source or source.kind not in ('rest_api', 'contacts'):
            raise AppError('source_not_allowed', 'Источник не разрешён')
        if source.kind == 'contacts':
            return fetch_contacts(source)
    # Runtime address can change between native development and Compose. It is
    # never supplied by the visitor or taken from untrusted imported data.
    url = settings.mock_source_url
    for attempt in range(3):
        try:
            with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
                with client.stream('GET', url) as response:
                    response.raise_for_status()
                    output = bytearray()
                    for part in response.iter_bytes():
                        output.extend(part)
                        if len(output) > MAX_BYTES:
                            raise AppError('source_too_large', 'API вернул больше 10 MiB')
                    json.loads(output)
                    return bytes(output)
        except (httpx.HTTPError, ValueError) as exc:
            if attempt == 2:
                raise AppError('source_unavailable', 'API источника временно недоступен', 503) from exc


def row_error(exc):
    if isinstance(exc, AppError):
        return exc.code, exc.message
    errors = exc.errors()
    if errors[0]['type'] == 'extra_forbidden':
        return 'unexpected_field', 'Используйте только поля phone, email и time'
    field = str(errors[0]['loc'][0]) if errors[0]['loc'] else ''
    if field in ['occurred_at', 'time']:
        return 'invalid_datetime', 'Некорректная дата; требуется ISO 8601 с часовым поясом'
    if field in ['phone', 'email']:
        return 'invalid_contact', 'Проверьте телефон или email'
    if not field and ('phone' in errors[0]['msg'] or 'email' in errors[0]['msg']):
        return 'invalid_contact', 'Нужен корректный телефон или email'
    if field in ['amount', 'currency'] or not field:
        return 'invalid_amount', 'Проверьте сумму, валюту и тип события'
    if field == 'event_type':
        return 'invalid_event_type', 'Поддерживаются visit, purchase и booking'
    return 'missing_required_field', f'Проверьте обязательное поле {field}'


def process_job(job_id):
    job_id = UUID(str(job_id))
    token = uuid4()
    with SessionLocal.begin() as db:
        job = db.scalar(select(ImportJob).where(ImportJob.id == job_id).with_for_update())
        if not job or job.status != 'queued':
            return
        job.status, job.lease_token = 'running', token
        job.attempt_count += 1
        job.lease_until = Clock.now() + timedelta(seconds=60)
        job.heartbeat_at = Clock.now()
        source_id, file_path = job.source_id, job.file_path
        source_kind = db.get(Source, source_id).kind
    try:
        if not file_path:
            content = fetch_api(source_id)
            path = None
            try:
                with SessionLocal.begin() as db:
                    job = guarded_job(db, job_id, token)
                    path = write_payload(db, db.get(Source, source_id), content, '.json', f'{job_id}-{token}')
                    file_path = str(path)
                    job.file_path = file_path
            except Exception:
                if path:
                    path.unlink(missing_ok=True)
                raise
        rows = read_rows(source_kind, file_path)
        with SessionLocal.begin() as db:
            guarded_job(db, job_id, token).total_rows = len(rows)
        for number, raw in enumerate(rows, 1):
            with SessionLocal.begin() as db:
                job = guarded_job(db, job_id, token)
                if db.scalar(select(ImportRowResult.id).where(ImportRowResult.job_id == job_id, ImportRowResult.row_number == number)):
                    continue
                status, event_id, code, message = 'rejected', None, None, None
                try:
                    with db.begin_nested():
                        data = NormalizedEvent.model_validate(normalize(source_kind, raw))
                        status, event_id = ingest_event(db, db.get(Source, source_id), data)
                except (ValidationError, AppError) as exc:
                    code, message = row_error(exc)
                db.add(ImportRowResult(job_id=job_id, row_number=number, status=status, error_code=code, error_message=message, event_id=event_id))
                db.flush()
                field = f'{status}_rows'
                setattr(job, field, getattr(job, field) + 1)
        with SessionLocal.begin() as db:
            job = guarded_job(db, job_id, token)
            job.status = 'succeeded' if not job.rejected_rows else ('completed_with_errors' if job.accepted_rows + job.duplicate_rows else 'failed')
            job.finished_at, job.lease_until = Clock.now(), None
            if job.status == 'failed':
                job.failure_code, job.failure_message = 'all_rows_rejected', 'Все строки отклонены; откройте отчёт'
            else:
                db.get(Source, source_id).last_success_at = Clock.now()
            source = db.get(Source, source_id)
            if source_kind == 'contacts':
                value = dict(source.config or {})
                value['last_error'] = 'Есть отклонённые записи. Исправьте данные в API и повторите загрузку; позиция синхронизации сохранена.' if job.rejected_rows else None
                if not job.rejected_rows and Path(file_path).suffix == '.json':
                    payload = json.loads(Path(file_path).read_text())
                    value['cursor'] = payload.get('next_cursor')
                    # Coverage may advance only on an explicit provider declaration.
                    if 'coverage_from' in payload or 'coverage_to' in payload:
                        from app.modules.sources.contracts import SourceCoveragePatch
                        from app.modules.sources.service import update_coverage
                        update_coverage(db, source.id, source.mall_id, SourceCoveragePatch.model_validate({
                            'coverage_from': payload.get('coverage_from'), 'coverage_to': payload.get('coverage_to'),
                            'covered_event_types': ['interaction']}))
                source.config = value
    except LeaseLost:
        return
    except Exception as exc:
        with SessionLocal.begin() as db:
            try:
                job = guarded_job(db, job_id, token)
            except LeaseLost:
                return
            retry = not isinstance(exc, AppError) or exc.status == 503
            job.status = 'queued' if retry and job.attempt_count < 3 else 'failed'
            job.lease_until, job.lease_token, job.last_enqueued_at = None, None, None
            job.failure_code = exc.code if isinstance(exc, AppError) else 'processing_error'
            job.failure_message = exc.message if isinstance(exc, AppError) else 'Обработка прервана; выполняется восстановление'
            source = db.get(Source, source_id)
            if source and source.kind == 'contacts':
                source.config = {**source.config, 'last_error': job.failure_message}
            if job.status == 'failed':
                job.finished_at = Clock.now()
