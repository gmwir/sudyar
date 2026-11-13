"""floor-report: read-only look at profit vs floor, from our own database (no API calls)."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .fees import FeeProvider
from .floor import COMPONENTS, OK, FloorEngine, resolve_components, to_toman
from .models import Variant
from .sales import load_sales, sales_synced_at

log = logging.getLogger(__name__)
SALES_RANGE_DEFAULT = "last_30_days"


@dataclass
class FloorReport:
    range: str = SALES_RANGE_DEFAULT
    status_counts: dict[str, int] = field(default_factory=dict)
    # (variant, units sold in range, net_sales_amount, profit per unit in toman)
    sells_low_profit: list[tuple[Variant, int, int | None, float]] = field(default_factory=list)
    below_floor: list[tuple[Variant, float, int, float]] = field(default_factory=list)
    component_set: dict[str, int] = field(default_factory=dict)  # component -> variants where it is set
    checked: int = 0
    low_profit_total: int = 0  # variants with profit <= 0, with or without sales data
    sales_rows: int = 0
    sales_synced: datetime | None = None
    fees_synced: datetime | None = None
    fees_assumed_max_brand: int = 0
    fees_assumed_single_brand: int = 0
    errors: int = 0  # variants skipped because evaluating them raised
    price_unit: str = ""
    include_extra: bool = False
    include_return_free: bool = False


async def _check_variant(session, engine, v, now, sales, rep, low, below) -> None:
    s = engine.s
    res = await engine.evaluate(session, v, now, allow_fetch=False)
    comps = resolve_components(session, v, s)
    profit = await engine.profit_now(session, v, now, allow_fetch=False)
    win = to_toman(v.buy_box_price, s.price_unit)
    # all computations succeeded: only now touch the report counters
    rep.status_counts[res.status] = rep.status_counts.get(res.status, 0) + 1
    if res.fee_reason == "fee_assumed_max_brand":
        rep.fees_assumed_max_brand += 1
    elif res.fee_reason == "fee_assumed_single_brand":
        rep.fees_assumed_single_brand += 1
    for c in comps.included:
        rep.component_set[c] += 1
    if profit is not None and profit <= 0:
        rep.low_profit_total += 1
        sale = sales.get(str(v.product_id)) if v.product_id is not None else None
        if sale is not None and (sale.net_item_sold or 0) > 0:
            low.append((v, sale.net_item_sold, sale.net_sales_amount, profit))
    if res.status == OK and res.floor_toman is not None and v.is_seller_buy_box_winner is False:
        if win is not None and win < res.floor_toman:
            below.append((v, win, res.floor_toman, res.floor_toman - win))


async def build_report(session: Session, engine: FloorEngine, now: datetime, top: int = 20,
                       range_: str = SALES_RANGE_DEFAULT) -> FloorReport:
    s = engine.s
    engine.fees.preload(session)
    sales = load_sales(session, range_)
    rep = FloorReport(range=range_, sales_rows=len(sales), sales_synced=sales_synced_at(session, range_),
                      fees_synced=engine.fees.synced_at(session), price_unit=s.price_unit,
                      include_extra=s.floor_include_extra_commission,
                      include_return_free=s.floor_include_return_free_commission,
                      component_set={c: 0 for c in COMPONENTS})
    low, below = [], []
    for v in session.scalars(select(Variant).where(Variant.active.is_(True))):
        rep.checked += 1
        try:  # one bad row (e.g. a corrupt rule or price) must never crash the whole report
            await _check_variant(session, engine, v, now, sales, rep, low, below)
        except Exception as e:
            rep.errors += 1
            rep.status_counts["error"] = rep.status_counts.get("error", 0) + 1
            log.warning("floor-report skipped variant %s: %s", v.digikala_variant_id, type(e).__name__)
    rep.sells_low_profit = sorted(low, key=lambda x: (-x[1], x[3]))[:top]
    rep.below_floor = sorted(below, key=lambda x: -x[3])[:top]
    return rep


COMP_FA = {"fulfillment": "fulfillment/processing", "tax": "tax", "ad_share": "ad share",
           "return_reserve": "return reserve", "packaging": "packaging"}


def format_report(rep: FloorReport) -> str:
    L: list[str] = []
    L.append(f"Active variants checked: {rep.checked}   (prices: {rep.price_unit}; all floor math in Toman = Rial/10)")
    L.append(f"Commissions last synced: {rep.fees_synced or 'NEVER (run sync-fees)'}")
    L.append(f"Sales ({rep.range}) last synced: {rep.sales_synced or 'NEVER (run sales-sync)'}; products with data: {rep.sales_rows}")
    L.append("")
    L.append("Cost components used in profit / floor:")
    extra = "INCLUDED" if rep.include_extra else "not included"
    rf = "INCLUDED" if rep.include_return_free else "not included"
    L.append("  included: commission from Digikala (the `commission` field only)")
    L.append(f"  extra_commission: {extra}; return_free_commission: {rf}  "
             "<- the meaning of these two is UNCONFIRMED (FLOOR_INCLUDE_EXTRA_COMMISSION / FLOOR_INCLUDE_RETURN_FREE_COMMISSION)")
    unset = []
    for c in COMPONENTS:
        n = rep.component_set.get(c, 0)
        if n:
            L.append(f"  included (manual): {COMP_FA[c]} - set for {n} of {rep.checked} variants")
        if n < rep.checked:
            unset.append(f"{COMP_FA[c]} ({rep.checked - n} variants)")
    if unset:
        L.append("  NOT included (unset, counted as 0 - real profit is lower than shown): " + "; ".join(unset))
    if rep.fees_assumed_max_brand:
        L.append(f"  commission: {rep.fees_assumed_max_brand} variants use the HIGHEST brand commission of their category "
                 "(fee_assumed_max_brand) because no brand is set (set-brand).")
    if rep.fees_assumed_single_brand:
        L.append(f"  commission: {rep.fees_assumed_single_brand} variants use the only brand row of their category "
                 "(fee_assumed_single_brand): that is ONE brand's rate, not the category rate.")
    L.append("")
    L.append("Floor status:")
    for k, n in sorted(rep.status_counts.items()):
        L.append(f"  {k}: {n}")
    if rep.errors:
        L.append(f"  error: {rep.errors} variants could not be evaluated and were skipped (SUDYAR_DEBUG=1 for details)")
    L.append("")
    L.append(f"Variants with zero/negative profit at the current price: {rep.low_profit_total}")
    L.append(f"Of those, SELLING (net_item_sold > 0, {rep.range}), most units first: {len(rep.sells_low_profit)} shown")
    if not rep.sales_rows:
        L.append("  (no sales data yet: run sales-sync)")
    for v, sold, amount, profit in rep.sells_low_profit:
        L.append(f"  {v.digikala_variant_id} | {(v.title or '')[:36]} | sold {sold} | profit/unit {profit:,.0f} toman | "
                 f"net_sales_amount {amount if amount is not None else '?'} (as returned)")
    L.append("  (sales are per product: variants of one product share the same numbers)")
    L.append("")
    L.append(f"Winning (Buy Box) price below our floor: {len(rep.below_floor)} shown")
    for v, win, floor, gap in rep.below_floor:
        L.append(f"  {v.digikala_variant_id} | {(v.title or '')[:36]} | win {win:,.0f} < floor {floor:,} (gap {gap:,.0f}) toman")
    L.append("")
    L.append("Suggestions only: nothing is changed on Digikala.")
    return "\n".join(L)
