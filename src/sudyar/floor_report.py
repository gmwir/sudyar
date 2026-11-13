"""floor-report: read-only look at profit vs floor, from our own database + cached fees."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .floor import OK, FloorEngine, to_toman
from .models import Variant


@dataclass
class FloorReport:
    status_counts: dict[str, int] = field(default_factory=dict)
    low_profit: list[tuple[Variant, float]] = field(default_factory=list)  # (variant, profit toman)
    below_floor: list[tuple[Variant, float, int, float]] = field(default_factory=list)  # (v, win, floor, gap)
    checked: int = 0


async def build_report(session: Session, engine: FloorEngine, now: datetime, top: int = 20) -> FloorReport:
    """No API calls (fees come from the cache only).

    NOTE: Digikala's variant fields we read contain no sales numbers, so "variants that sell" is
    approximated as: active and in stock. This is a proxy, not real sales data.
    """
    rep = FloorReport()
    low, below = [], []
    for v in session.scalars(select(Variant).where(Variant.active.is_(True))):
        rep.checked += 1
        res = await engine.evaluate(session, v, now, allow_fetch=False)
        rep.status_counts[res.status] = rep.status_counts.get(res.status, 0) + 1
        if (v.stock or 0) > 0:
            profit = await engine.profit_now(session, v, now, allow_fetch=False)
            if profit is not None and profit <= 0:
                low.append((v, profit))
        if res.status == OK and res.floor_toman is not None and v.is_seller_buy_box_winner is False:
            win = to_toman(v.buy_box_price, engine.s.price_unit)
            if win is not None and win < res.floor_toman:
                below.append((v, win, res.floor_toman, res.floor_toman - win))
    rep.low_profit = sorted(low, key=lambda x: x[1])[:top]
    rep.below_floor = sorted(below, key=lambda x: -x[3])[:top]
    return rep


def format_report(rep: FloorReport) -> str:
    lines = [f"Active variants checked: {rep.checked}", "Floor status:"]
    for k, n in sorted(rep.status_counts.items()):
        lines.append(f"  {k}: {n}")
    lines.append("")
    lines.append(f"Zero or negative profit at current price (active + in stock; sales data not available): {len(rep.low_profit)} shown")
    for v, p in rep.low_profit:
        lines.append(f"  {v.digikala_variant_id} | {(v.title or '')[:40]} | profit {p:,.0f} toman | stock {v.stock}")
    lines.append("")
    lines.append(f"Winning (Buy Box) price below our floor: {len(rep.below_floor)} shown")
    for v, win, floor, gap in rep.below_floor:
        lines.append(f"  {v.digikala_variant_id} | {(v.title or '')[:40]} | win {win:,.0f} < floor {floor:,} (gap {gap:,.0f}) toman")
    lines.append("")
    lines.append("Suggestions only: nothing is changed on Digikala.")
    return "\n".join(lines)
