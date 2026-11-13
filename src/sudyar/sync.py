"""Full read-only sync: Digikala -> our variants table. Rows are never deleted."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import Settings
from .digikala_client import DigikalaClient
from .models import Variant, utcnow


def _to_int(v: Any) -> int | None:
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def parse_variant(raw: dict[str, Any], field_map: dict[str, str]) -> dict[str, Any] | None:
    vid = raw.get(field_map["variant_id"])
    if vid is None:
        return None
    pid = raw.get(field_map["product_id"])
    active = raw.get(field_map["active"], True)
    return {
        "digikala_variant_id": str(vid),
        "product_id": None if pid is None else str(pid),
        "title": raw.get(field_map["title"]),
        "our_price": _to_int(raw.get(field_map["price"])),
        "stock": _to_int(raw.get(field_map["stock"])),
        "active": bool(active),
        "raw_json": raw,
    }


def upsert_variant(session: Session, data: dict[str, Any]) -> None:
    now = utcnow()
    row = session.scalar(select(Variant).where(Variant.digikala_variant_id == data["digikala_variant_id"]))
    if row is None:
        session.add(Variant(**data, last_seen_at=now))
    else:
        for k, v in data.items():
            setattr(row, k, v)
        row.last_seen_at = now


async def sync_variants(client: DigikalaClient, session: Session, settings: Settings) -> int:
    """One full pass. Returns number of variants seen. Unseen rows become inactive."""
    started = utcnow()
    count = 0
    async for raw in client.list_variants():
        data = parse_variant(raw, settings.field_map)
        if data is None:
            continue
        upsert_variant(session, data)
        count += 1
    session.flush()
    # Only reached when the full read succeeded (errors raise above).
    session.execute(
        update(Variant).where(Variant.last_seen_at < started).values(active=False)
    )
    session.commit()
    return count
