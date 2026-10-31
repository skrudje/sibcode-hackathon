from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, field_validator, model_validator

from app.contracts import StrictModel
from app.core.config import Clock
from app.core.contacts import normalize_contact


class ContactRecord(StrictModel):
    phone: str | None = Field(default=None, max_length=100)
    email: str | None = Field(default=None, max_length=320)
    time: datetime

    @field_validator('phone', 'email', mode='before')
    @classmethod
    def trim(cls, value):
        return (value.strip() or None) if isinstance(value, str) else value

    @field_validator('time', mode='before')
    @classmethod
    def timestamp(cls, value):
        if not isinstance(value, (str, datetime)):
            raise ValueError('Укажите время ISO 8601 с часовым поясом')
        return value

    @field_validator('time')
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None or value > Clock.now() + timedelta(minutes=5):
            raise ValueError('Нужно время с часовым поясом, не из будущего')
        return value.astimezone(timezone.utc)

    @model_validator(mode='after')
    def contacts(self):
        for field, channel in [('phone', 'sms'), ('email', 'email')]:
            value = getattr(self, field)
            if value:
                normalized = normalize_contact(channel, value)
                if not normalized:
                    raise ValueError(f'Некорректный {field}')
                setattr(self, field, normalized)
        if not self.phone and not self.email:
            raise ValueError('Нужен хотя бы один контакт: телефон или email')
        return self


class IntegrationWrite(StrictModel):
    api_url: str = Field(default='', max_length=2000)
    interval_minutes: int = Field(default=15, ge=1, le=1440)
    enabled: bool = False
    credential_env: str | None = Field(default=None, pattern=r'^CONNECTOR_SECRET_[A-Z0-9_]{1,100}$')
    coverage_from: AwareDatetime | None = None
    coverage_to: AwareDatetime | None = None


class TenantWrite(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=80)

    @field_validator('name', 'category')
    @classmethod
    def nonblank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Заполните поле')
        return value


class UserWrite(StrictModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=12, max_length=256)
    role: Literal['marketer', 'admin', 'brand'] = 'marketer'
    tenant_id: UUID | None = None

    @model_validator(mode='after')
    def tenant_assignment(self):
        if (self.role == 'brand') != (self.tenant_id is not None):
            raise ValueError('Для представителя бренда выберите магазин; для сотрудника УК магазин не задаётся')
        return self

    @field_validator('email')
    @classmethod
    def email_format(cls, value):
        email = normalize_contact('email', value)
        if not email:
            raise ValueError('Некорректный email')
        return email


class UserPatch(StrictModel):
    role: Literal['marketer', 'admin', 'brand']
    is_active: bool
    tenant_id: UUID | None = None

    @model_validator(mode='after')
    def tenant_assignment(self):
        if (self.role == 'brand') != (self.tenant_id is not None):
            raise ValueError('Для представителя бренда выберите магазин; для сотрудника УК магазин не задаётся')
        return self


class IntegrationInfo(StrictModel):
    id: UUID
    tenant_id: UUID
    tenant_name: str
    category: str
    name: str
    kind: str
    enabled: bool
    interval_minutes: int
    last_success_at: datetime | None
    next_sync_at: datetime | None
    last_error: str | None
    coverage_from: datetime | None
    coverage_to: datetime | None
    covered_event_types: list[str]
    has_credentials: bool
    has_api: bool
    api_url: str | None = None
    credential_env: str | None = None


class IntegrationPage(StrictModel):
    items: list[IntegrationInfo]
    total: int


class ConnectionTest(StrictModel):
    status: Literal['ok'] = 'ok'
    record_count: int
    message: str


class TenantInfo(StrictModel):
    id: UUID
    code: str
    name: str
    category: str
    is_active: bool


class TeamMember(StrictModel):
    id: UUID
    email: str
    role: Literal['admin', 'marketer', 'brand']
    is_active: bool
    tenant_id: UUID | None


class TeamPage(StrictModel):
    items: list[TeamMember]
    total: int
