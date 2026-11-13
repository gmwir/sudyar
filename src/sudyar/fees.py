"""Digikala commissions: GET /open-api/v1/commissions/ (scope: commission), stored locally.

`commission`, `extra_commission`, `return_free_commission` are FRACTIONS (0.03 = 3%).
Read-only (GET), paged via data.pager, through the shared rate limiter, refreshed at most every 24 h.
The meaning of extra_commission / return_free_commission is UNCONFIRMED, so by default the floor
uses `commission` only (FLOOR_INCLUDE_EXTRA_COMMISSION / FLOOR_INCLUDE_RETURN_FREE_COMMISSION).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .config import Settings
from .models import Commission, FeeCache

log = logging.getLogger(__name__)

MARKER_KEY = "commissions"
FEE_CATEGORY_ROW = "fee_category_row"
FEE_BRAND_ROW = "fee_brand_row"
FEE_ASSUMED_MAX_BRAND = "fee_assumed_max_brand"
FEE_ASSUMED_SINGLE_BRAND = "fee_assumed_single_brand"  # one brand-specific row: NOT the category rate
MAX_PARTIAL_CATEGORIES = 50_000  # safety limit only; beyond it EVERY category is marked incomplete
ALL_CATEGORIES = "*"  # marker: no floor for any category (fail-closed)
ORPHAN_MESSAGE_FA = "یک ردیف کمیسیون بدون دسته پیدا شد؛ تا اصلاح نشود هیچ کفی نمایش داده نمی‌شود"
LIMIT_MESSAGE_FA = "ردیف‌های نامعتبر کمیسیون بیش از حد مجاز است؛ تا اصلاح نشود هیچ کفی نمایش داده نمی‌شود"
RETRY_AFTER_FAILURE = timedelta(hours=1)


def aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


@dataclass(frozen=True)
class Fees:
    commission_pct: float  # effective % of the selling price used in the floor
    reason: str  # fee_category_row | fee_brand_row | fee_assumed_max_brand
    base_pct: float = 0.0
    extra_pct: float | None = None
    return_free_pct: float | None = None
    brand_title: str | None = None


@dataclass
class FeeSyncResult:
    rows: int = 0
    rejected: list[str] | None = None
    pages: int = 0
    partial_categories: int = 0  # categories with rejected rows: no floor is computed for them
    orphan_rows: int = 0  # rows with no usable category_id: NO floor is shown for ANY category


class FeeSyncRefused(RuntimeError):
    """The new data looks wrong (e.g. far fewer rows than last time); the old rows are kept."""


def _frac(v: Any) -> float | None:
    """A fraction in [0, 1) or None. Anything else is invalid (never reinterpreted)."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0 <= f < 1 else None


def usable_category_id(v: Any) -> bool:
    """A category_id we can match variants against: a non-empty string or a number (not bool/list/dict)."""
    if v is None or isinstance(v, (bool, dict, list, tuple, set)):
        return False
    return bool(str(v).strip())


def parse_commission_row(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """-> (row dict or None, reason if rejected). Swagger fields: main_category_id, category_id,
    brand_id, brand_title, commission, extra_commission, return_free_commission, currentLeadTime."""
    if not usable_category_id(raw.get("category_id")):
        return None, "category_id missing"
    commission = _frac(raw.get("commission"))
    if commission is None:
        return None, f"commission '{raw.get('commission')}' is not a fraction in [0,1)"
    out: dict[str, Any] = {"commission": commission}
    for name in ("extra_commission", "return_free_commission"):
        if raw.get(name) is None:
            out[name] = None
        else:
            f = _frac(raw.get(name))
            if f is None:
                return None, f"{name} '{raw.get(name)}' is not a fraction in [0,1)"
            out[name] = f
    brand = raw.get("brand_id")
    lead = raw.get("currentLeadTime")
    out.update(
        main_category_id=None if raw.get("main_category_id") is None else str(raw["main_category_id"]),
        category_id=str(raw["category_id"]),
        brand_id=None if brand in (None, "", 0) else str(brand),
        brand_title=raw.get("brand_title"),
        current_lead_time=lead if isinstance(lead, int) and not isinstance(lead, bool) else None,
    )
    return out, ""


async def sync_commissions(client, session: Session, s: Settings, now: datetime, force: bool = False) -> FeeSyncResult:
    """Read ALL pages first, then replace the stored rows in one go (never a half-updated table).

    Refused (old rows kept) if nothing usable came back, or if the row count fell by more than
    FEES_MAX_DROP_PCT versus the last good sync (unless force=True).
    """
    rows: list[dict[str, Any]] = []
    rejected: list[str] = []
    partial: set[str] = set()
    orphans = 0
    page = 0
    while True:
        page += 1
        if page > s.fees_max_pages:
            raise RuntimeError(f"commissions need more than FEES_MAX_PAGES={s.fees_max_pages} pages")
        items, total = await client.get_commissions_page(page)
        for i, raw in enumerate(items):
            row, why = parse_commission_row(raw)
            if row is None:
                rejected.append(f"page {page} item {i + 1}: {why}")
                if usable_category_id(raw.get("category_id")):
                    partial.add(str(raw["category_id"]).strip())
                else:
                    orphans += 1  # we cannot tell which category it belongs to: nothing can be trusted
            else:
                rows.append(row)
        if (total is not None and page >= total) or (total is None and len(items) < s.page_size) or not items:
            break
    if not rows:
        raise FeeSyncRefused("Digikala returned no usable commission rows; keeping the old data.")
    marker = session.get(FeeCache, MARKER_KEY)
    previous = marker.data.get("rows") if marker is not None and isinstance(marker.data, dict) else None
    if (not force and isinstance(previous, int) and previous > 0
            and len(rows) < previous * (1 - s.fees_max_drop_pct / 100)):
        raise FeeSyncRefused(f"row count fell from {previous} to {len(rows)} (more than {s.fees_max_drop_pct:g}%); "
                             "keeping the old rows (use --force to accept)")
    if rejected:
        log.warning("commission sync: %d rows rejected, %d categories incomplete (no floor for them)",
                    len(rejected), len(partial))
    if orphans:
        log.warning("commission sync: %d rows have no usable category_id: NO floors are shown until fixed", orphans)
    session.execute(delete(Commission))
    session.add_all(Commission(fetched_at=now, **r) for r in rows)
    # Same fail-closed path for both cases: too many invalid categories, or ANY orphan row.
    fail_closed = orphans > 0 or len(partial) > MAX_PARTIAL_CATEGORIES
    data = {"rows": len(rows), "rejected": len(rejected), "pages": page, "orphan_rows": orphans,
            "partial_categories": [ALL_CATEGORIES] if fail_closed else sorted(partial)}
    if marker is None:
        session.add(FeeCache(key=MARKER_KEY, data=data, fetched_at=now))
    else:
        marker.data, marker.fetched_at = data, now
    session.commit()
    return FeeSyncResult(len(rows), rejected, page, len(partial), orphans)


def effective_fraction(row: Commission, s: Settings) -> float:
    f = row.commission or 0.0
    if s.floor_include_extra_commission:
        f += row.extra_commission or 0.0
    if s.floor_include_return_free_commission:
        f += row.return_free_commission or 0.0
    return f


class FeeProvider:
    def __init__(self, client, settings: Settings):
        self.client, self.s = client, settings
        self._last_failed: datetime | None = None
        self._by_category: dict[str, list[tuple]] | None = None
        self._partial_cache: set[str] | None = None

    # -- freshness --
    def synced_at(self, session: Session) -> datetime | None:
        m = session.get(FeeCache, MARKER_KEY)
        return aware(m.fetched_at) if m else None

    def is_fresh(self, session: Session, now: datetime) -> bool:
        at = self.synced_at(session)
        return at is not None and (now - at).total_seconds() < self.s.fees_cache_seconds

    def has_rows(self, session: Session) -> bool:
        return session.scalar(select(Commission.id).limit(1)) is not None

    def is_stale(self, session: Session, now: datetime) -> bool:
        """Commission rows must not be trusted: the last good sync is older than FEES_MAX_STALE_DAYS
        (refreshes keep failing), OR rows exist but there is no sync record at all (unknown age = never fresh)."""
        at = self.synced_at(session)
        if at is None:
            return self.has_rows(session)
        return (now - at).total_seconds() > self.s.fees_max_stale_days * 86_400

    def data_usable(self, session: Session, now: datetime) -> bool:
        """Commission data exists AND is fresh enough to rely on (needs a sync record; never-synced is not usable)."""
        return self.synced_at(session) is not None and not self.is_stale(session, now)

    @staticmethod
    def _is_partial(category_id: str, partial: set[str]) -> bool:
        return ALL_CATEGORIES in partial or category_id in partial

    def partial_categories(self, session: Session) -> set[str]:
        m = session.get(FeeCache, MARKER_KEY)
        data = m.data if m is not None and isinstance(m.data, dict) else {}
        return {str(c) for c in data.get("partial_categories", [])}

    def _marker_data(self, session: Session) -> dict:
        m = session.get(FeeCache, MARKER_KEY)
        return m.data if m is not None and isinstance(m.data, dict) else {}

    def all_incomplete(self, session: Session) -> bool:
        """True if the commission data cannot be trusted for ANY category (orphan row / safety limit)."""
        partial = self._partial_cache if self._partial_cache is not None else self.partial_categories(session)
        return ALL_CATEGORIES in partial

    def orphan_rows(self, session: Session) -> int:
        n = self._marker_data(session).get("orphan_rows", 0)
        return n if isinstance(n, int) and not isinstance(n, bool) else 0

    def incomplete_message_fa(self, session: Session) -> str | None:
        """Persian explanation when everything is fail-closed (None if the data is usable)."""
        if not self.all_incomplete(session):
            return None
        return ORPHAN_MESSAGE_FA if self.orphan_rows(session) > 0 else LIMIT_MESSAGE_FA

    def miss_reason(self, session: Session, category_id: str | None, now: datetime) -> str:
        """Why get() returned None (shown to the user)."""
        if self.all_incomplete(session):
            if self.orphan_rows(session) > 0:
                return ("a commission row has no category: commission data is incomplete for ALL categories, "
                        "no floor is shown until it is fixed (then run sync-fees)")
            return "too many invalid commission rows: no floor is shown until they are fixed (then run sync-fees)"
        if self.synced_at(session) is None:
            return "commission data was never synced, or has no sync record - run sync-fees"
        if self.is_stale(session, now):
            return f"commissions older than {self.s.fees_max_stale_days:g} days (refresh failing?) - run sync-fees"
        if not category_id:
            return "variant has no category_id"
        if self._is_partial(str(category_id), self.partial_categories(session)):
            return "some commission rows of this category were invalid, so the highest rate is unknown - fix and run sync-fees"
        return "no commission row for this variant's category (run sync-fees)"

    async def ensure_fresh(self, session: Session, now: datetime) -> None:
        """Re-read commissions if older than 24 h (GET, rate limited). Failures never break callers."""
        if self.client is None or self.is_fresh(session, now):
            return
        if self._last_failed and now - self._last_failed < RETRY_AFTER_FAILURE:
            return
        try:
            await sync_commissions(self.client, session, self.s, now)
            self._by_category = None
        except Exception as e:  # message type only: never headers/tokens/URLs
            self._last_failed = now
            session.rollback()
            log.warning("commission sync failed: %s", type(e).__name__)

    # -- lookup --
    def preload(self, session: Session) -> None:
        """Load all rows once (used by reports with thousands of variants)."""
        by: dict[str, list[tuple]] = {}
        for r in session.scalars(select(Commission)):
            by.setdefault(r.category_id, []).append((r.brand_id, r.brand_title, effective_fraction(r, self.s),
                                                     r.commission or 0.0, r.extra_commission, r.return_free_commission))
        self._by_category = by
        self._partial_cache = self.partial_categories(session)

    def _rows(self, session: Session, category_id: str) -> list[tuple]:
        if self._by_category is not None:
            return self._by_category.get(category_id, [])
        return [(r.brand_id, r.brand_title, effective_fraction(r, self.s), r.commission or 0.0,
                 r.extra_commission, r.return_free_commission)
                for r in session.scalars(select(Commission).where(Commission.category_id == category_id))]

    def lookup(self, session: Session, category_id: str | None, brand_id: str | None) -> Fees | None:
        """Commission for a variant. Brand known (set manually) -> that brand's row. Several brand
        rows and no brand -> the HIGHEST commission (conservative), reason fee_assumed_max_brand."""
        if not category_id:
            return None
        partial = self._partial_cache if self._partial_cache is not None else self.partial_categories(session)
        if self._is_partial(str(category_id), partial):  # never take a max over an incomplete set of rows
            return None
        rows = self._rows(session, str(category_id))
        if not rows:
            return None
        if brand_id is not None:
            match = [r for r in rows if r[0] == str(brand_id)]
            if match:
                best = max(match, key=lambda r: r[2])
                return self._fees(best, FEE_BRAND_ROW)
        if len(rows) == 1:
            # A row without brand_id is the category rate; a brand row is only ONE brand's rate.
            return self._fees(rows[0], FEE_CATEGORY_ROW if rows[0][0] is None else FEE_ASSUMED_SINGLE_BRAND)
        return self._fees(max(rows, key=lambda r: r[2]), FEE_ASSUMED_MAX_BRAND)

    @staticmethod
    def _fees(row: tuple, reason: str) -> Fees:
        _, title, eff, base, extra, rf = row
        return Fees(commission_pct=round(eff * 100, 6), reason=reason, base_pct=round(base * 100, 6),
                    extra_pct=None if extra is None else round(extra * 100, 6),
                    return_free_pct=None if rf is None else round(rf * 100, 6), brand_title=title)

    async def get(self, session: Session, category_id: str | None, brand_id: str | None, now: datetime,
                  allow_fetch: bool = True) -> Fees | None:
        if allow_fetch:
            await self.ensure_fresh(session, now)
        if self.is_stale(session, now):
            return None
        return self.lookup(session, category_id, brand_id)


def list_brands(session: Session, category_id: str) -> list[tuple[str | None, str | None, float]]:
    """(brand_id, brand_title, commission %) rows of a category, to help choose a brand_id."""
    rows = session.scalars(select(Commission).where(Commission.category_id == str(category_id)))
    return sorted(((r.brand_id, r.brand_title, round((r.commission or 0) * 100, 4)) for r in rows),
                  key=lambda x: -x[2])
