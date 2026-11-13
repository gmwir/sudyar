"""Full read-only sync: Digikala -> our variants table (+ one history snapshot each).

Rows are never deleted. Money values are stored exactly as returned (unit unverified).
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import Settings
from .digikala_client import DigikalaClient
from .models import Variant, VariantSnapshot, utcnow

_INT = ("price_sale", "cash_selling_price", "price_limit", "marketplace_seller_stock",
        "warehouse_stock", "buy_box_price", "lead_time")
_BOOL = ("is_archived", "is_buy_box_winner", "is_seller_buy_box_winner",
         "is_in_buy_box_challenge", "is_sku_winner")
_STR = ("product_id", "product_variant_id")


def _to_int(v: Any) -> int | None:
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def _to_float(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _to_bool(v: Any) -> bool | None:
    return None if v is None else bool(v)


def parse_variant(raw: dict[str, Any], field_map: dict[str, str]) -> dict[str, Any] | None:
    def get(name: str) -> Any:
        return raw.get(field_map[name])

    vid = get("digikala_variant_id")
    if vid is None:
        return None
    data: dict[str, Any] = {"digikala_variant_id": str(vid), "raw_json": raw}
    for k in _STR:
        v = get(k)
        data[k] = None if v is None else str(v)
    data["title"] = get("title")
    data["product_title"] = get("product_title")
    for k in _INT:
        data[k] = _to_int(get(k))
    for k in _BOOL:
        data[k] = _to_bool(get(k))
    data["rating"] = _to_float(get("rating"))
    active = get("active")
    data["active"] = True if active is None else bool(active)
    data["our_price"] = data["price_sale"]
    data["stock"] = data["marketplace_seller_stock"]
    return data


def upsert_variant(session: Session, data: dict[str, Any]) -> Variant:
    now = utcnow()
    row = session.scalar(select(Variant).where(Variant.digikala_variant_id == data["digikala_variant_id"]))
    if row is None:
        row = Variant(**data, last_seen_at=now)
        session.add(row)
    else:
        for k, v in data.items():
            setattr(row, k, v)
        row.last_seen_at = now
    return row


def add_snapshot(session: Session, row: Variant, taken_at) -> None:
    session.flush()  # make sure row.id exists
    session.add(VariantSnapshot(
        variant_id=row.id, taken_at=taken_at, price_sale=row.price_sale,
        buy_box_price=row.buy_box_price,
        is_seller_buy_box_winner=row.is_seller_buy_box_winner,
        is_in_buy_box_challenge=row.is_in_buy_box_challenge, stock=row.stock, active=row.active,
    ))


async def sync_variants(client: DigikalaClient, session: Session, settings: Settings) -> int:
    """One full pass. Returns number of variants seen. Unseen rows become inactive."""
    started = utcnow()
    count = 0
    async for raw in client.list_variants():
        data = parse_variant(raw, settings.field_map)
        if data is None:
            continue
        row = upsert_variant(session, data)
        add_snapshot(session, row, started)
        count += 1
    session.flush()
    # Only reached when the full read succeeded (errors raise above).
    session.execute(update(Variant).where(Variant.last_seen_at < started).values(active=False))
    session.commit()
    return count
