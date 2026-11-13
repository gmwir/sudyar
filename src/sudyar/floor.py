"""Profit-floor engine. READ-ONLY toward Digikala; it only ever *suggests*, never changes a price.

net_profit = price - (buy_cost + commission + fulfillment + tax + ad_share + return_reserve + packaging)

Where each number comes from (nothing is guessed):
- commission: Digikala GET /commissions/ (the `commission` fraction), see fees.py.
- buy_cost: our own import / manual entry (Toman). Missing -> manual floor, else "needs_cost".
- fulfillment, tax, ad_share, return_reserve, packaging: NO Digikala endpoint exists for them, so they
  are explicit manual settings (% of price and/or Toman) in floor_settings. Unset = NOT included,
  and every report/alert says so.
- UNITS: Digikala prices are RIAL. All floor math is in TOMAN (rial / 10). Names say which is which.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .fees import FeeProvider, Fees
from .models import FloorEvent, FloorSetting, Variant, VariantBrand, VariantCost

log = logging.getLogger(__name__)

OK = "ok"
NEEDS_COST = "needs_cost"
NEEDS_FEES = "needs_fees"
NEEDS_UNIT = "needs_unit"
NO_RULE = "no_rule"
IMPOSSIBLE = "impossible"

CAN_WIN = "can_win_above_floor"
NEED_BELOW = "would_need_below_floor"
UNKNOWN = "unknown"

SCOPES = ("variant", "brand", "category", "global")  # precedence, most specific first
COMPONENTS = ("fulfillment", "tax", "ad_share", "return_reserve", "packaging")


# ---------- units ----------
def to_toman(value: float | int | None, unit: str) -> float | None:
    """Convert a price in `unit` (rial|toman) to Toman. Rial -> Toman is /10. Other unit -> None."""
    if value is None:
        return None
    if unit == "toman":
        return float(value)
    if unit == "rial":
        return value / 10
    return None


# ---------- cost components (manual) ----------
@dataclass(frozen=True)
class Components:
    pct: dict[str, float | None] = field(default_factory=dict)  # % of selling price
    toman: dict[str, float | None] = field(default_factory=dict)  # fixed Toman per unit

    @property
    def total_pct(self) -> float:
        return sum(v or 0 for v in self.pct.values())

    @property
    def total_toman(self) -> float:
        return sum(v or 0 for v in self.toman.values())

    @property
    def included(self) -> list[str]:
        return [c for c in COMPONENTS if self.pct.get(c) is not None or self.toman.get(c) is not None]

    @property
    def unset(self) -> list[str]:
        return [c for c in COMPONENTS if c not in self.included]


NO_COMPONENTS = Components()


# ---------- math (all in Toman) ----------
def net_profit(price_toman: float, buy_cost_toman: float, commission_pct: float,
               comps: Components = NO_COMPONENTS) -> float:
    var = (commission_pct + comps.total_pct) / 100
    return price_toman * (1 - var) - (buy_cost_toman + comps.total_toman)


def compute_floor(buy_cost_toman: float, commission_pct: float, comps: Components, margin_pct: float | None,
                  min_profit_toman: float | None) -> tuple[int | None, str]:
    """Smallest price (Toman) with profit >= max(min_profit, margin% of price). None if impossible."""
    if margin_pct is None and min_profit_toman is None:
        return None, "no_margin_or_min_profit"
    if not all(math.isfinite(x) for x in (buy_cost_toman, commission_pct, margin_pct or 0, min_profit_toman or 0,
                                           comps.total_pct, comps.total_toman)):
        return None, "invalid_input"
    var = (commission_pct + comps.total_pct) / 100
    fixed = buy_cost_toman + comps.total_toman
    m = (margin_pct or 0) / 100
    if 1 - var <= 0 or 1 - var - m <= 0:
        return None, "margin_impossible"
    need = fixed / (1 - var - m)
    if min_profit_toman is not None:
        need = max(need, (fixed + min_profit_toman) / (1 - var))
    return math.ceil(need - 1e-9), "computed"


# ---------- rule resolution ----------
def _field(raw: dict | None, dotted: str) -> str | None:
    if not dotted or not raw:
        return None
    v: Any = raw
    for part in dotted.split("."):
        if not isinstance(v, dict):
            return None
        v = v.get(part)
    return None if v is None or isinstance(v, (dict, list, bool)) else str(v)


def _pos_finite(v: float | int | None) -> bool:
    return v is not None and not isinstance(v, bool) and math.isfinite(v) and v > 0


def variant_brand_id(session: Session, variant: Variant) -> str | None:
    """Brand only if the user set it manually (variants carry no brand field)."""
    row = session.get(VariantBrand, variant.id)
    return row.brand_id if row else None


def scope_keys(session: Session, variant: Variant, s: Settings) -> dict[str, str | None]:
    return {
        "variant": variant.digikala_variant_id,
        "brand": variant_brand_id(session, variant),
        "category": _field(variant.raw_json, s.floor_category_field),
        "global": "",
    }


def _scope_rows(session: Session, variant: Variant, s: Settings) -> list[FloorSetting]:
    keys = scope_keys(session, variant, s)
    out = []
    for scope in SCOPES:
        if keys[scope] is None:
            continue
        row = session.scalar(select(FloorSetting).where(FloorSetting.scope == scope,
                                                        FloorSetting.scope_key == keys[scope]))
        if row is not None:
            out.append(row)
    return out


def _has_rule(r: FloorSetting) -> bool:
    return any(v is not None for v in (r.margin_pct, r.min_profit_toman, r.floor_manual_toman, r.floor_manual_pct))


def resolve_setting(session: Session, variant: Variant, s: Settings) -> FloorSetting | None:
    """Margin / minimum profit / manual floor: variant > brand > category > global (rows setting none are skipped)."""
    for row in _scope_rows(session, variant, s):
        if _has_rule(row):
            return row
    return None


def resolve_components(session: Session, variant: Variant, s: Settings) -> Components:
    """Each cost component is looked up on its own, most specific scope first."""
    rows = _scope_rows(session, variant, s)
    pct: dict[str, float | None] = {}
    toman: dict[str, float | None] = {}
    for c in COMPONENTS:
        pct[c] = next((getattr(r, f"{c}_pct") for r in rows if getattr(r, f"{c}_pct") is not None), None)
        toman[c] = next((getattr(r, f"{c}_toman") for r in rows if getattr(r, f"{c}_toman") is not None), None)
    return Components(pct, toman)


# ---------- evaluation ----------
@dataclass
class FloorResult:
    status: str
    floor_toman: int | None = None  # effective floor
    computed_floor_toman: int | None = None  # from cost + commission + components + margin
    reason: str = ""
    scope: str | None = None
    fee_reason: str | None = None  # fee_category_row | fee_brand_row | fee_assumed_max_brand
    commission_pct: float | None = None
    included_components: list[str] = field(default_factory=list)
    unset_components: list[str] = field(default_factory=list)

    def as_details(self) -> dict[str, Any]:
        return {"status": self.status, "floor_toman": self.floor_toman,
                "computed_floor_toman": self.computed_floor_toman, "reason": self.reason, "scope": self.scope,
                "fee_reason": self.fee_reason, "commission_pct": self.commission_pct,
                "unset_components": self.unset_components}


class FloorEngine:
    def __init__(self, settings: Settings, fee_provider: FeeProvider | None = None):
        self.s = settings
        self.fees = fee_provider or FeeProvider(None, settings)

    async def _fees_for(self, session: Session, variant: Variant, now: datetime, allow_fetch: bool) -> Fees | None:
        category = _field(variant.raw_json, self.s.floor_category_field)
        return await self.fees.get(session, category, variant_brand_id(session, variant), now, allow_fetch)

    async def evaluate(self, session: Session, variant: Variant, now: datetime, allow_fetch: bool = True) -> FloorResult:
        setting = resolve_setting(session, variant, self.s)
        if setting is None:
            return FloorResult(NO_RULE, reason="no floor rule set (use set-floor)")
        cost_row = session.get(VariantCost, variant.id)
        cost = cost_row.buy_cost if cost_row is not None else None
        manual = []
        # Only positive, finite manual values count (older/hand-edited rows with 0, NaN or inf are ignored).
        if _pos_finite(setting.floor_manual_toman):
            manual.append(setting.floor_manual_toman)
        if _pos_finite(setting.floor_manual_pct):
            cur_toman = to_toman(variant.price_sale, self.s.price_unit)
            if cur_toman is not None:
                manual.append(math.ceil(cur_toman * setting.floor_manual_pct / 100))
            elif not manual:
                return FloorResult(NEEDS_UNIT, reason="manual % floor needs DIGIKALA_PRICE_UNIT", scope=setting.scope)
        manual_floor = max(manual) if manual else None
        raised = False
        if manual_floor is not None and cost is not None and manual_floor < cost:
            manual_floor, raised = cost, True  # a manual floor can never be below the known buy cost

        if cost is None:  # never guess a cost
            if manual_floor is not None:
                return FloorResult(OK, manual_floor, None, "manual_floor_no_cost", setting.scope)
            return FloorResult(NEEDS_COST, reason="buy_cost missing", scope=setting.scope)
        if setting.margin_pct is None and setting.min_profit_toman is None:
            if manual_floor is not None:
                return FloorResult(OK, manual_floor, None, "manual_floor_raised_to_cost" if raised else "manual_floor",
                                   setting.scope)
            return FloorResult(NO_RULE, reason="rule has no margin/min profit", scope=setting.scope)

        fees = await self._fees_for(session, variant, now, allow_fetch)
        if fees is None:
            category = _field(variant.raw_json, self.s.floor_category_field)
            return FloorResult(NEEDS_FEES, reason=self.fees.miss_reason(session, category, now), scope=setting.scope)
        comps = resolve_components(session, variant, self.s)
        computed, why = compute_floor(cost, fees.commission_pct, comps, setting.margin_pct, setting.min_profit_toman)
        base = dict(scope=setting.scope, fee_reason=fees.reason, commission_pct=fees.commission_pct,
                    included_components=comps.included, unset_components=comps.unset)
        if computed is None:
            return FloorResult(IMPOSSIBLE, reason=why, **base)
        effective = max(computed, manual_floor or 0)
        reason = "computed" if effective == computed else "manual_floor_higher"
        return FloorResult(OK, effective, computed, reason, **base)

    async def profit_now(self, session: Session, variant: Variant, now: datetime, allow_fetch: bool = False) -> float | None:
        """Net profit per unit at our current price, in Toman. None unless cost, commission and unit are known."""
        cost_row = session.get(VariantCost, variant.id)
        if cost_row is None or cost_row.buy_cost is None:
            return None
        price = to_toman(variant.price_sale, self.s.price_unit)
        fees = await self._fees_for(session, variant, now, allow_fetch)
        if price is None or fees is None:
            return None
        comps = resolve_components(session, variant, self.s)
        return net_profit(price, cost_row.buy_cost, fees.commission_pct, comps)

    def label(self, result: FloorResult, win_price_toman: float | None) -> str:
        if result.status != OK:
            return result.status
        if win_price_toman is None or result.floor_toman is None:
            return UNKNOWN
        return CAN_WIN if win_price_toman >= result.floor_toman else NEED_BELOW

    def win_price_toman(self, suggested_price: int | None, buy_box_price: int | None) -> float | None:
        """Price needed to win, in Toman: Digikala's suggested price (Rial) if we have it, else the Buy Box price."""
        if suggested_price is not None:
            return to_toman(suggested_price, self.s.suggested_price_unit)
        return to_toman(buy_box_price, self.s.price_unit)

    async def assess_loss(self, session: Session, variant: Variant, suggested_price: int | None,
                          buy_box_price: int | None, now: datetime) -> dict[str, Any]:
        """Label a Buy Box loss. Suggestion only: nothing is ever changed on Digikala."""
        result = await self.evaluate(session, variant, now)
        win = self.win_price_toman(suggested_price, buy_box_price)
        record_floor_event(session, variant, result, now)
        d = result.as_details()
        d.update(label=self.label(result, win), win_price_toman=win)
        return d


def record_floor_event(session: Session, variant: Variant, result: FloorResult, now: datetime) -> FloorEvent | None:
    """Insert a floor_events row only when floor / reason changed since the last one."""
    reason = f"{result.status}:{result.reason}"
    if result.fee_reason:
        reason += f"+{result.fee_reason}"
    reason = reason[:200]
    last = session.scalar(select(FloorEvent).where(FloorEvent.variant_id == variant.id)
                          .order_by(FloorEvent.ts.desc(), FloorEvent.id.desc()).limit(1))
    if last and (last.floor, last.suggested_floor, last.reason) == (result.floor_toman, result.computed_floor_toman, reason):
        return None
    ev = FloorEvent(variant_id=variant.id, floor=result.floor_toman, suggested_floor=result.computed_floor_toman,
                    reason=reason, ts=now)
    session.add(ev)
    session.flush()
    return ev


# ---------- writing OUR OWN settings (never Digikala) ----------
RULE_FIELDS = ("margin_pct", "min_profit_toman", "floor_manual_toman", "floor_manual_pct")
COMPONENT_FIELDS = tuple(f"{c}_{u}" for c in COMPONENTS for u in ("pct", "toman"))


MAX_TOMAN = 10**12  # 1 trillion Toman: far above any real price, far below database limits
MAX_MANUAL_PCT = 1000.0  # a manual floor may exceed the current price, but not absurdly


def _check_value(name: str, v: float | int) -> None:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"{name} must be a finite number")
    if name in ("floor_manual_toman", "floor_manual_pct"):
        if v <= 0:
            raise ValueError(f"{name} must be greater than 0 (a manual floor of 0 means nothing)")
    elif v < 0:
        raise ValueError(f"{name} must not be negative")
    if name == "floor_manual_pct":
        if v > MAX_MANUAL_PCT:
            raise ValueError(f"{name} must be at most {MAX_MANUAL_PCT:g}")
    elif name.endswith("_pct"):
        if v >= 100:
            raise ValueError(f"{name} must be below 100")
    elif v > MAX_TOMAN:
        raise ValueError(f"{name} must be at most {MAX_TOMAN:,} Toman")


def set_floor_rule(session: Session, scope: str, key: str = "", **values: float | None) -> FloorSetting:
    """Create/update one rule (idempotent). Only the values given are changed. Component scopes are
    global/category (variant/brand also accepted). Unknown or non-finite/out-of-range values are rejected."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}")
    if scope != "global" and not key:
        raise ValueError(f"scope '{scope}' needs a key (variant id / brand_id / category_id)")
    if len(str(key)) > 200:
        raise ValueError("key is too long")
    for name, v in values.items():
        if name not in RULE_FIELDS + COMPONENT_FIELDS:
            raise ValueError(f"unknown setting '{name}'")
        if v is not None:
            _check_value(name, v)
    key = "" if scope == "global" else str(key)
    row = session.scalar(select(FloorSetting).where(FloorSetting.scope == scope, FloorSetting.scope_key == key))
    if row is None:
        row = FloorSetting(scope=scope, scope_key=key)
        session.add(row)
    for name, v in values.items():
        if v is not None:
            setattr(row, name, v)
    session.commit()
    return row


def set_variant_brand(session: Session, digikala_variant_id: str, brand_id: str, now: datetime | None = None) -> VariantBrand:
    """Manual brand link; brand_id must exist in the synced commissions (run sync-fees first)."""
    from .models import Commission, utcnow

    v = session.scalar(select(Variant).where(Variant.digikala_variant_id == str(digikala_variant_id)))
    if v is None:
        raise ValueError(f"variant '{digikala_variant_id}' not found")
    if session.scalar(select(Commission.id).limit(1)) is None:
        raise ValueError("no commissions stored yet: run sync-fees first")
    if session.scalar(select(Commission.id).where(Commission.brand_id == str(brand_id)).limit(1)) is None:
        raise ValueError(f"brand_id '{brand_id}' not found in commissions (see list-brands)")
    row = session.get(VariantBrand, v.id)
    if row is None:
        row = VariantBrand(variant_id=v.id, brand_id=str(brand_id), updated_at=now or utcnow())
        session.add(row)
    else:
        row.brand_id, row.updated_at = str(brand_id), now or utcnow()
    session.commit()
    return row
