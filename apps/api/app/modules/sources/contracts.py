from datetime import datetime, timezone

from pydantic import AwareDatetime, Field, field_validator, model_validator

from app.contracts import EventType, StrictModel


class SourceCoveragePatch(StrictModel):
    coverage_from: AwareDatetime | None = None
    coverage_to: AwareDatetime | None = None
    covered_event_types: list[EventType] | None = Field(default=None, max_length=4)

    @field_validator('coverage_from', 'coverage_to', mode='before')
    @classmethod
    def timestamp_format(cls, value):
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError('Нужна дата ISO 8601 с часовым поясом либо null')
        return value

    @field_validator('coverage_from', 'coverage_to')
    @classmethod
    def utc(cls, value):
        return value.astimezone(timezone.utc) if value is not None else None

    @field_validator('covered_event_types')
    @classmethod
    def unique_event_types(cls, value):
        # The default None means "not supplied"; an explicit null is invalid.
        if value is None:
            raise ValueError('Передайте массив типов событий; [] снимает гарантию полноты')
        if len(value) != len(set(value)):
            raise ValueError('Типы событий не должны повторяться')
        return value

    @model_validator(mode='after')
    def nonempty_patch(self):
        if not self.model_fields_set:
            raise ValueError('Передайте хотя бы одно поле покрытия')
        return self
