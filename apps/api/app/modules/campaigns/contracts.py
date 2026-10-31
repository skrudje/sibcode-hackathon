from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator, model_validator

from app.contracts import SegmentDefinition, StrictModel
from app.modules.radar.contracts import RadarOptions


class WizardAudience(StrictModel):
    kind: Literal['segment', 'custom', 'radar']
    segment_id: UUID | None = None
    definition: SegmentDefinition | None = None
    name: str | None = Field(default=None, max_length=120)
    opportunity_id: UUID | None = None
    options: RadarOptions | None = None

    @model_validator(mode='after')
    def source(self):
        if self.kind == 'segment':
            valid = self.segment_id and self.definition is None and self.opportunity_id is None and self.options is None and self.name is None
        elif self.kind == 'custom':
            valid = self.definition is not None and self.segment_id is None and self.opportunity_id is None and self.options is None
        else:
            valid = self.opportunity_id and self.segment_id is None and self.definition is None and self.name is None
        if not valid:
            raise ValueError('Выберите один источник аудитории: готовый сегмент, новые условия или возможность радара')
        if self.name is not None:
            self.name = self.name.strip() or None
        return self


class WizardOfferDraft(StrictModel):
    destination_tenant_id: UUID
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default='', max_length=1000)
    valid_from: datetime
    valid_until: datetime
    priority: int = Field(default=80, ge=1, le=100)

    @field_validator('title')
    @classmethod
    def title_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Укажите заголовок предложения')
        return value

    @model_validator(mode='after')
    def dates(self):
        if not self.valid_from.tzinfo or not self.valid_until.tzinfo or self.valid_from >= self.valid_until:
            raise ValueError('Укажите корректный период предложения с часовым поясом')
        return self


class WizardOffer(StrictModel):
    rule_id: UUID | None = None
    draft: WizardOfferDraft | None = None

    @model_validator(mode='after')
    def choice(self):
        if (self.rule_id is None) == (self.draft is None):
            raise ValueError('Выберите действующее предложение или создайте новое')
        return self


class CampaignWizardDraft(StrictModel):
    audience: WizardAudience
    offer: WizardOffer
    name: str = Field(min_length=1, max_length=120)
    channel: Literal['email', 'sms']
    idempotency_key: UUID

    @field_validator('name')
    @classmethod
    def name_not_blank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Укажите название кампании')
        return value


class CampaignWizardCreate(CampaignWizardDraft):
    preview_token: str = Field(pattern=r'^[a-f0-9]{64}$')


class WizardAudiencePreview(StrictModel):
    name: str
    definition: SegmentDefinition
    as_of: datetime
    eligible_count: int
    ineligible_count: int
    unknown_count: int


class WizardRecipient(StrictModel):
    customer_id: UUID
    global_customer_key: str | None
    display_name: str | None
    contact: str
    destination_tenant_id: UUID
    offer_title: str
    reason: str


class CampaignWizardPreview(StrictModel):
    preview_token: str
    audience_name: str
    definition: SegmentDefinition
    destination_name: str
    offer_title: str
    channel: Literal['email', 'sms']
    as_of: datetime
    evaluated_at: datetime
    base_count: int
    eligible_count: int
    unknown_count: int
    excluded_counts: dict[str, int]
    sample: list[WizardRecipient]
    limitations: list[str]


class CampaignWizardResult(StrictModel):
    campaign_id: UUID
    segment_id: UUID
    recommendation_rule_id: UUID
    created: bool
