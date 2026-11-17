"""Promotions (Part 6): list Digikala promotions (e.g. incredible offers / شگفت‌انگیز) and auto-join eligible
variants at a price that is never below the profit floor.

Price chosen per variant = min(max_allowable_price, selling_price x (1 - min_category_discount%)), rounded down.
It must be >= the variant's profit floor; otherwise the variant is skipped (never joined at a loss).
UNVERIFIED: the eligible list has both `id` and `product_variant_id`; the join body's `variant_id` is taken from
`id` (the API document labels `id` "Product Variant ID"). Check the first dry-run against the panel.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .floor import OK, FloorEngine
from .models import Promotion, Variant, utcnow
from .writer import DigikalaWriter

PROMOTIONS_PATH = "/open-api/v1/pricing/promotions"


def _int(v: Any) -> int | None:
    try:
        return None if v is None or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


async def sync_promotions(client, session: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    items = [it async for it in client.iter_list(PROMOTIONS_PATH)]
    for it in items:
        pid = _int(it.get("id"))
        if pid is None:
            continue
        row = session.get(Promotion, pid) or Promotion(id=pid)
        row.title = str(it.get("title") or "")[:300] or None
        row.nature = str(it.get("nature") or "")[:64] or None
        row.status = str(it.get("status") or "")[:40] or None
        row.start_at = str(it.get("start_at") or "")[:40] or None
        row.end_at = str(it.get("end_at") or "")[:40] or None
        row.fetched_at = now
        session.add(row)
    session.commit()
    return len(items)


def promo_price(item: dict[str, Any], step: int) -> int | None:
    sp = _int(item.get("selling_price"))
    mx = _int(item.get("max_allowable_price"))
    if not sp or sp <= 0:
        return None
    disc = item.get("min_category_discount") or 0
    try:
        disc = float(disc)
    except (TypeError, ValueError):
        return None
    target = sp * (1 - disc / 100)
    if mx:
        target = min(target, mx)
    return int(math.floor(target / step) * step) if target > 0 else None


@dataclass
class JoinPlan:
    promotion_id: int
    join: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


async def plan_join(client, session: Session, s: Settings, floor: FloorEngine, promotion_id: int,
                    now: datetime | None = None) -> JoinPlan:
    now = now or utcnow()
    plan = JoinPlan(promotion_id)
    path = f"{PROMOTIONS_PATH}/{int(promotion_id)}/variants/eligible"
    async for it in client.iter_list(path):
        vid = _int(it.get("id"))
        title = str(it.get("title") or vid)[:60]
        if vid is None:
            continue
        if it.get("already_exist_in_same_promotion"):
            plan.skipped.append(f"{title}: already joined")
            continue
        v = session.scalar(select(Variant).where(Variant.digikala_variant_id == str(vid)))
        if v is None:
            v = session.scalar(select(Variant).where(Variant.product_variant_id == str(it.get("product_variant_id"))))
        if v is None:
            plan.skipped.append(f"{title}: not in Sudyar (run sync-variants)")
            continue
        fr = await floor.evaluate(session, v, now)
        if fr.status != OK or not fr.floor_toman:
            plan.skipped.append(f"{title}: no profit floor")
            continue
        price = promo_price(it, s.reprice_round_rial)
        if price is None or price < fr.floor_toman * 10:
            plan.skipped.append(f"{title}: promotion price would be below the profit floor")
            continue
        plan.join.append({"variant_id": vid, "promotion_price": price, "order_limit": s.promo_order_limit,
                          "price_limit": s.promo_price_limit})
    return plan


async def apply_join(writer: DigikalaWriter, plan: JoinPlan) -> dict | None:
    if not plan.join:
        return None
    return await writer.write("promotion_join", {"data": plan.join}, params={"promotion_id": plan.promotion_id},
                              target=f"promotion:{plan.promotion_id}", source="promotion")


def autojoin_candidates(session: Session, s: Settings) -> list[Promotion]:
    natures = {n.strip() for n in s.promo_autojoin_natures.split(",") if n.strip()}
    rows = session.scalars(select(Promotion).order_by(Promotion.start_at))
    return [p for p in rows if p.nature in natures and (p.status or "").lower() not in ("finished", "expired", "ended")]
