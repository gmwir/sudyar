"""Tier classification (client-side, from our own data) and request estimates.

HOT : manual override, OR in Buy Box challenge, OR lost the Buy Box within the last hour.
WARM: active and not winning the Buy Box, OR any radar event within the last 24 h.
      (ASSUMPTION: the brief did not define WARM; this is our definition.)
CALM: everything else.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import Settings
from .models import HotOverride, RadarEvent, Variant, VariantSnapshot

HOT, WARM, CALM = "HOT", "WARM", "CALM"
TIERS = (HOT, WARM, CALM)
DUE_SLACK = 0.9  # a variant is due at 90% of its interval, so loop jitter never skips a turn


def aware(dt: datetime | None) -> datetime | None:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)  # SQLite returns naive UTC
    return dt


def interval_for(tier: str, s: Settings) -> float:
    return {HOT: s.radar_hot_interval_seconds, WARM: s.radar_warm_interval_seconds,
            CALM: s.radar_calm_interval_seconds}[tier]


def classify_tiers(session: Session, now: datetime, s: Settings) -> dict[int, str]:
    """variant row id -> tier. Variant rows mirror the latest snapshot (written together)."""
    overrides = set(session.scalars(select(HotOverride.variant_id)))
    lost_since = now - timedelta(seconds=s.radar_hot_lost_window_seconds)
    recent_lost = set(session.scalars(
        select(RadarEvent.variant_id).where(RadarEvent.type == "BUYBOX_LOST", RadarEvent.created_at >= lost_since)))
    warm_since = now - timedelta(seconds=s.radar_warm_event_window_seconds)
    recent_any = set(session.scalars(select(RadarEvent.variant_id).where(RadarEvent.created_at >= warm_since)))
    out: dict[int, str] = {}
    for v in session.scalars(select(Variant)):
        if v.id in overrides or v.is_in_buy_box_challenge is True or v.id in recent_lost:
            out[v.id] = HOT
        elif v.active and (v.is_seller_buy_box_winner is False or v.id in recent_any):
            out[v.id] = WARM
        else:
            out[v.id] = CALM
    return out


def last_snapshot_times(session: Session) -> dict[int, datetime]:
    rows = session.execute(
        select(VariantSnapshot.variant_id, func.max(VariantSnapshot.taken_at)).group_by(VariantSnapshot.variant_id))
    return {vid: aware(t) for vid, t in rows}


def due_variants(tiers: dict[int, str], last_seen: dict[int, datetime], now: datetime, s: Settings) -> dict[str, list[int]]:
    due: dict[str, list[int]] = {t: [] for t in TIERS}
    for vid, tier in tiers.items():
        last = last_seen.get(vid)
        if last is None or (now - last).total_seconds() >= interval_for(tier, s) * DUE_SLACK:
            due[tier].append(vid)
    return due


def plan_pages(due: dict[str, list[int]], page_map: dict[int, int], pending_full: set[int], max_pages: int) -> list[int]:
    """Which list pages to read this tick: HOT pages first, then WARM, CALM, then a pending full read."""
    ordered: list[int] = []
    seen: set[int] = set()
    for tier in TIERS:
        for vid in due.get(tier, []):
            p = page_map.get(vid)
            if p is not None and p not in seen:
                ordered.append(p)
                seen.add(p)
    for p in sorted(pending_full):
        if p not in seen:
            ordered.append(p)
            seen.add(p)
    return ordered[:max_pages]


def max_pages_per_tick(s: Settings) -> int:
    """Read budget: budget_fraction of the read limit (default 60% of 30 req / 30 s)."""
    per_min = s.rate_limit_requests * s.radar_budget_fraction * 60 / s.rate_limit_period_seconds
    return max(1, int(per_min * s.radar_hot_interval_seconds / 60))


def budget_requests_per_minute(s: Settings) -> float:
    return s.rate_limit_requests * s.radar_budget_fraction * 60 / s.rate_limit_period_seconds


def estimate_requests_per_minute(counts: dict[str, int], s: Settings) -> dict[str, tuple[float, float]]:
    """(best case, worst case) requests/minute per tier.

    A page read serves every variant on it. Best case: the tier's variants sit together
    (ceil(n/size) pages). Worst case: each sits on its own page (min(n, total_pages)).
    """
    total = sum(counts.values())
    total_pages = max(1, math.ceil(total / s.page_size))
    out = {}
    for tier in TIERS:
        n = counts.get(tier, 0)
        best = math.ceil(n / s.page_size) if n else 0
        worst = min(n, total_pages)
        per_min = 60 / interval_for(tier, s)
        out[tier] = (best * per_min, worst * per_min)
    return out
