from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from app.contracts import Channel, EventType, SegmentDefinition, StrictModel


class RadarOptions(StrictModel):
    lookback_days: int = Field(default=90, ge=1, le=365)
    min_shared_customers: int = Field(default=3, ge=2, le=1000)
    min_lift: float = Field(default=1.1, ge=1.01, le=100, allow_inf_nan=False)


class RadarNode(StrictModel):
    tenant_id: UUID
    code: str
    name: str
    category: str
    event_types: list[EventType]
    coverage_from: datetime | None
    coverage_to: datetime | None
    coverage_status: Literal['ready', 'not_loaded', 'incomplete_history', 'no_event_types']


class RadarOffer(StrictModel):
    rule_id: UUID
    title: str
    description: str
    valid_until: datetime


class RadarOpportunity(StrictModel):
    id: UUID
    origins: list[RadarNode]
    destination: RadarNode
    definition: SegmentDefinition
    as_of: datetime
    window_start: datetime
    population_count: int
    cohort_count: int
    shared_count: int
    destination_count: int
    candidate_count: int
    unknown_count: int
    conditional_rate: float
    baseline_rate: float
    lift: float
    explanation: str
    offers: list[RadarOffer]


class RadarReport(StrictModel):
    evaluated_at: datetime
    options: RadarOptions
    customer_count: int
    verified_customer_count: int
    unknown_customer_count: int
    nodes: list[RadarNode]
    opportunities: list[RadarOpportunity]
    total_opportunity_count: int
    empty_reason: Literal['no_data', 'insufficient_history', 'insufficient_support'] | None


class RadarEvidence(StrictModel):
    event_id: UUID
    tenant_id: UUID
    event_type: EventType
    occurred_at: datetime


class RadarCustomer(StrictModel):
    id: UUID
    global_customer_key: str | None
    display_name: str | None
    observed_events: list[RadarEvidence]


class RadarAudience(StrictModel):
    opportunity: RadarOpportunity
    items: list[RadarCustomer]
    total: int
    limit: int
    offset: int
    shared_examples: list[RadarCustomer]


class RadarCampaignWrite(RadarOptions):
    opportunity_id: UUID
    offer_rule_id: UUID
    channel: Channel
    name: str = Field(min_length=1, max_length=120)
    idempotency_key: UUID

    @field_validator('name')
    @classmethod
    def nonblank_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('Укажите название кампании')
        return value


class RadarCampaignResult(StrictModel):
    campaign_id: UUID
    segment_id: UUID
    recommendation_rule_id: UUID
    created: bool


class RadarDemoWrite(StrictModel):
    stage: Literal['initial', 'followup'] = 'initial'


class RadarDemoResult(StrictModel):
    job_ids: list[UUID]
    description: str
