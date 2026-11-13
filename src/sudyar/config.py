"""Settings. Secrets come ONLY from environment variables (.env, git-ignored)."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path

from urllib.parse import urlsplit

from pydantic import BaseModel, Field, SecretStr, ValidationError, field_validator, model_validator
from sqlalchemy.engine import URL


class ConfigError(Exception):
    """Raised with a clear, human-readable message when configuration is bad."""


# Verified from the official Swagger (GET /open-api/v1/variants, items in data.items[]).
# Left side = our name, right side = field name in the Digikala response.
# UNITS: values are stored exactly as returned. Rial vs Toman is NOT verified yet.
DEFAULT_FIELD_MAP = {
    "digikala_variant_id": "id",
    "product_id": "product_id",
    "product_variant_id": "product_variant_id",
    "title": "title",
    "product_title": "product_title",
    "active": "active",
    "is_archived": "is_archived",
    "price_sale": "price_sale",
    "cash_selling_price": "cash_selling_price",
    "price_limit": "price_limit",
    "marketplace_seller_stock": "marketplace_seller_stock",
    "warehouse_stock": "warehouse_stock",
    "buy_box_price": "buy_box_price",
    "is_buy_box_winner": "is_buy_box_winner",
    "is_seller_buy_box_winner": "is_seller_buy_box_winner",
    "is_in_buy_box_challenge": "is_in_buy_box_challenge",
    "is_sku_winner": "is_sku_winner",
    "rating": "rating",
    "lead_time": "lead_time",
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


PATH_FIELDS = ("variants_path", "commissions_path", "sales_reports_path", "buybox_price_path", "nth_rank_price_path")
DAY = 86_400
NUMERIC_RANGES: dict[str, tuple[float, float]] = {
    "postgres_port": (1, 65535), "page_size": (1, 1000),
    "rate_limit_requests": (1, 10_000), "rate_limit_period_seconds": (0.001, DAY),
    "max_concurrent": (1, 100), "max_retries": (0, 20),
    "backoff_base_seconds": (0, 3600), "backoff_max_seconds": (0, DAY),
    "breaker_threshold": (1, 1000), "breaker_pause_seconds": (0, DAY),
    "radar_hot_interval_seconds": (1, 7 * DAY), "radar_warm_interval_seconds": (1, 7 * DAY),
    "radar_calm_interval_seconds": (1, 7 * DAY), "radar_hot_lost_window_seconds": (0, 30 * DAY),
    "radar_warm_event_window_seconds": (0, 30 * DAY), "radar_budget_fraction": (0.01, 1.0),
    "winning_price_cache_seconds": (0, DAY), "notify_cooldown_seconds": (0, 7 * DAY),
    "fees_cache_seconds": (0, 30 * DAY), "fees_max_pages": (1, 10_000), "fees_max_drop_pct": (0, 100),
    "fees_max_stale_days": (0, 365), "sales_cache_seconds": (0, 30 * DAY), "sales_max_pages": (1, 1000),
}
ENV_NAMES = {"base_url": "DIGIKALA_BASE_URL", "variants_path": "DIGIKALA_VARIANTS_PATH",
             "commissions_path": "FEES_COMMISSIONS_PATH", "sales_reports_path": "SALES_REPORTS_PATH",
             "price_unit": "DIGIKALA_PRICE_UNIT", "suggested_price_unit": "DIGIKALA_SUGGESTED_PRICE_UNIT"}


def check_bale_base(url: str, allowed_hosts: str) -> str | None:
    """None if the Bale base URL is https and on the allow-list, else a short reason."""
    p = urlsplit(url or "")
    hosts = {h.strip().lower() for h in allowed_hosts.split(",") if h.strip()}
    if p.scheme != "https" or not p.hostname or p.username or p.password:
        return "BALE_API_BASE must be an https:// URL"
    if p.hostname.lower() not in hosts:
        return f"BALE_API_BASE host is not in BALE_ALLOWED_HOSTS ({', '.join(sorted(hosts)) or 'empty'})"
    return None


class Settings(BaseModel):
    digikala_self_token: SecretStr = SecretStr("")
    postgres_password: SecretStr = SecretStr("")
    database_url_override: str = ""
    postgres_user: str = "sudyar"
    postgres_db: str = "sudyar"
    postgres_host: str = "db"
    postgres_port: int = 5432

    # Verified from the official Swagger. Auth: "Authorization: Bearer <Self Token>".
    base_url: str = "https://seller.digikala.com"
    variants_path: str = "/open-api/v1/variants"
    auth_header: str = "Authorization"
    auth_prefix: str = "Bearer "
    page_param: str = "page"
    page_size_param: str = "size"
    page_size: int = 50  # default per Swagger; max accepted size unknown, find it at first real run
    items_key: str = "data.items"
    pager_key: str = "data.pager"
    buybox_price_path: str = "/open-api/v1/pricing/buybox/price-suggestion/winning-price"
    nth_rank_price_path: str = "/open-api/v1/pricing/buybox/price-suggestion/nth-rank-winning-price"
    field_map: dict[str, str] = Field(default_factory=lambda: dict(DEFAULT_FIELD_MAP))

    # UNVERIFIED: optional server-side filter params for the variants list. Empty by default;
    # the radar classifies tiers client-side and never relies on these.
    variants_extra_params: dict[str, str] = Field(default_factory=dict)

    # --- Radar (Part 2) ---
    radar_hot_interval_seconds: float = 120
    radar_warm_interval_seconds: float = 600
    radar_calm_interval_seconds: float = 3600
    radar_hot_lost_window_seconds: float = 3600  # "lost Buy Box in the last 60 min" => HOT
    radar_warm_event_window_seconds: float = 86400  # any recent event => WARM
    radar_budget_fraction: float = 0.6  # share of the 30 req / 30 s read limit the radar may use
    winning_price_cache_seconds: float = 600

    # --- Notifications (dry-run unless NOTIFY_ENABLED=true) ---
    notify_enabled: bool = False
    notify_channels: str = "telegram"  # comma list: telegram,bale
    notify_event_types: str = "BUYBOX_LOST,BUYBOX_REGAINED,ENTERED_CHALLENGE,STOCK_OUT,DEACTIVATED"
    notify_cooldown_seconds: float = 1800
    notify_quiet_start: str = ""  # "HH:MM", empty = no quiet hours
    notify_quiet_end: str = ""
    notify_timezone: str = "Asia/Tehran"
    telegram_bot_token: SecretStr = SecretStr("")
    telegram_chat_id: SecretStr = SecretStr("")
    bale_bot_token: SecretStr = SecretStr("")
    bale_chat_id: SecretStr = SecretStr("")
    bale_api_base: str = ""  # UNVERIFIED: Bale Bot API base URL, must be provided by the user
    # Only these hosts may receive Bale alerts (UNVERIFIED: check Bale's docs; add hosts here if needed).
    bale_allowed_hosts: str = "tapi.bale.ai"

    # --- Profit floor (Parts 3 / 3b) ---
    # Per the official Swagger: Digikala prices and winning-price suggested_price are in RIAL.
    # Floor math is unit-explicit (prices are converted to Toman; Rial/10); Persian messages show Toman.
    price_unit: str = "rial"  # rial | toman (anything else -> status needs_unit)
    suggested_price_unit: str = "rial"
    # GET /open-api/v1/commissions/ (scope: commission). `commission` is a FRACTION (0.03 = 3%).
    commissions_path: str = "/open-api/v1/commissions/"
    fees_only_my_commissions: bool = False  # UNVERIFIED meaning of search[my_commissions]; off = not sent
    fees_main_category_id: str = ""  # optional search[main_category_id]
    fees_cache_seconds: float = 86400  # commissions are re-read at most once per 24 h
    fees_max_pages: int = 200
    # UNCONFIRMED meaning in the Swagger: off by default, floor uses `commission` only.
    floor_include_extra_commission: bool = False
    floor_include_return_free_commission: bool = False
    # GET /open-api/v1/insight/sales-reports (scope: insight). range = last_7_days|last_14_days|last_30_days.
    sales_reports_path: str = "/open-api/v1/insight/sales-reports"
    sales_cache_seconds: float = 86400
    sales_max_pages: int = 50
    # Variant list items have category_id and supplier_code (used as SKU). They have NO brand field.
    # Safety nets for the commissions table
    fees_max_drop_pct: float = 30  # refuse a sync that has this % fewer rows than the last good one
    fees_max_stale_days: float = 3  # commissions older than this (refresh keeps failing) -> needs_fees
    floor_category_field: str = "category_id"
    cost_sku_field: str = "supplier_code"

    rate_limit_requests: int = 30
    rate_limit_period_seconds: float = 30
    max_concurrent: int = 3
    max_retries: int = 5
    backoff_base_seconds: float = 1.0
    backoff_max_seconds: float = 60
    breaker_threshold: int = 3
    breaker_pause_seconds: float = 300

    # ---------- validation (config is untrusted input too) ----------
    @field_validator("base_url")
    @classmethod
    def _https_base(cls, v: str) -> str:
        p = urlsplit(v)
        if p.scheme != "https" or not p.hostname or p.username or p.password or p.query or p.fragment:
            raise ValueError("must be an https:// URL without credentials, query or fragment")
        return v.rstrip("/")

    @field_validator(*PATH_FIELDS)
    @classmethod
    def _api_path(cls, v: str, info) -> str:
        if v == "" and info.field_name == "variants_path":
            return v  # reported by problems()
        if (not v.startswith("/") or v.startswith("//") or "://" in v or "\\" in v
                or ".." in v.split("/") or "?" in v or "#" in v or any(c.isspace() for c in v)):
            raise ValueError("must be a path starting with a single '/' (no host, no '..', no query)")
        return v

    @field_validator("price_unit", "suggested_price_unit")
    @classmethod
    def _unit(cls, v: str) -> str:
        v = v.strip().lower()
        if v not in ("rial", "toman", "unknown"):
            raise ValueError("must be rial or toman")
        return v

    @model_validator(mode="after")
    def _numbers_are_sane(self):
        for name, value in self:
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError(f"{name} must be a finite number")
        for name, (lo, hi) in NUMERIC_RANGES.items():
            v = getattr(self, name)
            if isinstance(v, bool) or not (lo <= v <= hi):
                raise ValueError(f"{name} must be between {lo} and {hi}")
        return self

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
            out.append("DIGIKALA_VARIANTS_PATH is empty (default is /open-api/v1/variants).")
        return out

    def notify_problems(self) -> list[str]:
        """Only relevant when NOTIFY_ENABLED=true."""
        out = []
        if not self.notify_enabled:
            return out
        for ch in [c.strip() for c in self.notify_channels.split(",") if c.strip()]:
            if ch == "telegram":
                if not self.telegram_bot_token.get_secret_value() or not self.telegram_chat_id.get_secret_value():
                    out.append("Telegram is enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing.")
            elif ch == "bale":
                if not (self.bale_bot_token.get_secret_value() and self.bale_chat_id.get_secret_value()
                        and self.bale_api_base):
                    out.append("Bale is enabled but BALE_BOT_TOKEN, BALE_CHAT_ID or BALE_API_BASE is missing.")
                else:
                    why = check_bale_base(self.bale_api_base, self.bale_allowed_hosts)
                    if why:
                        out.append(why)
            else:
                out.append(f"Unknown notification channel '{ch}' (use telegram or bale).")
        return out

    def require_ok(self) -> None:
        problems = self.problems() + self.notify_problems()
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
    def to_bool(v: str) -> bool:
        return v.strip().lower() in ("1", "true", "yes", "on")

    put("variants_extra_params", "DIGIKALA_VARIANTS_EXTRA_PARAMS", json.loads)
    put("radar_hot_interval_seconds", "RADAR_HOT_INTERVAL_SECONDS", float)
    put("radar_warm_interval_seconds", "RADAR_WARM_INTERVAL_SECONDS", float)
    put("radar_calm_interval_seconds", "RADAR_CALM_INTERVAL_SECONDS", float)
    put("radar_hot_lost_window_seconds", "RADAR_HOT_LOST_WINDOW_SECONDS", float)
    put("radar_warm_event_window_seconds", "RADAR_WARM_EVENT_WINDOW_SECONDS", float)
    put("radar_budget_fraction", "RADAR_BUDGET_FRACTION", float)
    put("winning_price_cache_seconds", "WINNING_PRICE_CACHE_SECONDS", float)
    put("notify_enabled", "NOTIFY_ENABLED", to_bool)
    put("notify_channels", "NOTIFY_CHANNELS")
    put("notify_event_types", "NOTIFY_EVENT_TYPES")
    put("notify_cooldown_seconds", "NOTIFY_COOLDOWN_SECONDS", float)
    put("notify_quiet_start", "NOTIFY_QUIET_START")
    put("notify_quiet_end", "NOTIFY_QUIET_END")
    put("notify_timezone", "NOTIFY_TIMEZONE")
    put("telegram_bot_token", "TELEGRAM_BOT_TOKEN", SecretStr)
    put("telegram_chat_id", "TELEGRAM_CHAT_ID", SecretStr)
    put("bale_bot_token", "BALE_BOT_TOKEN", SecretStr)
    put("bale_chat_id", "BALE_CHAT_ID", SecretStr)
    put("bale_api_base", "BALE_API_BASE")
    put("price_unit", "DIGIKALA_PRICE_UNIT", lambda v: v.strip().lower())
    put("suggested_price_unit", "DIGIKALA_SUGGESTED_PRICE_UNIT", lambda v: v.strip().lower())
    put("commissions_path", "FEES_COMMISSIONS_PATH")
    put("fees_only_my_commissions", "FEES_ONLY_MY_COMMISSIONS", to_bool)
    put("fees_main_category_id", "FEES_MAIN_CATEGORY_ID")
    put("fees_cache_seconds", "FEES_CACHE_SECONDS", float)
    put("fees_max_pages", "FEES_MAX_PAGES", int)
    put("floor_include_extra_commission", "FLOOR_INCLUDE_EXTRA_COMMISSION", to_bool)
    put("floor_include_return_free_commission", "FLOOR_INCLUDE_RETURN_FREE_COMMISSION", to_bool)
    put("sales_reports_path", "SALES_REPORTS_PATH")
    put("sales_cache_seconds", "SALES_CACHE_SECONDS", float)
    put("sales_max_pages", "SALES_MAX_PAGES", int)
    put("fees_max_drop_pct", "FEES_MAX_DROP_PCT", float)
    put("fees_max_stale_days", "FEES_MAX_STALE_DAYS", float)
    put("bale_allowed_hosts", "BALE_ALLOWED_HOSTS")
    put("floor_category_field", "FLOOR_CATEGORY_FIELD")
    put("cost_sku_field", "COST_SKU_FIELD")
    put("rate_limit_requests", "RATE_LIMIT_REQUESTS", int)
    put("rate_limit_period_seconds", "RATE_LIMIT_PERIOD_SECONDS", float)
    put("max_concurrent", "MAX_CONCURRENT", int)
    put("max_retries", "MAX_RETRIES", int)
    put("backoff_base_seconds", "BACKOFF_BASE_SECONDS", float)
    put("backoff_max_seconds", "BACKOFF_MAX_SECONDS", float)
    put("breaker_threshold", "BREAKER_THRESHOLD", int)
    put("breaker_pause_seconds", "BREAKER_PAUSE_SECONDS", float)
    try:
        return Settings(**kw)
    except ValidationError as e:  # report field + rule only, never the offending value
        msgs = []
        for err in e.errors():
            loc = str(err["loc"][0]) if err["loc"] else "settings"
            msgs.append(f"{ENV_NAMES.get(loc, loc.upper())}: {err['msg'].removeprefix('Value error, ')}")
        raise ConfigError("Invalid configuration:\n - " + "\n - ".join(msgs)) from None
