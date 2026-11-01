"""Read-only previews and selected-column imports into the existing worker.

The complete file is parsed in memory for preview. Only the mapped phone,
email and time columns are persisted, as a canonical contacts CSV. File imports
therefore cannot overwrite an API cursor or declare source coverage.
"""
import csv
import io
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from pydantic import ValidationError
from sqlalchemy import select

from app.core.errors import AppError
from app.core.spreadsheets import MAX_COLUMNS, spreadsheet
from app.models import Mall, Source, Tenant
from app.modules.ingestion.adapters import MAX_ROWS
from app.modules.ingestion.service import row_error
from app.modules.integrations.contracts import ContactRecord

def context(db, user):
    tenant = db.scalar(select(Tenant).where(Tenant.id == user.tenant_id,
        Tenant.mall_id == user.mall_id, Tenant.is_active.is_(True)))
    source = db.scalar(select(Source).where(Source.tenant_id == user.tenant_id, Source.mall_id == user.mall_id))
    if not tenant or not source or source.kind != 'contacts':
        raise AppError('brand_unavailable', 'Администратор должен назначить активный магазин с источником нового формата', 403)
    mall = db.get(Mall, user.mall_id)
    return source, dict(tenant_id=tenant.id, tenant_name=tenant.name, source_id=source.id, timezone=mall.timezone)


def validate_assignment(db, tenant_id, mall_id):
    if tenant_id is None:
        return
    tenant = db.scalar(select(Tenant).where(Tenant.id == tenant_id, Tenant.mall_id == mall_id, Tenant.is_active.is_(True)))
    source = db.scalar(select(Source).where(Source.tenant_id == tenant_id, Source.mall_id == mall_id))
    if not tenant or not source or source.kind != 'contacts':
        raise AppError('invalid_brand_tenant', 'Выберите активный магазин своего ТЦ с источником нового формата')


def cell(value):
    if value is None:
        return ''
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def read_table(filename, content):
    extension = Path(filename or '').suffix.lower()
    sheet_name, encoding = None, None
    try:
        if extension == '.csv':
            try:
                text, encoding = content.decode('utf-8-sig'), 'UTF-8'
            except UnicodeDecodeError:
                text, encoding = content.decode('cp1251'), 'Windows-1251'
            try:
                delimiter = csv.Sniffer().sniff(text[:65536], delimiters=',;\t').delimiter
            except csv.Error:
                delimiter = ','
            iterator = csv.reader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True)
            return collect(iterator), sheet_name, encoding
        if extension != '.xlsx':
            raise AppError('unsupported_file', 'Выберите CSV или Excel XLSX', 415)
        with spreadsheet(content) as book:
            sheet = book.active
            sheet_name = sheet.title
            return collect(sheet.iter_rows(values_only=True)), sheet_name, encoding
    except AppError:
        raise
    except Exception as exc:
        raise AppError('invalid_file_schema', 'Не удалось прочитать таблицу. Проверьте CSV или книгу XLSX с заголовками в первой строке.') from exc


def collect(iterator):
    headers = next(iterator, None)
    if not headers or not 1 <= len(headers) <= MAX_COLUMNS:
        raise AppError('invalid_file_schema', 'Первая строка должна содержать от 1 до 200 заголовков')
    names = [cell(value)[:160] or f'Колонка {i + 1}' for i, value in enumerate(headers)]
    rows = []
    for number, row in enumerate(iterator, 1):
        # Bound even a sparse/malicious worksheet with millions of empty rows.
        if number > MAX_ROWS:
            raise AppError('too_many_rows', 'В одном файле допускается до 10 000 строк данных')
        if len(row) > len(names) and any(cell(v) for v in row[len(names):]):
            raise AppError('invalid_file_schema', 'В строке больше полей, чем заголовков')
        values = [cell(value) for value in row[:len(names)]]
        values += [''] * (len(names) - len(values))
        if any(values):
            rows.append(values)
    if not rows:
        raise AppError('empty_import', 'В таблице нет строк данных')
    return names, rows


def time_value(value, timezone):
    if not value:
        return value
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        parsed = None
        for pattern in ['%d.%m.%Y %H:%M:%S', '%d.%m.%Y %H:%M', '%d.%m.%Y']:
            try:
                parsed = datetime.strptime(value, pattern)
                break
            except ValueError:
                pass
        if parsed is None:
            return value  # Existing row validation will report the bad date.
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(timezone))
    return parsed.isoformat()


def preview(table, timezone, mapping=None, sheet_name=None, encoding=None):
    names, rows = table
    result = dict(columns=[dict(index=i, name=name, examples=[row[i][:160] for row in rows[:3]])
        for i, name in enumerate(names)], total_rows=len(rows), sheet_name=sheet_name, encoding=encoding,
        timezone=timezone, mapping=mapping, valid_rows=None, invalid_rows=None, sample=[], errors=[])
    records = []
    if mapping is None:
        return result, records
    if any(index is not None and index >= len(names) for index in mapping.model_dump().values()):
        raise AppError('invalid_mapping', 'Выбранная колонка отсутствует в таблице')
    invalid_rows = 0
    for number, row in enumerate(rows, 1):
        record = {key: row[index] or None if index is not None else None for key, index in mapping.model_dump().items()}
        record['time'] = time_value(record['time'], timezone)
        error = None
        try:
            record = ContactRecord.model_validate(record).model_dump(mode='json')
        except ValidationError as exc:
            _, error = row_error(exc)
            invalid_rows += 1
            if len(result['errors']) < 20:
                result['errors'].append(dict(row_number=number, message=error))
        if len(result['sample']) < 10:
            result['sample'].append(dict(row_number=number, **record, error=error))
        records.append(record)
    result['invalid_rows'] = invalid_rows
    result['valid_rows'] = len(records) - result['invalid_rows']
    return result, records


def canonical_csv(records):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=['phone', 'email', 'time'])
    writer.writeheader()
    writer.writerows(records)
    return output.getvalue().encode('utf-8-sig')
