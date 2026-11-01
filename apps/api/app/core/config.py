from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / '.env', extra='ignore')
    database_url: str = 'postgresql+psycopg://hryukers:hryukers-local-db@localhost:55432/hryukers'
    redis_url: str = 'redis://localhost:56379/0'
    demo_email: str = 'marketer@example.com'
    demo_password: str = 'HryukersDemo2026!'
    allowed_origins: str = 'http://localhost:5180,http://127.0.0.1:5180'
    cookie_secure: bool = False
    upload_dir: str = '.data/uploads'
    demo_dir: str = '.data/demo'
    mock_source_url: str = 'http://localhost:8011/events'
    connector_allowed_hosts: str = 'mock-source,localhost,127.0.0.1'
    connector_http_hosts: str = 'mock-source,localhost,127.0.0.1'
    admin_email: str = 'admin@example.com'
    admin_password: str = 'HryukersAdmin2026!'
    seed_workspace_data: bool = False
    seed_demo_accounts: bool = False
    deployment_mode: Literal['local', 'production'] = 'local'
    connector_secret_bindings: dict[str, dict[str, str]] = Field(default_factory=dict)
    max_active_imports_per_source: int = Field(default=3, ge=1, le=100)
    max_active_imports_per_mall: int = Field(default=20, ge=1, le=1000)
    max_upload_bytes_per_mall: int = Field(default=256 * 1024 * 1024, ge=10 * 1024 * 1024)
    max_upload_bytes_total: int = Field(default=1024 * 1024 * 1024, ge=10 * 1024 * 1024)
    import_file_retention_hours: int = Field(default=24, ge=1, le=720)

    @model_validator(mode='after')
    def production_security(self):
        if self.deployment_mode == 'production':
            if self.seed_demo_accounts or self.seed_workspace_data:
                raise ValueError('Production не допускает стартовые аккаунты и заполнение примера')
            if len(self.admin_password) < 12 or self.admin_password in {'HryukersAdmin2026!', 'HryukersDemo2026!'}:
                raise ValueError('Задайте собственный ADMIN_PASSWORD длиной от 12 символов')
            if not self.cookie_secure:
                raise ValueError('Production требует COOKIE_SECURE=true и HTTPS')
            if any(urlsplit(v.strip()).scheme != 'https' for v in self.allowed_origins.split(',')):
                raise ValueError('Production требует HTTPS в ALLOWED_ORIGINS')
            if urlsplit(self.database_url).password in {None, '', 'hryukers-local-db'}:
                raise ValueError('Production требует собственный пароль БД')
        return self

    def path(self, name: str) -> Path:
        path = Path(getattr(self, name))
        return path if path.is_absolute() else ROOT / path


settings = Settings()


class Clock:
    frozen: datetime | None = None

    @classmethod
    def now(cls) -> datetime:
        return cls.frozen or datetime.now(timezone.utc)
