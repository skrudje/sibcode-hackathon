"""An explicit synthetic example, imported through the ordinary durable jobs."""
import csv
import json
import shutil
from datetime import timedelta
from uuid import UUID, uuid4

from openpyxl import Workbook

from app.core.config import ROOT, settings
from app.core.errors import AppError
from app.models import ImportJob, Source
from app.modules.segments.service import scoped


def generate_files(reference):
    out = settings.path('demo_dir')
    out.mkdir(parents=True, exist_ok=True)
    dates = {key: (reference - timedelta(days=days)).isoformat() for key, days in [('a', 14), ('b', 10), ('c', 5), ('after', 2)]}

    def person(number, source):
        key = f'R{number:03}'
        return dict(id=f'RADAR-{source}-{key}', global_key=key, name=f'Демо · Посетитель {key}', email=f'radar-{key.lower()}@example.invalid')

    api_events = [dict(id=f'RADAR-A-{i:03}', customer=person(i, 'A'), kind='visit', timestamp=dates['a'], total=None, currency=None) for i in range(1, 61)]
    api_events.append(dict(id='RADAR-A-UNKNOWN', customer=dict(id='RADAR-A-UNKNOWN', global_key=None, name='Демо · Без общего ключа A'), kind='visit', timestamp=dates['a'], total=None, currency=None))
    (out / 'radar_A.json').write_text(json.dumps({'events': api_events}, ensure_ascii=False))

    book = Workbook()
    book.active.append(['id_клиента', 'единый_ключ', 'имя', 'email', 'телефон', 'id_чека', 'тип_события', 'дата_операции', 'сумма', 'валюта'])
    for i in [*range(1, 41), *range(61, 101)]:
        c = person(i, 'B')
        book.active.append([c['id'], c['global_key'], c['name'], c['email'], None, f'RADAR-B-{i:03}', 'purchase', dates['b'], 450, 'RUB'])
    book.active.append(['RADAR-B-UNKNOWN', None, 'Демо · Без общего ключа B', None, None, 'RADAR-B-UNKNOWN', 'purchase', dates['b'], 450, 'RUB'])
    book.save(out / 'radar_B.xlsx')
    book.close()

    for name, numbers, date in [('radar_C.csv', [*range(1, 26), *range(81, 86)], dates['c']), ('radar_C_after.csv', [26], dates['after'])]:
        with (out / name).open('w', encoding='utf-8-sig', newline='') as file:
            writer = csv.writer(file)
            writer.writerow(['customer_id', 'global_customer_key', 'full_name', 'email', 'phone', 'event_id', 'event_type', 'event_time', 'amount', 'currency'])
            for i in numbers:
                c = person(i, 'C')
                writer.writerow([c['id'], c['global_key'], c['name'], c['email'], '', f'RADAR-C-{i:03}', 'purchase', date, '1200.00', 'RUB'])


def enqueue(db, mall_id, stage):
    ids = json.loads((ROOT / 'demo/templates/demo_scenario.json').read_text())['ids']
    if str(mall_id) != ids['mall']:
        raise AppError('not_found', 'Пример доступен только в демонстрационном ТЦ', 404)
    files = [('source_a', 'radar_A.json'), ('source_b', 'radar_B.xlsx'), ('source_c', 'radar_C.csv')] if stage == 'initial' else [('source_c', 'radar_C_after.csv')]
    # Validate ownership before touching files or creating any job.
    for key, _ in files:
        scoped(db, Source, UUID(ids[key]), mall_id)
    directory = settings.path('upload_dir')
    directory.mkdir(parents=True, exist_ok=True)
    created, paths = [], []
    try:
        for key, filename in files:
            identifier = uuid4()
            path = directory / f'{identifier}.{filename.rsplit(".", 1)[-1]}'
            shutil.copyfile(settings.path('demo_dir') / filename, path)
            paths.append(path)
            db.add(ImportJob(id=identifier, source_id=UUID(ids[key]), file_path=str(path)))
            created.append(identifier)
        db.commit()
    except Exception:
        for path in paths:
            path.unlink(missing_ok=True)
        raise
    return dict(job_ids=created, description='Синтетический пример: API JSON, XLSX и CSV; полнота истории не изменяется.' if stage == 'initial' else 'Синтетическая покупка R026 в книжном C.')
