"""Pricing bot (Part 6). Decides a new selling price per variant and applies it through DigikalaWriter.

Hard guarantees (checked in decide(), in this order of priority):
- No profit floor ("ok" status from FloorEngine) -> NO change. The bot never prices blind.
- Never below the floor. Never above the rule ceiling (max_toman). Never outside Digikala's allowed boundary.
- One action never moves the price more than REPRICE_MAX_CHANGE_PCT.
- Per variant: at most REPRICE_MAX_CHANGES_PER_DAY applied changes, and REPRICE_COOLDOWN_SECONDS between them.
- WRITE_MODE=off (default) -> decisions are recorded, nothing is sent. dry_run -> recorded in write_log too.

Strategies:
  buybox   : Digikala's own winning-price suggestion (GET winning-price), else Buy Box price minus one step.
  undercut : Buy Box price minus gap_toman or gap_pct.
  rank     : Digikala's nth-rank suggestion for target_rank.
  fx       : fx_base_amount x rate(fx_currency) x (1 + fx_markup_pct).
  hold     : never changes the price (keeps the rule for later).
When we already win and nobody challenges us, raise_when_alone steps the price UP (raise_step_pct) toward the
ceiling — never above it. Without a ceiling the bot does not raise.
Units: Digikala prices are Rial; floors, gaps and ceilings are Toman (x10).
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .floor import OK, FloorEngine
from .models import FxRate, RepriceAction, RepriceRule, Variant, utcnow
from .writer import DigikalaWriter, WriteDisabled

log = logging.getLogger(__name__)

STRATEGIES = ("buybox", "undercut", "rank", "fx", "hold")
RIAL_PER_TOMAN = 10


@dataclass
class Inputs:
    current_rial: int | None
    floor_toman: int | None
    floor_ok: bool
    buy_box_rial: int | None = None
    suggested_rial: int | None = None  # winning-price (or nth-rank) suggestion
    is_winner: bool | None = None
    in_challenge: bool | None = None
    boundary_min_rial: int | None = None
    boundary_max_rial: int | None = None
    fx_rate_toman: float | None = None


@dataclass
class Decision:
    new_rial: int | None
    reason: str


def _round_up(v: float, step: int) -> int:
    return int(math.ceil(v / step) * step)


def _round_down(v: float, step: int) -> int:
    return int(math.floor(v / step) * step)


def target_price(rule: RepriceRule, inp: Inputs, s: Settings) -> tuple[float | None, str]:
    """The price the strategy wants (Rial, unrounded) before any guard. None = nothing to do."""
    step = s.reprice_round_rial
    st = rule.strategy
    if st == "hold":
        return None, "strategy hold"
    if st == "fx":
        if not (rule.fx_base_amount and rule.fx_base_amount > 0 and inp.fx_rate_toman and inp.fx_rate_toman > 0):
            return None, "fx: base amount or exchange rate missing"
        toman = rule.fx_base_amount * inp.fx_rate_toman * (1 + (rule.fx_markup_pct or 0) / 100)
        return toman * RIAL_PER_TOMAN, "fx price"
    # competitive strategies
    if inp.is_winner and not inp.in_challenge:
        if rule.raise_when_alone and rule.max_toman:
            pct = rule.raise_step_pct if rule.raise_step_pct is not None else s.reprice_raise_step_pct
            if pct <= 0 or inp.current_rial is None:
                return None, "winner: keep price"
            return inp.current_rial * (1 + pct / 100), "winner alone: step up toward ceiling"
        return None, "winner: keep price"
    if st == "undercut":
        if inp.buy_box_rial is None:
            return None, "undercut: Buy Box price unknown"
        if rule.gap_toman:
            return inp.buy_box_rial - rule.gap_toman * RIAL_PER_TOMAN, "undercut by amount"
        if rule.gap_pct:
            return inp.buy_box_rial * (1 - rule.gap_pct / 100), "undercut by percent"
        return inp.buy_box_rial - step, "undercut by one step"
    if st in ("buybox", "rank"):
        if inp.suggested_rial is not None:
            return inp.suggested_rial, "Digikala suggested price" + (" (rank)" if st == "rank" else "")
        if st == "buybox" and inp.buy_box_rial is not None:
            return inp.buy_box_rial - step, "Buy Box price minus one step"
        return None, "no suggested price"
    return None, f"unknown strategy {st}"


def decide(rule: RepriceRule, inp: Inputs, s: Settings) -> Decision:
    if not rule.enabled:
        return Decision(None, "rule disabled")
    if not inp.floor_ok or not inp.floor_toman or inp.floor_toman <= 0:
        return Decision(None, "no profit floor: bot does not change this price")
    if inp.current_rial is None or inp.current_rial <= 0:
        return Decision(None, "current price unknown")
    target, why = target_price(rule, inp, s)
    if target is None or not math.isfinite(target):
        return Decision(None, why)
    step = s.reprice_round_rial
    floor_rial = inp.floor_toman * RIAL_PER_TOMAN
    ceiling_rial = rule.max_toman * RIAL_PER_TOMAN if rule.max_toman else None
    notes = [why]
    # max move per action
    lim = inp.current_rial * s.reprice_max_change_pct / 100
    if abs(target - inp.current_rial) > lim:
        target = inp.current_rial + math.copysign(lim, target - inp.current_rial)
        notes.append(f"limited to {s.reprice_max_change_pct:g}% per action")
    target = round(target)  # whole Rial first, so float noise never adds a rounding step
    new = _round_down(target, step) if target < inp.current_rial else _round_up(target, step)
    # hard limits: floor first (never sell below it), then ceiling and Digikala's boundary
    lo = max(floor_rial, inp.boundary_min_rial or 0)
    hi_parts = [x for x in (ceiling_rial, inp.boundary_max_rial) if x]
    hi = min(hi_parts) if hi_parts else None
    if hi is not None and lo > hi:
        return Decision(None, "floor is above the ceiling/allowed maximum: no change")
    if new < lo:
        new = _round_up(lo, step)
        notes.append("held at floor" if lo == floor_rial else "held at Digikala minimum")
    if hi is not None and new > hi:
        new = _round_down(hi, step)
        if new < lo:
            return Decision(None, "no rounded price between floor and ceiling")
        notes.append("held at ceiling")
    if abs(new - inp.current_rial) < step:
        return Decision(None, "; ".join(notes + ["already at target"]))
    return Decision(int(new), "; ".join(notes))


# ---------------------------------------------------------------------- caps
def applied_today(session: Session, variant_id: int, now: datetime) -> int:
    return session.scalar(select(func.count()).select_from(RepriceAction).where(
        RepriceAction.variant_id == variant_id, RepriceAction.applied.is_(True),
        RepriceAction.ts >= now - timedelta(days=1))) or 0


def last_applied(session: Session, variant_id: int) -> datetime | None:
    return session.scalar(select(func.max(RepriceAction.ts)).where(
        RepriceAction.variant_id == variant_id, RepriceAction.applied.is_(True)))


def caps_block(session: Session, variant_id: int, now: datetime, s: Settings) -> str | None:
    if applied_today(session, variant_id, now) >= s.reprice_max_changes_per_day:
        return "daily change limit reached"
    last = last_applied(session, variant_id)
    if last is not None:
        if last.tzinfo is None:
            from datetime import timezone
            last = last.replace(tzinfo=timezone.utc)
        if (now - last).total_seconds() < s.reprice_cooldown_seconds:
            return "cooldown"
    return None


# ---------------------------------------------------------------------- rules
def set_rule(session: Session, digikala_variant_id: str, **values: Any) -> RepriceRule:
    v = session.scalar(select(Variant).where(Variant.digikala_variant_id == str(digikala_variant_id)))
    if v is None:
        raise ValueError(f"variant {digikala_variant_id} not found (run sync-variants first)")
    st = values.get("strategy")
    if st is not None and st not in STRATEGIES:
        raise ValueError(f"strategy must be one of {', '.join(STRATEGIES)}")
    for k in ("gap_toman", "max_toman", "target_rank"):
        if values.get(k) is not None and values[k] <= 0:
            raise ValueError(f"{k} must be positive")
    for k in ("gap_pct", "raise_step_pct", "fx_markup_pct"):
        x = values.get(k)
        if x is not None and (not math.isfinite(x) or not 0 <= x <= 90):
            raise ValueError(f"{k} must be between 0 and 90")
    row = session.get(RepriceRule, v.id) or RepriceRule(variant_id=v.id, strategy="buybox", enabled=True,
                                                         raise_when_alone=True)
    for k, x in values.items():
        if x is not None:
            setattr(row, k, x)
    if row.strategy == "rank" and not row.target_rank:
        raise ValueError("rank strategy needs target_rank")
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    return row


def set_fx_rate(session: Session, currency: str, toman_per_unit: float) -> FxRate:
    cur = currency.strip().upper()
    if not cur.isalpha() or len(cur) > 8:
        raise ValueError("currency must be letters, e.g. USD")
    if not (math.isfinite(toman_per_unit) and toman_per_unit > 0):
        raise ValueError("rate must be a positive number")
    row = session.get(FxRate, cur) or FxRate(currency=cur)
    row.toman_per_unit = toman_per_unit
    row.updated_at = utcnow()
    session.add(row)
    session.commit()
    return row


# ---------------------------------------------------------------------- runner
@dataclass
class CycleReport:
    checked: int = 0
    changed: int = 0
    skipped: int = 0
    errors: int = 0


class Repricer:
    def __init__(self, client, writer: DigikalaWriter, factory: sessionmaker[Session], settings: Settings,
                 floor_engine: FloorEngine):
        self.client = client
        self.writer = writer
        self.factory = factory
        self.s = settings
        self.floor = floor_engine

    async def _inputs(self, session: Session, rule: RepriceRule, v: Variant, now: datetime) -> Inputs:
        fr = await self.floor.evaluate(session, v, now)
        inp = Inputs(current_rial=v.price_sale, floor_toman=fr.floor_toman, floor_ok=fr.status == OK,
                     buy_box_rial=v.buy_box_price, is_winner=v.is_seller_buy_box_winner,
                     in_challenge=v.is_in_buy_box_challenge)
        if not inp.floor_ok or rule.strategy == "hold":
            return inp
        if rule.strategy == "fx" and rule.fx_currency:
            r = session.get(FxRate, rule.fx_currency.upper())
            inp.fx_rate_toman = r.toman_per_unit if r else None
        pvid = v.product_variant_id or v.digikala_variant_id
        if rule.strategy == "buybox" and not (inp.is_winner and not inp.in_challenge):
            inp.suggested_rial = await self.client.get_winning_price(pvid)
        elif rule.strategy == "rank" and rule.target_rank:
            inp.suggested_rial = await self.client.get_nth_rank_winning_price(pvid, rule.target_rank)
        try:
            b = await self.client.get_price_boundary(int(v.digikala_variant_id))
        except Exception as e:  # boundary is a safety extra; the floor/ceiling still apply
            log.info("boundary unavailable for %s: %s", v.digikala_variant_id, type(e).__name__)
            b = None
        if b:
            inp.boundary_min_rial = b.get("min_allowed_price") or None
            inp.boundary_max_rial = b.get("max_allowed_price") or None
        return inp

    async def run_once(self, now: datetime | None = None, only_variant: str | None = None) -> CycleReport:
        now = now or utcnow()
        rep = CycleReport()
        with self.factory() as session:
            q = select(RepriceRule, Variant).join(Variant, Variant.id == RepriceRule.variant_id).where(
                RepriceRule.enabled.is_(True), Variant.active.is_(True))
            if only_variant:
                q = q.where(Variant.digikala_variant_id == str(only_variant))
            pairs = session.execute(q).all()
            for rule, v in pairs:
                rep.checked += 1
                try:
                    applied, d = await self._one(session, rule, v, now)
                except Exception as e:
                    rep.errors += 1
                    log.warning("reprice %s failed: %s", v.digikala_variant_id, type(e).__name__)
                    session.add(RepriceAction(variant_id=v.id, ts=now, old_price=v.price_sale, new_price=None,
                                              reason=f"error: {type(e).__name__}"[:200], mode=self.s.write_mode,
                                              applied=False))
                    session.commit()
                    continue
                if applied:
                    rep.changed += 1
                else:
                    rep.skipped += 1
        return rep

    async def _one(self, session: Session, rule: RepriceRule, v: Variant, now: datetime) -> tuple[bool, Decision]:
        old = v.price_sale
        block = caps_block(session, v.id, now, self.s)
        if block:
            d = Decision(None, block)
        else:
            d = decide(rule, await self._inputs(session, rule, v, now), self.s)
        applied = False
        reason = d.reason
        if d.new_rial is not None:
            try:
                await self.writer.write("variant_update", {"selling_price": d.new_rial},
                                        params={"variant_id": int(v.digikala_variant_id)},
                                        target=v.digikala_variant_id, source="repricer")
                applied = self.s.write_mode == "live"
                if applied:
                    v.price_sale = d.new_rial
            except WriteDisabled:
                reason = (reason + "; WRITE_MODE=off (not sent)")[:200]
        session.add(RepriceAction(variant_id=v.id, ts=now, old_price=old,
                                  new_price=d.new_rial, reason=reason[:200], mode=self.s.write_mode, applied=applied))
        session.commit()
        return applied, d


async def create_smart_discount(writer: DigikalaWriter, floor: FloorEngine, session: Session, v: Variant,
                                price_toman: int, limit: int, order_limit: int, start: datetime, end: datetime,
                                now: datetime) -> dict[str, Any]:
    """Digikala smart discount (periodic price) for one variant, refused below the profit floor."""
    fr = await floor.evaluate(session, v, now)
    if fr.status != OK or not fr.floor_toman:
        raise ValueError("no profit floor for this variant: smart discount refused")
    if price_toman < fr.floor_toman:
        raise ValueError(f"price is below the profit floor ({fr.floor_toman:,} Toman)")
    if not (0 < order_limit <= limit) or end <= start:
        raise ValueError("limits or dates are invalid")
    body = {"data": [{"variantId": int(v.digikala_variant_id), "promotionPrice": price_toman * RIAL_PER_TOMAN,
                      "limit": limit, "orderLimit": order_limit,
                      "startedAt": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "endAt": end.strftime("%Y-%m-%dT%H:%M:%SZ")}]}
    return await writer.write("smart_discount_create", body, target=v.digikala_variant_id, source="smart_discount")
