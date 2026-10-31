from datetime import datetime, timezone
from pathlib import Path

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

    def path(self, name: str) -> Path:
        path = Path(getattr(self, name))
        return path if path.is_absolute() else ROOT / path


settings = Settings()


class Clock:
    frozen: datetime | None = None

    @classmethod
    def now(cls) -> datetime:
        return cls.frozen or datetime.now(timezone.utc)
