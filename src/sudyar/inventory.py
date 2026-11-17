"""Inventory (Part 6): read stock, low-stock alerts, and stock pools (one physical stock shared by several codes).

Reading is GET /open-api/v1/inventories (scope inventory). Pushing a pool's split uses the batch seller-stock
update through DigikalaWriter (WRITE_MODE rules apply).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .config import Settings
from .models import InventoryItem, StockPool, StockPoolMember, Variant, utcnow
from .writer import DigikalaWriter

INVENTORIES_PATH = "/open-api/v1/inventories"


def _int(v: Any) -> int | None:
    try:
        return None if v is None or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


async def sync_inventory(client, session: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    rows: dict[str, dict] = {}
    async for it in client.iter_list(INVENTORIES_PATH):
        pvid = it.get("product_variant_id")
        if pvid is None:
            continue
        rows[str(pvid)] = it
    for pvid, it in rows.items():  # all pages read before anything is written (never partial)
        row = session.get(InventoryItem, pvid) or InventoryItem(product_variant_id=pvid)
        row.supplier_code = (str(it.get("supplier_code")) if it.get("supplier_code") is not None else None)
        row.title = (it.get("title") or "")[:1000] or None
        row.seller_stock = _int(it.get("marketplace_seller_stock"))
        row.warehouse_stock = _int(it.get("warehouse_stock"))
        row.available = _int(it.get("available"))
        row.reserve = _int(it.get("reserve"))
        row.has_dead_stock = bool(it.get("has_dead_stock")) if it.get("has_dead_stock") is not None else None
        row.fetched_at = now
        session.add(row)
    session.commit()
    return len(rows)


def low_stock(session: Session, s: Settings) -> list[InventoryItem]:
    """Items whose available stock (seller + warehouse view from Digikala) is at or below the threshold."""
    return list(session.scalars(select(InventoryItem).where(
        InventoryItem.available.is_not(None), InventoryItem.available <= s.low_stock_threshold
    ).order_by(InventoryItem.available, InventoryItem.title)))


# ---------------------------------------------------------------------- stock pools
def split_stock(qty: int, weights: list[int]) -> list[int]:
    """Split qty over members by weight (largest remainder). Sum always equals qty; never negative."""
    qty = max(0, int(qty))
    w = [max(0, int(x)) for x in weights]
    total = sum(w)
    if not w:
        return []
    if total == 0:
        w = [1] * len(w)
        total = len(w)
    raw = [qty * x / total for x in w]
    base = [int(r) for r in raw]
    rest = qty - sum(base)
    order = sorted(range(len(w)), key=lambda i: (raw[i] - base[i], w[i]), reverse=True)
    for i in order[:rest]:
        base[i] += 1
    return base


def set_pool(session: Session, name: str, qty: int, members: list[tuple[str, int]]) -> StockPool:
    """Create/replace a pool. members = [(digikala_variant_id, weight)]. A variant can be in one pool only."""
    if not name.strip() or qty < 0:
        raise ValueError("pool needs a name and a quantity >= 0")
    pool = session.scalar(select(StockPool).where(StockPool.name == name.strip()))
    if pool is None:
        pool = StockPool(name=name.strip())
        session.add(pool)
        session.flush()
    ids = []
    for dk_id, weight in members:
        v = session.scalar(select(Variant).where(Variant.digikala_variant_id == str(dk_id)))
        if v is None:
            raise ValueError(f"variant {dk_id} not found (run sync-variants first)")
        if weight < 0:
            raise ValueError("weight must be >= 0")
        other = session.scalar(select(StockPoolMember).where(StockPoolMember.variant_id == v.id,
                                                             StockPoolMember.pool_id != pool.id))
        if other is not None:
            raise ValueError(f"variant {dk_id} is already in another pool")
        ids.append((v.id, weight))
    session.execute(delete(StockPoolMember).where(StockPoolMember.pool_id == pool.id))
    for vid, weight in ids:
        session.add(StockPoolMember(pool_id=pool.id, variant_id=vid, weight=weight))
    pool.physical_qty = int(qty)
    pool.updated_at = utcnow()
    session.commit()
    return pool


@dataclass
class PoolPlan:
    pool: str
    lines: list[tuple[str, int]]  # (digikala_variant_id, seller_stock)


def plan_pool(session: Session, pool: StockPool) -> PoolPlan:
    members = session.execute(select(StockPoolMember, Variant).join(Variant, Variant.id == StockPoolMember.variant_id)
                              .where(StockPoolMember.pool_id == pool.id).order_by(Variant.id)).all()
    parts = split_stock(pool.physical_qty, [m.weight for m, _ in members])
    return PoolPlan(pool.name, [(v.digikala_variant_id, q) for (_, v), q in zip(members, parts)])


async def push_pool(writer: DigikalaWriter, plan: PoolPlan) -> dict:
    items = [{"variant_id": int(dk), "payload": {"seller_stock": q}} for dk, q in plan.lines]
    if not items:
        raise ValueError("pool has no members")
    return await writer.write("batch_stock_update", {"deadline": 600, "items": items}, target=f"pool:{plan.pool}",
                              source="stock_pool")
