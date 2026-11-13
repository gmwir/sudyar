"""Settings. Secrets come ONLY from environment variables (.env, git-ignored)."""
from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field, SecretStr
from sqlalchemy.engine import URL


class ConfigError(Exception):
    """Raised with a clear, human-readable message when configuration is bad."""


DEFAULT_FIELD_MAP = {
    "variant_id": "id",
    "product_id": "product_id",
    "title": "title",
    "price": "price",
    "stock": "stock",
    "active": "is_active",
}


def load_dotenv(path: str | Path = ".env") -> None:
    """Tiny .env reader (real environment variables win)."""
    p = Path(path)
    if not p.is_file():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


class Settings(BaseModel):
    digikala_self_token: SecretStr = SecretStr("")
    postgres_password: SecretStr = SecretStr("")
    database_url_override: str = ""
    postgres_user: str = "sudyar"
    postgres_db: str = "sudyar"
    postgres_host: str = "db"
    postgres_port: int = 5432

    # TODO: confirm all of these in the official Swagger (it was unreachable when built).
    base_url: str = "https://seller.digikala.com/open-api/v1"
    variants_path: str = ""  # TODO: required, no guessing
    auth_header: str = "Authorization"
    auth_prefix: str = ""
    page_param: str = "page"
    page_size_param: str = "size"
    page_size: int = 50
    items_key: str = "items"
    field_map: dict[str, str] = Field(default_factory=lambda: dict(DEFAULT_FIELD_MAP))

    rate_limit_requests: int = 30
    rate_limit_period_seconds: float = 30
    max_concurrent: int = 3
    max_retries: int = 5
    backoff_base_seconds: float = 1.0
    backoff_max_seconds: float = 60
    breaker_threshold: int = 3
    breaker_pause_seconds: float = 300

    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        return URL.create(
            "postgresql+psycopg2",
            username=self.postgres_user,
            password=self.postgres_password.get_secret_value(),
            host=self.postgres_host,
            port=self.postgres_port,
            database=self.postgres_db,
        ).render_as_string(hide_password=False)

    def problems(self) -> list[str]:
        """Human-readable list of what is missing (empty = OK)."""
        out = []
        if not self.digikala_self_token.get_secret_value().strip():
            out.append("DIGIKALA_SELF_TOKEN is missing. Put your Self Token in the .env file.")
        if not self.database_url_override and not self.postgres_password.get_secret_value():
            out.append("POSTGRES_PASSWORD is missing. Choose a password and put it in the .env file.")
        if not self.variants_path.strip():
            out.append(
                "DIGIKALA_VARIANTS_PATH is empty (TODO: copy the 'list variants' path "
                "from the official Swagger into .env)."
            )
        return out

    def require_ok(self) -> None:
        problems = self.problems()
        if problems:
            raise ConfigError("\n".join(problems))


def _env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


def load_settings() -> Settings:
    load_dotenv()
    kw: dict = {}

    def put(field: str, env: str, cast=str):
        v = _env(env)
        if v is not None:
            try:
                kw[field] = cast(v)
            except ValueError as e:
                raise ConfigError(f"{env} has an invalid value.") from e

    put("digikala_self_token", "DIGIKALA_SELF_TOKEN", SecretStr)
    put("postgres_password", "POSTGRES_PASSWORD", SecretStr)
    put("database_url_override", "DATABASE_URL")
    put("postgres_user", "POSTGRES_USER")
    put("postgres_db", "POSTGRES_DB")
    put("postgres_host", "POSTGRES_HOST")
    put("postgres_port", "POSTGRES_PORT", int)
    put("base_url", "DIGIKALA_BASE_URL")
    put("variants_path", "DIGIKALA_VARIANTS_PATH")
    put("auth_header", "DIGIKALA_AUTH_HEADER")
    put("auth_prefix", "DIGIKALA_AUTH_PREFIX")
    put("page_param", "DIGIKALA_PAGE_PARAM")
    put("page_size_param", "DIGIKALA_PAGE_SIZE_PARAM")
    put("page_size", "DIGIKALA_PAGE_SIZE", int)
    put("items_key", "DIGIKALA_ITEMS_KEY")
    put("field_map", "DIGIKALA_FIELD_MAP", json.loads)
    put("rate_limit_requests", "RATE_LIMIT_REQUESTS", int)
    put("rate_limit_period_seconds", "RATE_LIMIT_PERIOD_SECONDS", float)
    put("max_concurrent", "MAX_CONCURRENT", int)
    put("max_retries", "MAX_RETRIES", int)
    put("backoff_base_seconds", "BACKOFF_BASE_SECONDS", float)
    put("backoff_max_seconds", "BACKOFF_MAX_SECONDS", float)
    put("breaker_threshold", "BREAKER_THRESHOLD", int)
    put("breaker_pause_seconds", "BREAKER_PAUSE_SECONDS", float)
    return Settings(**kw)
