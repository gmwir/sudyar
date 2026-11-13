"""Profit-floor engine. READ-ONLY toward Digikala; it only ever *suggests*, never changes a price.

net_profit = price - (buy_cost + commission + fulfillment/processing + tax + ad_share
                      + return_reserve + packaging)

Nothing is guessed:
- commission / fulfillment / tax come from Digikala read endpoints (GET), cached in fee_cache;
  if they are not available the status is "needs_fees".
- buy_cost comes from our own import / manual entry; missing -> manual floor, else "needs_cost".
- ad_share / return_reserve / packaging are YOUR settings (default 0 = not applied).
- the price unit (rial/toman) must be set by you; while unknown -> "needs_unit".
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
from .models import FeeCache, FloorEvent, FloorSetting, Variant, VariantCost

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


# ---------- units ----------
def to_toman(value: float | int | None, unit: str) -> float | None:
    """Rial -> Toman is /10. Unit 'unknown' (or anything else) -> None: we refuse to guess."""
    if value is None:
        return None
    if unit == "toman":
        return float(value)
    if unit == "rial":
        return value / 10
    return None


# ---------- fees ----------
FEE_FIELDS = ("commission_pct", "commission_fixed", "fulfillment_pct", "fulfillment_fixed", "tax_pct")


@dataclass(frozen=True)
class Fees:
    """Percent fields are % of the selling price; *_fixed are amounts in the PRICE unit."""

    commission_pct: float | None = None
    commission_fixed: float | None = None
    fulfillment_pct: float | None = None
    fulfillment_fixed: float | None = None
    tax_pct: float | None = None

    @property
    def has_commission(self) -> bool:
        return self.commission_pct is not None or self.commission_fixed is not None

    @property
    def missing(self) -> list[str]:
        return [f for f in FEE_FIELDS if getattr(self, f) is None]

    def to_dict(self) -> dict[str, float | None]:
        return {f: getattr(self, f) for f in FEE_FIELDS}


@dataclass(frozen=True)
class Extras:
    """Costs Digikala does not report. Set by the user; 0 = not applied."""

    ad_share_pct: float = 0.0
    return_reserve_pct: float = 0.0
    packaging_toman: float = 0.0

    @classmethod
    def from_settings(cls, s: Settings) -> "Extras":
        return cls(s.cost_ad_share_pct, s.cost_return_reserve_pct, s.cost_packaging_toman)


def _split(buy_cost: float, fees: Fees, extras: Extras, fixed_toman) -> tuple[float, float]:
    """(variable share of price, fixed costs in toman). fixed_toman converts price-unit amounts."""
    var = sum((fees.commission_pct or 0, fees.fulfillment_pct or 0, fees.tax_pct or 0,
               extras.ad_share_pct, extras.return_reserve_pct)) / 100
    fixed = buy_cost + extras.packaging_toman
    fixed += fixed_toman(fees.commission_fixed or 0) + fixed_toman(fees.fulfillment_fixed or 0)
    return var, fixed


def net_profit(price_toman: float, buy_cost: float, fees: Fees, extras: Extras, fixed_toman=lambda x: x) -> float:
    var, fixed = _split(buy_cost, fees, extras, fixed_toman)
    return price_toman * (1 - var) - fixed


def compute_floor(buy_cost: float, fees: Fees, extras: Extras, margin_pct: float | None,
                  min_profit: float | None, fixed_toman=lambda x: x) -> tuple[int | None, str]:
    """Smallest price (toman) with profit >= max(min_profit, margin% of price). None if impossible."""
    if margin_pct is None and min_profit is None:
        return None, "no_margin_or_min_profit"
    var, fixed = _split(buy_cost, fees, extras, fixed_toman)
    m = (margin_pct or 0) / 100
    if 1 - var <= 0 or 1 - var - m <= 0:
        return None, "margin_impossible"
    need = fixed / (1 - var - m)
    if min_profit is not None:
        need = max(need, (fixed + min_profit) / (1 - var))
    return math.ceil(need - 1e-9), "computed"


# ---------- fee provider (Digikala GET endpoints, cached) ----------
def _dig(data: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
    return data


def _num(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def parse_fees(responses: dict[str, Any], field_map: dict[str, str]) -> Fees:
    """field_map value: 'source:dotted.path' (source = commissions | calculator)."""
    vals: dict[str, float | None] = {}
    for f in FEE_FIELDS:
        spec = field_map.get(f)
        if not spec:
            vals[f] = None
            continue
        src, _, path = spec.rpartition(":")
        vals[f] = _num(_dig(responses.get(src or "commissions"), path))
    return Fees(**vals)


class FeeProvider:
    enabled_message = "Fee endpoints are not configured (FEES_* in .env, from the Swagger)."

    def __init__(self, client, settings: Settings):
        self.client, self.s = client, settings

    @property
    def enabled(self) -> bool:
        return bool(self.s.fees_field_map and (self.s.fees_commission_path or self.s.fees_calculator_path))

    async def get(self, session: Session, variant: Variant, now: datetime, allow_fetch: bool = True) -> Fees | None:
        """Fees for a variant from cache or Digikala (GET). None = unavailable (never guessed)."""
        key = variant.product_variant_id
        if not key:
            return None
        row = session.get(FeeCache, key)
        if row is not None:
            age = (now - _aware(row.fetched_at)).total_seconds()
            if age < self.s.fees_cache_seconds:
                return Fees(**row.data)
        if not (allow_fetch and self.enabled and self.client is not None):
            return None  # missing or stale and we may not fetch
        try:
            responses: dict[str, Any] = {}
            ctx = {"product_variant_id": key, "price": variant.price_sale if variant.price_sale is not None else ""}
            params = {k: str(v).format(**ctx) for k, v in self.s.fees_params.items()}
            if self.s.fees_commission_path:
                responses["commissions"] = await self.client.get(self.s.fees_commission_path, params)
            if self.s.fees_calculator_path:
                responses["calculator"] = await self.client.get(self.s.fees_calculator_path, params)
        except Exception as e:  # never break a cycle / report; message type only (no URL/headers)
            log.warning("fee lookup failed: %s", type(e).__name__)
            return None
        fees = parse_fees(responses, self.s.fees_field_map)
        if row is None:
            session.add(FeeCache(key=key, data=fees.to_dict(), fetched_at=now))
        else:
            row.data, row.fetched_at = fees.to_dict(), now
        session.flush()
        return fees


def _aware(dt: datetime) -> datetime:
    from datetime import timezone
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


# ---------- rule resolution ----------
def _field(raw: dict | None, dotted: str) -> str | None:
    if not dotted or not raw:
        return None
    v = _dig(raw, dotted)
    return None if v is None or isinstance(v, (dict, list)) else str(v)


def scope_keys(variant: Variant, s: Settings) -> dict[str, str | None]:
    return {
        "variant": variant.digikala_variant_id,
        "brand": _field(variant.raw_json, s.floor_brand_field),
        "category": _field(variant.raw_json, s.floor_category_field),
        "global": "",
    }


def _has_rule(r: FloorSetting) -> bool:
    return any(v is not None for v in (r.margin_pct, r.min_profit_toman, r.floor_manual_toman, r.floor_manual_pct))


def resolve_setting(session: Session, variant: Variant, s: Settings) -> FloorSetting | None:
    """Precedence variant > brand > category > global; rows that set nothing are skipped."""
    keys = scope_keys(variant, s)
    for scope in SCOPES:
        key = keys[scope]
        if key is None:
            continue
        row = session.scalar(select(FloorSetting).where(FloorSetting.scope == scope, FloorSetting.scope_key == key))
        if row is not None and _has_rule(row):
            return row
    return None


# ---------- evaluation ----------
@dataclass
class FloorResult:
    status: str
    floor_toman: int | None = None  # effective floor
    computed_floor_toman: int | None = None  # from cost + fees + margin
    reason: str = ""
    scope: str | None = None
    fees_missing: list[str] = field(default_factory=list)

    def as_details(self) -> dict[str, Any]:
        return {"status": self.status, "floor_toman": self.floor_toman,
                "computed_floor_toman": self.computed_floor_toman, "reason": self.reason, "scope": self.scope}


class FloorEngine:
    def __init__(self, settings: Settings, fee_provider: FeeProvider | None = None):
        self.s = settings
        self.fees = fee_provider or FeeProvider(None, settings)
        self.extras = Extras.from_settings(settings)

    def _fixed_converter(self):
        """Fixed fee amounts are in the price unit. Unknown unit -> None (refuse)."""
        unit = self.s.price_unit
        return lambda x: x if x == 0 else to_toman(x, unit)

    async def evaluate(self, session: Session, variant: Variant, now: datetime, allow_fetch: bool = True) -> FloorResult:
        setting = resolve_setting(session, variant, self.s)
        if setting is None:
            return FloorResult(NO_RULE, reason="no floor rule set (use set-floor)")
        cost_row = session.get(VariantCost, variant.id)
        cost = cost_row.buy_cost if cost_row is not None else None
        manual = []
        if setting.floor_manual_toman is not None:
            manual.append(setting.floor_manual_toman)
        if setting.floor_manual_pct is not None:
            cur = to_toman(variant.price_sale, self.s.price_unit)
            if cur is not None:
                manual.append(math.ceil(cur * setting.floor_manual_pct / 100))
            elif setting.floor_manual_toman is None:
                return FloorResult(NEEDS_UNIT, reason="manual % floor needs DIGIKALA_PRICE_UNIT", scope=setting.scope)
        manual_floor = max(manual) if manual else None

        if cost is None:  # never guess a cost
            if manual_floor is not None:
                return FloorResult(OK, manual_floor, None, "manual_floor_no_cost", setting.scope)
            return FloorResult(NEEDS_COST, reason="buy_cost missing", scope=setting.scope)

        if setting.margin_pct is None and setting.min_profit_toman is None:
            if manual_floor is not None:
                return FloorResult(OK, manual_floor, None, "manual_floor", setting.scope)
            return FloorResult(NO_RULE, reason="rule has no margin/min profit", scope=setting.scope)

        fees = await self.fees.get(session, variant, now, allow_fetch)
        if fees is None or not fees.has_commission:
            return FloorResult(NEEDS_FEES, reason="commission not available from Digikala", scope=setting.scope)
        conv = self._fixed_converter()
        if conv(fees.commission_fixed or 0) is None or conv(fees.fulfillment_fixed or 0) is None:
            return FloorResult(NEEDS_UNIT, reason="fixed fees need DIGIKALA_PRICE_UNIT", scope=setting.scope)
        computed, why = compute_floor(cost, fees, self.extras, setting.margin_pct, setting.min_profit_toman, conv)
        if computed is None:
            return FloorResult(IMPOSSIBLE, reason=why, scope=setting.scope, fees_missing=fees.missing)
        effective = max(computed, manual_floor or 0)
        reason = "computed" if effective == computed else "manual_floor_higher"
        return FloorResult(OK, effective, computed, reason, setting.scope, fees.missing)

    async def profit_now(self, session: Session, variant: Variant, now: datetime, allow_fetch: bool = False) -> float | None:
        """Net profit at our current price (toman). None unless cost, fees and unit are all known."""
        cost_row = session.get(VariantCost, variant.id)
        if cost_row is None or cost_row.buy_cost is None:
            return None
        price = to_toman(variant.price_sale, self.s.price_unit)
        fees = await self.fees.get(session, variant, now, allow_fetch)
        if price is None or fees is None or not fees.has_commission:
            return None
        conv = self._fixed_converter()
        if conv(fees.commission_fixed or 0) is None or conv(fees.fulfillment_fixed or 0) is None:
            return None
        return net_profit(price, cost_row.buy_cost, fees, self.extras, conv)

    def label(self, result: FloorResult, win_price_toman: float | None) -> str:
        if result.status != OK:
            return result.status
        if win_price_toman is None or result.floor_toman is None:
            return UNKNOWN
        return CAN_WIN if win_price_toman >= result.floor_toman else NEED_BELOW

    def win_price_toman(self, suggested_price: int | None, buy_box_price: int | None) -> float | None:
        """Price needed to win: Digikala's suggested price if we have it, else the Buy Box price."""
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
    reason = f"{result.status}:{result.reason}"[:200]
    last = session.scalar(select(FloorEvent).where(FloorEvent.variant_id == variant.id)
                          .order_by(FloorEvent.ts.desc(), FloorEvent.id.desc()).limit(1))
    if last and (last.floor, last.suggested_floor, last.reason) == (result.floor_toman, result.computed_floor_toman, reason):
        return None
    ev = FloorEvent(variant_id=variant.id, floor=result.floor_toman, suggested_floor=result.computed_floor_toman,
                    reason=reason, ts=now)
    session.add(ev)
    session.flush()
    return ev


def set_floor_rule(session: Session, scope: str, key: str = "", *, margin_pct=None, min_profit_toman=None,
                   floor_manual_toman=None, floor_manual_pct=None) -> FloorSetting:
    """Create/update one rule (idempotent). Only the values given are changed."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}")
    if scope != "global" and not key:
        raise ValueError(f"scope '{scope}' needs a key (variant id / brand / category)")
    for name, v in (("margin_pct", margin_pct), ("min_profit_toman", min_profit_toman),
                    ("floor_manual_toman", floor_manual_toman), ("floor_manual_pct", floor_manual_pct)):
        if v is not None and v < 0:
            raise ValueError(f"{name} must not be negative")
    if margin_pct is not None and margin_pct >= 100:
        raise ValueError("margin_pct must be below 100")
    key = "" if scope == "global" else key
    row = session.scalar(select(FloorSetting).where(FloorSetting.scope == scope, FloorSetting.scope_key == key))
    if row is None:
        row = FloorSetting(scope=scope, scope_key=key)
        session.add(row)
    for name, v in (("margin_pct", margin_pct), ("min_profit_toman", min_profit_toman),
                    ("floor_manual_toman", floor_manual_toman), ("floor_manual_pct", floor_manual_pct)):
        if v is not None:
            setattr(row, name, v)
    session.commit()
    return row
