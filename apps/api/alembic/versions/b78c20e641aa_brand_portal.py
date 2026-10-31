"""Scope brand accounts to one tenant.

Revision ID: b78c20e641aa
Revises: 6bc2e5a19041
"""
from alembic import op
import sqlalchemy as sa

revision = 'b78c20e641aa'
down_revision = '6bc2e5a19041'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('tenant_id', sa.Uuid(), nullable=True))
    op.create_foreign_key('fk_users_tenant_id', 'users', 'tenants', ['tenant_id'], ['id'])
    op.create_check_constraint('ck_user_role_tenant', 'users',
        "(role = 'brand' AND tenant_id IS NOT NULL) OR (role IN ('admin', 'marketer') AND tenant_id IS NULL)")


def downgrade():
    # Refuse a downgrade with brand accounts instead of silently granting them
    # the legacy permissions available to every authenticated user.
    if op.get_bind().execute(sa.text("SELECT EXISTS(SELECT 1 FROM users WHERE role = 'brand')")).scalar():
        raise RuntimeError('Reassign or remove brand accounts before downgrading')
    op.drop_constraint('ck_user_role_tenant', 'users', type_='check')
    op.drop_constraint('fk_users_tenant_id', 'users', type_='foreignkey')
    op.drop_column('users', 'tenant_id')
