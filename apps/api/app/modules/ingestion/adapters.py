import json
from pathlib import Path

import polars as pl
from openpyxl import load_workbook

from app.core.errors import AppError

MAX_BYTES = 10 * 1024 * 1024
MAX_ROWS = 10000


def read_rows(kind, path):
    try:
        if kind == 'rest_api':
            value = json.loads(Path(path).read_text())
            rows = value['events']
            if not isinstance(rows, list):
                raise ValueError()
        elif kind == 'crm_csv':
            frame = pl.read_csv(path, infer_schema=False)
            if not {'customer_id', 'event_id', 'event_type', 'event_time'} <= set(frame.columns):
                raise ValueError()
            rows = frame.to_dicts()
        else:
            book = load_workbook(path, read_only=True, data_only=True)
            try:
                iterator = book.active.iter_rows(values_only=True)
                headers = next(iterator)
                if not {'id_клиента', 'id_чека', 'тип_события', 'дата_операции'} <= set(headers):
                    raise ValueError()
                rows = []
                for row in iterator:
                    if len(rows) >= MAX_ROWS:
                        raise AppError('too_many_rows', 'В одном задании допускается до 10 000 строк')
                    rows.append(dict(zip(headers, row)))
            finally:
                book.close()
        if not rows:
            raise AppError('empty_import', 'Источник не содержит записей')
        if len(rows) > MAX_ROWS:
            raise AppError('too_many_rows', 'В одном задании допускается до 10 000 строк')
        return rows
    except AppError:
        raise
    except Exception as exc:
        raise AppError('invalid_file_schema', 'Не удалось прочитать структуру источника. Проверьте шаблон.') from exc


def normalize(kind, row):
    if not isinstance(row, dict):
        raise AppError('missing_required_field', 'Запись должна быть объектом')
    if kind == 'rest_api':
        customer = row.get('customer') or {}
        if not isinstance(customer, dict):
            raise AppError('missing_required_field', 'Нет идентификатора клиента')
        return dict(external_customer_id=customer.get('id'), global_customer_key=customer.get('global_key'), display_name=customer.get('name'), email=customer.get('email'), phone=customer.get('phone'), push_token=customer.get('push_token'), external_event_id=row.get('id'), event_type=row.get('kind'), occurred_at=row.get('timestamp'), amount=row.get('total'), currency=row.get('currency'))
    if kind == 'crm_csv':
        keys = ['customer_id', 'global_customer_key', 'full_name', 'email', 'phone', 'event_id', 'event_type', 'event_time', 'amount', 'currency']
    else:
        keys = ['id_клиента', 'единый_ключ', 'имя', 'email', 'телефон', 'id_чека', 'тип_события', 'дата_операции', 'сумма', 'валюта']
    target = ['external_customer_id', 'global_customer_key', 'display_name', 'email', 'phone', 'external_event_id', 'event_type', 'occurred_at', 'amount', 'currency']
    return {to: (str(row.get(key)).strip() or None) if row.get(key) is not None else None for key, to in zip(keys, target)}
