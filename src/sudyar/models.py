from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String
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
