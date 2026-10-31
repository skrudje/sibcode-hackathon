from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, LargeBinary, Numeric, String, Text, UniqueConstraint, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.config import Clock
from app.core.db import Base


class Identified:
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)


class Mall(Identified, Base):
    __tablename__ = 'malls'
    name: Mapped[str] = mapped_column(String(200))
    timezone: Mapped[str] = mapped_column(String(80), default='Asia/Krasnoyarsk')
    demo_reference_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class User(Identified, Base):
    __tablename__ = 'users'
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(20), default='marketer')
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class AuthSession(Identified, Base):
    __tablename__ = 'sessions'
    user_id: Mapped[UUID] = mapped_column(ForeignKey('users.id'))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Tenant(Identified, Base):
    __tablename__ = 'tenants'
    __table_args__ = (UniqueConstraint('mall_id', 'code'),)
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    code: Mapped[str] = mapped_column(String(10))
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(80))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Source(Identified, Base):
    __tablename__ = 'sources'
    __table_args__ = (UniqueConstraint('tenant_id'), CheckConstraint('coverage_from IS NULL OR coverage_from <= coverage_to'))
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    tenant_id: Mapped[UUID] = mapped_column(ForeignKey('tenants.id'))
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(30))
    covered_event_types: Mapped[list] = mapped_column(JSONB, default=list)
    coverage_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    coverage_to: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)


class Customer(Identified, Base):
    __tablename__ = 'customers'
    __table_args__ = (UniqueConstraint('mall_id', 'global_customer_key'),)
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    global_customer_key: Mapped[str | None] = mapped_column(String(200))
    display_name: Mapped[str | None] = mapped_column(String(300))
    identity_status: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)


class ExternalIdentity(Identified, Base):
    __tablename__ = 'external_identities'
    __table_args__ = (UniqueConstraint('source_id', 'external_customer_id'),)
    source_id: Mapped[UUID] = mapped_column(ForeignKey('sources.id'))
    external_customer_id: Mapped[str] = mapped_column(String(200))
    customer_id: Mapped[UUID] = mapped_column(ForeignKey('customers.id'), index=True)


class CustomerContact(Identified, Base):
    __tablename__ = 'customer_contacts'
    __table_args__ = (UniqueConstraint('customer_id', 'source_id', 'external_customer_id', 'channel', 'value'),)
    customer_id: Mapped[UUID] = mapped_column(ForeignKey('customers.id'), index=True)
    source_id: Mapped[UUID] = mapped_column(ForeignKey('sources.id'))
    external_customer_id: Mapped[str] = mapped_column(String(200))
    channel: Mapped[str] = mapped_column(String(10))
    value: Mapped[str] = mapped_column(String(1000))
    normalized_value: Mapped[str | None] = mapped_column(String(1000))


class Event(Identified, Base):
    __tablename__ = 'events'
    __table_args__ = (UniqueConstraint('source_id', 'external_event_id'), CheckConstraint('amount IS NULL OR amount >= 0'), Index('ix_event_customer_time', 'customer_id', 'occurred_at'), Index('ix_event_tenant_type_time', 'tenant_id', 'event_type', 'occurred_at', 'customer_id'))
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    tenant_id: Mapped[UUID] = mapped_column(ForeignKey('tenants.id'))
    source_id: Mapped[UUID] = mapped_column(ForeignKey('sources.id'))
    customer_id: Mapped[UUID] = mapped_column(ForeignKey('customers.id'))
    external_event_id: Mapped[str] = mapped_column(String(200))
    event_type: Mapped[str] = mapped_column(String(20))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    currency: Mapped[str | None] = mapped_column(String(3))
    payload_hash: Mapped[str] = mapped_column(String(64))
    metadata_json: Mapped[dict] = mapped_column('metadata', JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)


class ImportJob(Identified, Base):
    __tablename__ = 'import_jobs'
    __table_args__ = (Index('ix_import_status_lease', 'status', 'lease_until'),)
    source_id: Mapped[UUID] = mapped_column(ForeignKey('sources.id'))
    status: Mapped[str] = mapped_column(String(30), default='queued')
    file_path: Mapped[str | None] = mapped_column(Text)
    total_rows: Mapped[int | None] = mapped_column(Integer)
    accepted_rows: Mapped[int] = mapped_column(Integer, default=0)
    duplicate_rows: Mapped[int] = mapped_column(Integer, default=0)
    rejected_rows: Mapped[int] = mapped_column(Integer, default=0)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[UUID | None] = mapped_column(Uuid)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_enqueued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(80))
    failure_message: Mapped[str | None] = mapped_column(Text)


class ImportRowResult(Identified, Base):
    __tablename__ = 'import_row_results'
    __table_args__ = (UniqueConstraint('job_id', 'row_number'),)
    job_id: Mapped[UUID] = mapped_column(ForeignKey('import_jobs.id'), index=True)
    row_number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20))
    error_code: Mapped[str | None] = mapped_column(String(80))
    error_message: Mapped[str | None] = mapped_column(Text)
    event_id: Mapped[UUID | None] = mapped_column(ForeignKey('events.id'))


class Segment(Identified, Base):
    __tablename__ = 'segments'
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    name: Mapped[str] = mapped_column(String(120))
    definition: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now, onupdate=Clock.now)


class RecommendationRule(Identified, Base):
    __tablename__ = 'recommendation_rules'
    __table_args__ = (CheckConstraint('priority BETWEEN 1 AND 100'), CheckConstraint('valid_from < valid_until'))
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    name: Mapped[str] = mapped_column(String(120))
    segment_id: Mapped[UUID] = mapped_column(ForeignKey('segments.id'))
    destination_tenant_id: Mapped[UUID] = mapped_column(ForeignKey('tenants.id'))
    priority: Mapped[int] = mapped_column(Integer)
    offer_title: Mapped[str] = mapped_column(String(160))
    offer_description: Mapped[str] = mapped_column(Text)
    valid_from: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Campaign(Identified, Base):
    __tablename__ = 'campaigns'
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'))
    name: Mapped[str] = mapped_column(String(120))
    segment_id: Mapped[UUID] = mapped_column(ForeignKey('segments.id'))
    recommendation_rule_id: Mapped[UUID] = mapped_column(ForeignKey('recommendation_rules.id'))
    channel: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)


class Export(Identified, Base):
    __tablename__ = 'exports'
    __table_args__ = (UniqueConstraint('campaign_id', 'idempotency_key'),)
    campaign_id: Mapped[UUID] = mapped_column(ForeignKey('campaigns.id'))
    idempotency_key: Mapped[UUID] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(String(10), default='ready')
    recipient_count: Mapped[int] = mapped_column(Integer)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    file_content: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)


class CampaignRecipient(Identified, Base):
    __tablename__ = 'campaign_recipients'
    __table_args__ = (UniqueConstraint('campaign_id', 'channel', 'contact_normalized'),)
    export_id: Mapped[UUID] = mapped_column(ForeignKey('exports.id'))
    campaign_id: Mapped[UUID] = mapped_column(ForeignKey('campaigns.id'))
    customer_id: Mapped[UUID] = mapped_column(ForeignKey('customers.id'))
    channel: Mapped[str] = mapped_column(String(10))
    contact_normalized: Mapped[str] = mapped_column(String(1000))
    exported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=Clock.now)


class ContactChannelState(Base):
    __tablename__ = 'contact_channel_states'
    mall_id: Mapped[UUID] = mapped_column(ForeignKey('malls.id'), primary_key=True)
    channel: Mapped[str] = mapped_column(String(10), primary_key=True)
    contact_normalized: Mapped[str] = mapped_column(String(1000), primary_key=True)
    last_exported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
