import logging
import time
from datetime import timedelta

from redis import Redis
from rq import Queue
from sqlalchemy import or_, select

from app.core.config import Clock, settings
from app.core.db import SessionLocal
from app.models import ImportJob

log = logging.getLogger(__name__)


def dispatch_once():
    from app.modules.integrations.service import schedule_due
    schedule_due()
    queue = Queue('imports', connection=Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2))
    with SessionLocal.begin() as db:
        now = Clock.now()
        jobs = db.scalars(select(ImportJob).where(or_(ImportJob.status == 'queued', (ImportJob.status == 'running') & (ImportJob.lease_until < now))).with_for_update(skip_locked=True)).all()
        for job in jobs:
            if job.status == 'running':
                job.lease_token, job.lease_until = None, None
                job.status = 'queued' if job.attempt_count < 3 else 'failed'
                job.last_enqueued_at = None
                if job.status == 'failed':
                    job.failure_code, job.failure_message, job.finished_at = 'worker_timeout', 'Обработчик не восстановился после трёх попыток', now
                    continue
            if job.last_enqueued_at and job.last_enqueued_at > now - timedelta(seconds=10):
                continue
            try:
                queue.enqueue('app.modules.ingestion.service.process_job', str(job.id), job_timeout=900, result_ttl=60, failure_ttl=3600)
                job.last_enqueued_at = now
            except Exception:
                log.warning('Import transport unavailable; queued jobs remain in PostgreSQL')
                break


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    while True:
        try:
            dispatch_once()
        except Exception:
            log.warning('Dispatcher reconnecting to dependencies')
        time.sleep(2)
