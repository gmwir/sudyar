"""Buy Box radar: read -> snapshot -> compare with previous snapshot -> events (+ alerts).

READ-ONLY toward Digikala (GET only, through the shared rate limiter).
Nothing here is guessed: anything the API did not give us is reported as unknown.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .digikala_client import DigikalaClient
from .models import RadarEvent, Variant, VariantSnapshot, utcnow
from .sync import add_snapshot, parse_variant, upsert_variant
from .tiers import (CALM, HOT, TIERS, WARM, aware, classify_tiers, due_variants,
                    estimate_requests_per_minute, last_snapshot_times, max_pages_per_tick, plan_pages)

log = logging.getLogger(__name__)

BUYBOX_LOST = "BUYBOX_LOST"
BUYBOX_REGAINED = "BUYBOX_REGAINED"
ENTERED_CHALLENGE = "ENTERED_CHALLENGE"
LEFT_CHALLENGE = "LEFT_CHALLENGE"
PRICE_CHANGED = "PRICE_CHANGED"
STOCK_OUT = "STOCK_OUT"
STOCK_BACK = "STOCK_BACK"
DEACTIVATED = "DEACTIVATED"
EVENT_TYPES = (BUYBOX_LOST, BUYBOX_REGAINED, ENTERED_CHALLENGE, LEFT_CHALLENGE,
               PRICE_CHANGED, STOCK_OUT, STOCK_BACK, DEACTIVATED)


def detect_events(prev: VariantSnapshot, new: dict[str, Any]) -> list[tuple[str, Any, Any]]:
    """Compare the previous snapshot with fresh data. Unknown (None) never produces an event."""
    out: list[tuple[str, Any, Any]] = []
    pw, nw = prev.is_seller_buy_box_winner, new.get("is_seller_buy_box_winner")
    if pw is True and nw is False:
        out.append((BUYBOX_LOST, pw, nw))
    elif pw is False and nw is True:
        out.append((BUYBOX_REGAINED, pw, nw))
    pc, nc = prev.is_in_buy_box_challenge, new.get("is_in_buy_box_challenge")
    if pc is False and nc is True:
        out.append((ENTERED_CHALLENGE, pc, nc))
    elif pc is True and nc is False:
        out.append((LEFT_CHALLENGE, pc, nc))
    pp, np_ = prev.price_sale, new.get("price_sale")
    if pp is not None and np_ is not None and pp != np_:
        out.append((PRICE_CHANGED, pp, np_))
    ps, ns = prev.stock, new.get("stock")
    if ps is not None and ps > 0 and ns == 0:
        out.append((STOCK_OUT, ps, ns))
    elif ps == 0 and ns is not None and ns > 0:
        out.append((STOCK_BACK, ps, ns))
    if prev.active is True and new.get("active") is False:
        out.append((DEACTIVATED, True, False))
    return out


def determine_cause(new: dict[str, Any]) -> dict[str, Any]:
    """Cause v1 for BUYBOX_LOST. Only: stock_out, inactive, price_above, else unknown.

    gap_abs = our price_sale - buy_box_price; gap_pct = gap_abs / buy_box_price * 100.
    (UNVERIFIED: that price_sale and buy_box_price are directly comparable.)
    """
    ours, bb = new.get("price_sale"), new.get("buy_box_price")
    info: dict[str, Any] = {"cause": "unknown", "gap_abs": None, "gap_pct": None}
    if ours is not None and bb:
        info["gap_abs"] = ours - bb
        info["gap_pct"] = round((ours - bb) / bb * 100, 2)
    if new.get("stock") == 0:
        info["cause"] = "stock_out"
    elif new.get("active") is False:
        info["cause"] = "inactive"
    elif info["gap_abs"] is not None and info["gap_abs"] > 0:
        info["cause"] = "price_above"
    return info


def insert_event(session: Session, variant: Variant, prev_snapshot_id: int, etype: str, old: Any, new: Any,
                 details: dict[str, Any], now: datetime) -> RadarEvent | None:
    """Insert once per transition (dedupe key = variant + type + previous snapshot)."""
    key = f"{variant.id}:{etype}:{prev_snapshot_id}"
    if session.scalar(select(RadarEvent.id).where(RadarEvent.dedupe_key == key)) is not None:
        return None
    ev = RadarEvent(variant_id=variant.id, type=etype, old_value=None if old is None else str(old),
                    new_value=None if new is None else str(new), details=details,
                    created_at=now, dedupe_key=key)
    session.add(ev)
    session.flush()
    return ev


@dataclass
class RadarState:
    page_map: dict[int, int] = field(default_factory=dict)  # variant row id -> list page last seen on
    total_pages: int | None = None
    last_full_read_at: datetime | None = None
    pending_full: set[int] = field(default_factory=set)
    full_in_progress: bool = False


@dataclass
class CycleResult:
    now: datetime
    tier_counts: dict[str, int]
    due_counts: dict[str, int]
    pages_read: list[int]
    events: list[RadarEvent]
    notify: list[tuple[int, str]] = field(default_factory=list)
    estimates: dict[str, tuple[float, float]] = field(default_factory=dict)


class Radar:
    def __init__(self, client: DigikalaClient, factory: sessionmaker[Session], settings: Settings, dispatcher=None,
                 floor_engine=None):
        self.client, self.factory, self.s, self.dispatcher = client, factory, settings, dispatcher
        self.floor_engine = floor_engine  # optional; suggestions only
        self.state = RadarState()
        self._wp_cache: dict[str, tuple[datetime, int | None]] = {}

    async def _suggested_price(self, product_variant_id: str | None, now: datetime) -> int | None:
        """get_winning_price, cached (default 10 min) and rate limited. None = unknown."""
        if not product_variant_id:
            return None
        hit = self._wp_cache.get(product_variant_id)
        if hit and (now - hit[0]).total_seconds() < self.s.winning_price_cache_seconds:
            return hit[1]
        try:
            price = await self.client.get_winning_price(product_variant_id)
        except Exception as e:  # never fail the cycle because of this extra lookup
            log.warning("winning-price lookup failed: %s", type(e).__name__)
            return None
        self._wp_cache[product_variant_id] = (now, price)
        return price

    async def _assess_floor(self, session: Session, row: Variant, suggested: int | None, data: dict, now: datetime):
        """Label the loss against our profit floor. Never fails the cycle; never changes prices."""
        if self.floor_engine is None:
            return None
        try:
            return await self.floor_engine.assess_loss(session, row, suggested, data["buy_box_price"], now)
        except Exception as e:
            log.warning("floor assessment failed: %s", type(e).__name__)
            return None

    def _needs_full(self, now: datetime) -> bool:
        last = self.state.last_full_read_at
        return (not self.state.page_map or last is None
                or (now - last).total_seconds() >= self.s.radar_calm_interval_seconds)

    async def _process_item(self, session: Session, raw: dict, page: int, now: datetime) -> list[RadarEvent]:
        data = parse_variant(raw, self.s.field_map)
        if data is None:
            return []
        existing = session.scalar(select(Variant).where(Variant.digikala_variant_id == data["digikala_variant_id"]))
        prev = None
        if existing is not None:
            prev = session.scalar(select(VariantSnapshot).where(VariantSnapshot.variant_id == existing.id)
                                  .order_by(VariantSnapshot.taken_at.desc(), VariantSnapshot.id.desc()).limit(1))
        detected = detect_events(prev, data) if prev is not None else []
        row = upsert_variant(session, data)
        add_snapshot(session, row, now)
        self.state.page_map[row.id] = page
        events = []
        for etype, old, new in detected:
            details: dict[str, Any] = {
                "title": data["title"], "our_price": data["price_sale"], "buy_box_price": data["buy_box_price"],
                "price_unit": self.s.price_unit, "suggested_price_unit": self.s.suggested_price_unit,
            }
            if etype == BUYBOX_LOST:
                details.update(determine_cause(data))
                details["suggested_price"] = await self._suggested_price(data["product_variant_id"], now)
                if self.floor_engine is not None:
                    details["floor"] = await self._assess_floor(session, row, details["suggested_price"], data, now)
            ev = insert_event(session, row, prev.id, etype, old, new, details, now)
            if ev is not None:
                events.append(ev)
        return events

    async def run_cycle(self, now: datetime | None = None) -> CycleResult:
        now = now or utcnow()
        s, st = self.s, self.state
        with self.factory() as session:
            tiers = classify_tiers(session, now, s)
            due = due_variants(tiers, last_snapshot_times(session), now, s)
            tier_counts = {t: sum(1 for x in tiers.values() if x == t) for t in TIERS}
            if self._needs_full(now) and not st.full_in_progress:
                st.full_in_progress = True
                st.pending_full = set(range(1, st.total_pages + 1)) if st.total_pages else {1}
            budget = max_pages_per_tick(s)
            events: list[RadarEvent] = []
            read: list[int] = []
            while len(read) < budget:
                # re-plan after every batch: the first page of a full read reveals total_pages
                pages = [p for p in plan_pages(due, st.page_map, st.pending_full, budget) if p not in read]
                pages = pages[: budget - len(read)]
                if not pages:
                    break
                for p in pages:
                    items, total = await self.client.get_variants_page(p)
                    read.append(p)
                    if total is not None:
                        first_time = st.total_pages is None
                        st.total_pages = total
                        if st.full_in_progress and first_time:
                            st.pending_full |= set(range(1, total + 1)) - set(read)
                    elif len(items) >= s.page_size and st.full_in_progress:
                        st.pending_full.add(p + 1)  # no pager: keep going until a short page
                    for raw in items:
                        events += await self._process_item(session, raw, p, now)
                    st.pending_full.discard(p)
                    session.commit()
            if st.full_in_progress and not st.pending_full:
                st.full_in_progress = False
                st.last_full_read_at = now
            result = CycleResult(now, tier_counts, {t: len(v) for t, v in due.items()}, read, events,
                                 estimates=estimate_requests_per_minute(tier_counts, s))
            if self.dispatcher is not None and events:
                result.notify = await self.dispatcher.dispatch(session, events, now)
            session.commit()
            for ev in events:
                session.refresh(ev)
            session.expunge_all()
            return result
