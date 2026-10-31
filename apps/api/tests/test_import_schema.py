import csv
import io
from datetime import timedelta

import pytest
from openpyxl import Workbook

from app.core.config import Clock
from app.core.errors import AppError
from app.modules.ingestion.adapters import normalize, read_rows
from app.modules.ingestion.service import process_job


HEADERS = {
    'crm_csv': ['customer_id', 'event_id', 'event_type', 'event_time'],
    'pos_xlsx': ['id_клиента', 'id_чека', 'тип_события', 'дата_операции'],
}


def file_bytes(kind, headers, rows=()):
    if kind == 'crm_csv':
        output = io.StringIO(newline='')
        writer = csv.writer(output)
        writer.writerow(headers)
        writer.writerows(rows)
        return output.getvalue().encode('utf-8-sig')
    workbook = Workbook()
    workbook.active.append(headers)
    for row in rows:
        workbook.active.append(row)
    output = io.BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


def read_content(tmp_path, kind, headers, rows=()):
    path = tmp_path / ('input.csv' if kind == 'crm_csv' else 'input.xlsx')
    path.write_bytes(file_bytes(kind, headers, rows))
    return read_rows(kind, path)


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_lists_all_missing_required_columns(tmp_path, kind):
    headers = HEADERS[kind]
    with pytest.raises(AppError) as raised:
        read_content(tmp_path, kind, headers[:2], [['customer', 'event']])
    assert raised.value.code == 'invalid_file_schema'
    assert 'Отсутствуют обязательные колонки' in raised.value.message
    assert all(name in raised.value.message for name in headers[2:])
    assert [d['field'] for d in raised.value.details] == headers[2:]


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
@pytest.mark.parametrize('duplicate_optional', [False, True])
def test_rejects_duplicate_headers_before_parser_can_rename_or_overwrite_them(tmp_path, kind, duplicate_optional):
    name = 'email' if duplicate_optional else HEADERS[kind][1]
    headers = HEADERS[kind] + (['email'] if duplicate_optional else []) + [f' {name} ']
    with pytest.raises(AppError) as raised:
        read_content(tmp_path, kind, headers, [['x'] * len(headers)])
    assert raised.value.code == 'invalid_file_schema'
    assert 'Повторяются колонки: ' + name in raised.value.message
    assert 'Отсутствуют' not in raised.value.message


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_missing_and_repeated_headers_are_reported_together(tmp_path, kind):
    name = HEADERS[kind][0]
    with pytest.raises(AppError) as raised:
        read_content(tmp_path, kind, [name, name], [['a', 'b']])
    assert 'Повторяются колонки: ' + name in raised.value.message
    assert all(column in raised.value.message for column in HEADERS[kind][1:])


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_blank_header_has_actionable_column_number(tmp_path, kind):
    with pytest.raises(AppError) as raised:
        read_content(tmp_path, kind, HEADERS[kind] + [''], [['x'] * 5])
    assert 'Пустые заголовки в колонках: 5' in raised.value.message


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_whitespace_and_utf8_bom_do_not_change_identifiers(tmp_path, kind):
    rows = read_content(tmp_path, kind, [f' {h} ' for h in HEADERS[kind]], [
        ['0007', '000001', 'visit', (Clock.now() - timedelta(days=1)).isoformat()],
    ])
    event = normalize(kind, rows[0])
    assert (event['external_customer_id'], event['external_event_id']) == ('0007', '000001')


def test_semicolon_csv_explains_delimiter_and_missing_columns(tmp_path):
    path = tmp_path / 'semicolon.csv'
    path.write_text('customer_id;event_id;event_type;event_time\na;b;visit;2026-01-01T00:00:00Z\n')
    with pytest.raises(AppError) as raised:
        read_rows('crm_csv', path)
    assert 'Используйте запятую' in raised.value.message
    assert 'event_time' in raised.value.message


@pytest.mark.parametrize('kind,content,expected', [
    ('crm_csv', b'\xff\xfe\x00', 'UTF-8'),
    ('pos_xlsx', b'not a workbook', 'XLSX'),
    ('crm_csv', b'', 'CSV пустой'),
])
def test_unreadable_files_have_format_specific_errors(tmp_path, kind, content, expected):
    path = tmp_path / 'invalid'
    path.write_bytes(content)
    with pytest.raises(AppError) as raised:
        read_rows(kind, path)
    assert expected in raised.value.message


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_header_without_event_rows_is_empty_import(tmp_path, kind):
    with pytest.raises(AppError) as raised:
        read_content(tmp_path, kind, HEADERS[kind])
    assert raised.value.code == 'empty_import'


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_schema_error_reaches_job_message_without_retry_or_source_changes(client, kind):
    original = next(s for s in client.get('/api/v1/sources').json()['items'] if s['kind'] == kind)
    missing = HEADERS[kind][2:]
    duplicated = HEADERS[kind][0]
    filename = 'input.csv' if kind == 'crm_csv' else 'input.xlsx'
    payload = file_bytes(kind, [duplicated, duplicated], [['customer', 'event']])
    response = client.post(f'/api/v1/sources/{original["id"]}/imports', files={'file': (filename, payload)})
    assert response.status_code == 202
    job_id = response.json()['id']
    process_job(job_id)
    job = client.get(f'/api/v1/imports/{job_id}').json()
    assert job['status'] == 'failed' and job['attempt_count'] == 1
    assert job['failure_code'] == 'invalid_file_schema'
    assert duplicated in job['failure_message'] and all(name in job['failure_message'] for name in missing)
    assert job['accepted_rows'] == job['duplicate_rows'] == job['rejected_rows'] == 0
    current = next(s for s in client.get('/api/v1/sources').json()['items'] if s['id'] == original['id'])
    assert current == original
    summary = client.get('/api/v1/summary').json()
    assert summary['event_count'] == summary['customer_count'] == 0


@pytest.mark.parametrize('kind', ['crm_csv', 'pos_xlsx'])
def test_own_file_import_does_not_infer_or_extend_explicit_coverage(client, kind):
    original = next(s for s in client.get('/api/v1/sources').json()['items'] if s['kind'] == kind)
    # An explicit unknown period stays unknown even after a valid successful import.
    patch = client.patch(f'/api/v1/sources/{original["id"]}/coverage', json={
        'coverage_from': None, 'coverage_to': None, 'covered_event_types': [],
    })
    assert patch.status_code == 200
    types = ['global_customer_key', 'amount', 'currency'] if kind == 'crm_csv' else ['единый_ключ', 'сумма', 'валюта']
    headers = HEADERS[kind] + types
    content = file_bytes(kind, headers, [[
        '0007', '000001', 'purchase', (Clock.now() - timedelta(days=1)).isoformat(), 'MY001', '120.50', 'RUB',
    ]])
    filename = 'my.csv' if kind == 'crm_csv' else 'my.xlsx'
    response = client.post(f'/api/v1/sources/{original["id"]}/imports', files={'file': (filename, content)})
    assert response.status_code == 202
    process_job(response.json()['id'])
    job = client.get(f'/api/v1/imports/{response.json()["id"]}').json()
    assert job['status'] == 'succeeded' and job['accepted_rows'] == 1
    current = next(s for s in client.get('/api/v1/sources').json()['items'] if s['id'] == original['id'])
    assert current['coverage_from'] is current['coverage_to'] is None
    assert current['covered_event_types'] == [] and current['last_success_at'] is not None
    customer = client.get('/api/v1/customers?q=MY001').json()['items'][0]
    profile = client.get(f'/api/v1/customers/{customer["id"]}').json()
    assert profile['external_identities'][0]['external_customer_id'] == '0007'
    events = client.get(f'/api/v1/customers/{customer["id"]}/events').json()['items']
    assert events[0]['external_event_id'] == '000001'
