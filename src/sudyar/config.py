"""Settings. Secrets come ONLY from environment variables (.env, git-ignored)."""
from __future__ import annotations

import json
import os
from pathlib import Path

from pydantic import BaseModel, Field, SecretStr
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

    # --- Profit floor (Part 3) ---
    # UNVERIFIED: unit of variant prices (price_sale, buy_box_price): rial | toman | unknown.
    # While "unknown", no floor can be compared with a price (status needs_unit). Set it after
    # comparing one price with the seller panel.
    price_unit: str = "unknown"
    # Per the Swagger (as relayed): winning-price suggested_price is an integer in Rial.
    suggested_price_unit: str = "rial"
    # UNVERIFIED: fee endpoints. Empty = disabled (floor status needs_fees). Paths, query params
    # (templates with {product_variant_id} / {price}) and the response mapping must come from the
    # official Swagger. Map values look like "commissions:data.commission_pct" or
    # "calculator:data.fulfillment_fixed" (source:dotted.path).
    fees_commission_path: str = ""
    fees_calculator_path: str = ""
    fees_params: dict[str, str] = Field(default_factory=lambda: {"product_variant_id": "{product_variant_id}"})
    fees_field_map: dict[str, str] = Field(default_factory=dict)
    fees_cache_seconds: float = 86400
    # Costs Digikala does not tell us: YOU set them (0 = not applied, never guessed).
    cost_ad_share_pct: float = 0
    cost_return_reserve_pct: float = 0
    cost_packaging_toman: float = 0
    # UNVERIFIED: dotted paths into each variant's raw_json for brand / category / sku.
    floor_brand_field: str = ""
    floor_category_field: str = ""
    cost_sku_field: str = ""

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
    put("fees_commission_path", "FEES_COMMISSION_PATH")
    put("fees_calculator_path", "FEES_CALCULATOR_PATH")
    put("fees_params", "FEES_PARAMS", json.loads)
    put("fees_field_map", "FEES_FIELD_MAP", json.loads)
    put("fees_cache_seconds", "FEES_CACHE_SECONDS", float)
    put("cost_ad_share_pct", "COST_AD_SHARE_PCT", float)
    put("cost_return_reserve_pct", "COST_RETURN_RESERVE_PCT", float)
    put("cost_packaging_toman", "COST_PACKAGING_TOMAN", float)
    put("floor_brand_field", "FLOOR_BRAND_FIELD")
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
    return Settings(**kw)
