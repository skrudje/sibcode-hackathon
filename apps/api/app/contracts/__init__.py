from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.config import Clock

EventType = Literal['visit', 'purchase', 'booking', 'interaction']
Channel = Literal['email', 'sms', 'push']


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class LoginRequest(StrictModel):
    email: str
    password: str = Field(min_length=1)


class NormalizedEvent(StrictModel):
    external_customer_id: str = Field(min_length=1, max_length=200)
    global_customer_key: str | None = Field(default=None, max_length=200)
    display_name: str | None = Field(default=None, max_length=300)
    email: str | None = Field(default=None, max_length=1000)
    phone: str | None = Field(default=None, max_length=1000)
    push_token: str | None = Field(default=None, max_length=1000)
    external_event_id: str = Field(min_length=1, max_length=200)
    event_type: EventType
    occurred_at: datetime
    amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    currency: Literal['RUB'] | None = None
    metadata: dict = Field(default_factory=dict)

    @field_validator('*', mode='before')
    @classmethod
    def trim_strings(cls, value):
        return (value.strip() or None) if isinstance(value, str) else value

    @field_validator('occurred_at')
    @classmethod
    def aware_date(cls, value):
        if value.tzinfo is None or value > Clock.now() + timedelta(minutes=5):
            raise ValueError('Нужна дата с часовым поясом, не из будущего')
        return value.astimezone(timezone.utc)

    @model_validator(mode='after')
    def money(self):
        if self.event_type == 'purchase' and (self.amount is None or self.currency is None):
            raise ValueError('Для покупки нужны сумма и валюта RUB')
        if self.event_type == 'visit' and (self.amount is not None or self.currency is not None):
            raise ValueError('Визит не содержит сумму')
        if (self.amount is None) != (self.currency is None):
            raise ValueError('Сумма и валюта заполняются вместе')
        return self


class EventCondition(StrictModel):
    tenant_id: UUID
    event_types: list[EventType] = Field(min_length=1, max_length=4)

    @field_validator('event_types')
    @classmethod
    def unique(cls, value):
        if len(value) != len(set(value)):
            raise ValueError('Типы событий не должны повторяться')
        return value


class SegmentDefinition(StrictModel):
    lookback_days: int = Field(ge=1, le=365)
    include_all: list[EventCondition] = Field(min_length=1, max_length=10)
    exclude_any: list[EventCondition] = Field(max_length=9)
    require_verified_identity: Literal[True] = True
    require_complete_coverage: Literal[True] = True

    @model_validator(mode='after')
    def consistency(self):
        if len(self.include_all) + len(self.exclude_any) > 10:
            raise ValueError('Не больше десяти условий')
        for group in [self.include_all, self.exclude_any]:
            if len({x.tenant_id for x in group}) != len(group):
                raise ValueError('Арендатор повторяется внутри группы условий')
        included = {(x.tenant_id, t) for x in self.include_all for t in x.event_types}
        if included.intersection((x.tenant_id, t) for x in self.exclude_any for t in x.event_types):
            raise ValueError('Условия включения и исключения противоречат друг другу')
        return self


class SegmentWrite(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    definition: SegmentDefinition


class RecommendationRuleWrite(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    segment_id: UUID
    destination_tenant_id: UUID
    priority: int = Field(ge=1, le=100)
    offer_title: str = Field(min_length=1, max_length=160)
    offer_description: str = Field(max_length=1000)
    valid_from: datetime
    valid_until: datetime
    is_active: bool

    @model_validator(mode='after')
    def dates(self):
        if not self.valid_from.tzinfo or not self.valid_until.tzinfo or self.valid_from >= self.valid_until:
            raise ValueError('Нужен корректный период с часовым поясом')
        return self


class CampaignWrite(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    segment_id: UUID
    recommendation_rule_id: UUID
    channel: Channel
