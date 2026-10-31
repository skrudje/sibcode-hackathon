"""Normalize contact identities and index cross-source matching.

Revision ID: 6bc2e5a19041
Revises: 1fb7d7e2393d
"""
import re

from alembic import op
import sqlalchemy as sa

revision = '6bc2e5a19041'
down_revision = '1fb7d7e2393d'
branch_labels = None
depends_on = None


def normalize(channel, value):
    # Frozen v1 normalization: migrations must not change with application code.
    value = value.strip()
    if channel == 'email':
        return value.lower() if len(value) <= 320 and re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value) else None
    value = re.sub(r'[\s().\-–—]', '', value)
    if value.startswith('00'):
        value = '+' + value[2:]
    if re.fullmatch(r'\d{10}', value):
        value = '+7' + value
    elif re.fullmatch(r'[78]\d{10}', value):
        value = '+7' + value[1:]
    return value if re.fullmatch(r'\+[1-9]\d{7,14}', value) else None


def upgrade():
    connection = op.get_bind()
    contacts = connection.execute(sa.text(
        "SELECT id, channel, value FROM customer_contacts WHERE channel IN ('email', 'sms')"
    )).mappings().all()
    for contact in contacts:
        connection.execute(sa.text('UPDATE customer_contacts SET normalized_value=:value WHERE id=:id'),
                           {'id': contact['id'], 'value': normalize(contact['channel'], contact['value'])})
    connection.execute(sa.text("""
        UPDATE customers c SET identity_status = CASE WHEN EXISTS (
            SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = c.id
            AND cc.channel IN ('email', 'sms') AND cc.normalized_value IS NOT NULL
        ) THEN 'verified' ELSE 'source_only' END
    """))
    # Existing profiles/files are retained. Ambiguous historical contacts are
    # reported by ingestion rather than silently merging historical identities.
    op.create_index('ix_contact_identity', 'customer_contacts', ['channel', 'normalized_value'],
                    postgresql_where=sa.text("channel IN ('email', 'sms') AND normalized_value IS NOT NULL"))


def downgrade():
    op.drop_index('ix_contact_identity', table_name='customer_contacts')
