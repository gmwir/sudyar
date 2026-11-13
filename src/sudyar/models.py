from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, UniqueConstraint, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Variant(Base):
    __tablename__ = "variants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    digikala_variant_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    product_id: Mapped[str | None] = mapped_column(String(64), index=True)
    title: Mapped[str | None] = mapped_column(String(1000))
    # Money values are stored exactly as Digikala returns them (unit Rial/Toman: UNVERIFIED).
    our_price: Mapped[int | None] = mapped_column(BigInteger)  # = price_sale
    stock: Mapped[int | None] = mapped_column(Integer)  # = marketplace_seller_stock
    product_variant_id: Mapped[str | None] = mapped_column(String(64), index=True)
    product_title: Mapped[str | None] = mapped_column(String(1000))
    is_archived: Mapped[bool | None] = mapped_column(Boolean)
    price_sale: Mapped[int | None] = mapped_column(BigInteger)
    cash_selling_price: Mapped[int | None] = mapped_column(BigInteger)
    price_limit: Mapped[int | None] = mapped_column(BigInteger)
    marketplace_seller_stock: Mapped[int | None] = mapped_column(Integer)
    warehouse_stock: Mapped[int | None] = mapped_column(Integer)
    buy_box_price: Mapped[int | None] = mapped_column(BigInteger)
    is_buy_box_winner: Mapped[bool | None] = mapped_column(Boolean)
    is_seller_buy_box_winner: Mapped[bool | None] = mapped_column(Boolean)
    is_in_buy_box_challenge: Mapped[bool | None] = mapped_column(Boolean)
    is_sku_winner: Mapped[bool | None] = mapped_column(Boolean)
    rating: Mapped[float | None] = mapped_column(Float)
    lead_time: Mapped[int | None] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    raw_json: Mapped[dict] = mapped_column(JSON)


class ApiCallLog(Base):
    __tablename__ = "api_call_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    called_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    endpoint: Mapped[str] = mapped_column(String(500))
    status: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)


class VariantSnapshot(Base):
    """History: one row per variant per sync. Never deleted."""

    __tablename__ = "variant_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id"), index=True)
    taken_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    price_sale: Mapped[int | None] = mapped_column(BigInteger)
    buy_box_price: Mapped[int | None] = mapped_column(BigInteger)
    is_seller_buy_box_winner: Mapped[bool | None] = mapped_column(Boolean)
    is_in_buy_box_challenge: Mapped[bool | None] = mapped_column(Boolean)
    stock: Mapped[int | None] = mapped_column(Integer)
    active: Mapped[bool | None] = mapped_column(Boolean)  # needed to detect DEACTIVATED


class RadarEvent(Base):
    """A change detected between two consecutive snapshots of one variant."""

    __tablename__ = "radar_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id"), index=True)
    type: Mapped[str] = mapped_column(String(32), index=True)
    old_value: Mapped[str | None] = mapped_column(String(200))
    new_value: Mapped[str | None] = mapped_column(String(200))
    details: Mapped[dict | None] = mapped_column(JSON)  # cause, gap, suggested_price, ...
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    dedupe_key: Mapped[str] = mapped_column(String(200), unique=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notify_status: Mapped[str | None] = mapped_column(String(32))


class HotOverride(Base):
    """Variants a human wants polled at the HOT rate no matter what."""

    __tablename__ = "hot_overrides"

    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    note: Mapped[str | None] = mapped_column(String(500))


class VariantCost(Base):
    """Our purchase cost per variant (toman). Optional: the app works without any rows."""

    __tablename__ = "variant_costs"

    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id"), primary_key=True)
    buy_cost: Mapped[int | None] = mapped_column(BigInteger)  # NULL = unknown
    source: Mapped[str] = mapped_column(String(16))  # manual | excel
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class FloorSetting(Base):
    """Profit-floor rule. Most specific scope wins: variant > brand > category > global."""

    __tablename__ = "floor_settings"
    __table_args__ = (UniqueConstraint("scope", "scope_key", name="uq_floor_settings_scope"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String(16))  # global | brand | category | variant
    scope_key: Mapped[str] = mapped_column(String(200), default="")  # "" for global
    margin_pct: Mapped[float | None] = mapped_column(Float)  # net profit as % of selling price
    min_profit_toman: Mapped[int | None] = mapped_column(BigInteger)
    floor_manual_toman: Mapped[int | None] = mapped_column(BigInteger)
    floor_manual_pct: Mapped[float | None] = mapped_column(Float)  # % of our current price


class FloorEvent(Base):
    """Audit trail: written when a variant's floor (or the reason for no floor) changes."""

    __tablename__ = "floor_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    variant_id: Mapped[int] = mapped_column(ForeignKey("variants.id"), index=True)
    floor: Mapped[int | None] = mapped_column(BigInteger)  # effective floor (toman)
    suggested_floor: Mapped[int | None] = mapped_column(BigInteger)  # computed from cost/fees
    reason: Mapped[str] = mapped_column(String(200))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class FeeCache(Base):
    """Fees read from Digikala (GET), cached so we never guess and never over-call."""

    __tablename__ = "fee_cache"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
