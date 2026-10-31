from typing import Annotated
from uuid import UUID

from pydantic import Field, model_validator

from app.contracts import StrictModel


class ColumnMapping(StrictModel):
    phone: Annotated[int, Field(ge=0, le=199)] | None = None
    email: Annotated[int, Field(ge=0, le=199)] | None = None
    time: Annotated[int, Field(ge=0, le=199)]

    @model_validator(mode='after')
    def distinct_columns(self):
        columns = [v for v in [self.phone, self.email, self.time] if v is not None]
        if self.phone is None and self.email is None:
            raise ValueError('Выберите колонку телефона или email')
        if len(columns) != len(set(columns)):
            raise ValueError('Для каждого поля нужна отдельная колонка')
        return self


class BrandContext(StrictModel):
    tenant_id: UUID
    tenant_name: str
    source_id: UUID
    timezone: str


class ImportColumn(StrictModel):
    index: int
    name: str
    examples: list[str]


class MappingSample(StrictModel):
    row_number: int
    phone: str | None
    email: str | None
    time: str | None
    error: str | None


class MappingError(StrictModel):
    row_number: int
    message: str


class FilePreview(StrictModel):
    columns: list[ImportColumn]
    total_rows: int
    sheet_name: str | None
    encoding: str | None
    timezone: str
    mapping: ColumnMapping | None
    valid_rows: int | None
    invalid_rows: int | None
    sample: list[MappingSample]
    errors: list[MappingError]
