"""Real daily sales from the Order API: GET /open-api/v1/orders/history (scope: order). READ-ONLY.

What is stored (table daily_sales): Tehran day, product_variant_id, net unit sale price, net quantity. NOTHING else:
no customer name/phone/address, no order or shipment ids (those are only used in memory to drop duplicate lines).

Rules: canceled orders are never requested (and a processed line carrying cancellation_info is dropped);
returned lines are NEGATIVE and counted on the day the order was created; a day is stored only if ALL its pages were
read (never partial); the day's rows are replaced in one transaction, so re-syncing is idempotent.

UNVERIFIED ASSUMPTIONS (no real response was available): unit_price is Rial and BEFORE unit_discount
(net = unit_price - unit_discount, switch ORDERS_DISCOUNT_MODE); the "Z" timestamps are real UTC;
seller_voucher_amount is NOT deducted; envelope data.items / data.pager like the other list endpoints.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .config import Settings
from .fees import aware
from .models import DailySales, FeeCache

log = logging.getLogger(__name__)

TEHRAN = ZoneInfo("Asia/Tehran")
FETCH_TYPES = ("processed", "returned")  # canceled is never fetched
ASSUMPTIONS_FA = ("فرض‌های تأییدنشده: واحد قیمت ریال است؛ قیمت واحد = قیمت منهای تخفیف؛ "
                  "تخفیف فروشنده (voucher) کم نشده؛ مرجوعی‌ها روز ثبت سفارش اصلی کم می‌شوند.")


class OrdersSyncError(RuntimeError):
    """A day could not be read completely; nothing is stored for it (old rows are kept)."""


@dataclass
class DaySync:
    day: date
    cached: bool = False
    lines: int = 0  # (variant, price) rows stored
    items: int = 0  # order lines read
    pages: int = 0
    canceled_dropped: int = 0
    duplicates_dropped: int = 0
    rejected: int = 0  # lines with missing/invalid fields: the day is then INCOMPLETE
    suspect_duplicates: int = 0  # identical lines without an item id: kept (never dropped silently), only warned


@dataclass
class OrdersSyncResult:
    days: list[DaySync] = field(default_factory=list)


def tehran_day_bounds(day: date) -> tuple[datetime, datetime]:
    """[start, end) of a Tehran calendar day, as UTC datetimes (for order_created_at_from / _to)."""
    start = datetime(day.year, day.month, day.day, tzinfo=TEHRAN)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def tehran_date(dt: datetime) -> date:
    return aware(dt).astimezone(TEHRAN).date()


def yesterday_tehran(now: datetime) -> date:
    return tehran_date(now) - timedelta(days=1)


def last_days(now: datetime, n: int) -> list[date]:
    """The n most recent COMPLETE Tehran days (yesterday first). Today is never synced: it is not finished."""
    y = yesterday_tehran(now)
    return [y - timedelta(days=i) for i in range(n)]


def _int(v: Any) -> int | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return int(f) if f == f and abs(f) < 10**15 and f == int(f) else None


def _created(v: Any) -> datetime | None:
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def parse_order_line(raw: dict[str, Any], order_type: str, s: Settings) -> tuple[date, str, int, int] | str | None:
    """-> (tehran day, product_variant_id, signed quantity, net unit price) | None if dropped on purpose | reason str.

    Only the fields we need are read; everything else in the item (customer data included) is ignored.
    """
    if order_type == "processed" and raw.get("cancellation_info"):
        return None  # canceled: excluded
    st = raw.get("order_status")
    status = (st.get("key") if isinstance(st, dict) else st) or ""
    status = str(status).strip().lower()
    # Verified on the seller panel (15 Nov 2026): order_status is {"key": "processed"|"returned"|"canceled", "title"}.
    if status in ("canceled", "cancelled"):
        return None  # canceled: excluded
    if order_type == "processed" and status == "returned":
        return None  # counted once, from the "returned" request (no double counting)
    pvid = raw.get("product_variant_id")
    qty = _int(raw.get("quantity"))
    price = _int(raw.get("unit_price"))
    created = _created(raw.get("order_created_at"))
    if pvid in (None, "") or isinstance(pvid, (bool, dict, list)):
        return "product_variant_id missing"
    if qty is None or qty <= 0:
        return "quantity invalid"
    if price is None or price < 0:
        return "unit_price invalid"
    if created is None:
        return "order_created_at invalid"
    if s.orders_discount_mode == "subtract":
        disc = _int(raw.get("unit_discount") or 0)
        if disc is None or disc < 0:
            return "unit_discount invalid"
        price = max(0, price - disc)
    return tehran_date(created), str(pvid), (-qty if order_type == "returned" else qty), price


ITEM_ID_KEYS = ("order_item_id", "item_id", "order_line_id")  # per-item id, if the API gives one (UNVERIFIED names)


def _item_id(raw: dict[str, Any]) -> str | None:
    for k in ITEM_ID_KEYS:
        if raw.get(k) not in (None, ""):
            return str(raw[k])
    return None


def _content_key(raw: dict[str, Any], order_type: str) -> str | None:
    """In-memory only (never stored). Same order/shipment/variant/qty/price/total = a POSSIBLE duplicate."""
    if raw.get("order_id") in (None, "") or raw.get("shipment_id") in (None, ""):
        return None
    base = "|".join(str(raw.get(k)) for k in ("order_id", "shipment_id", "product_variant_id", "quantity",
                                                "unit_price", "total_price"))
    return hashlib.sha256(f"{order_type}|{base}".encode()).hexdigest()


def _marker(day: date) -> str:
    return f"orders:{day.isoformat()}"


def orders_synced_at(session: Session, day: date) -> datetime | None:
    m = session.get(FeeCache, _marker(day))
    return aware(m.fetched_at) if m else None


def orders_quality(session: Session, day: date) -> dict[str, int]:
    """{'rejected': n, 'suspect_duplicates': n} saved with the day (0 if none / older marker)."""
    m = session.get(FeeCache, _marker(day))
    d = m.data if m is not None and isinstance(m.data, dict) else {}
    return {"rejected": int(d.get("rejected") or 0), "suspect_duplicates": int(d.get("suspect_duplicates") or 0)}


async def _read_day(client, s: Settings, day: date, stats: DaySync) -> dict[tuple[str, int], int]:
    start, end = tehran_day_bounds(day)
    agg: dict[tuple[str, int], int] = {}
    seen_ids: set[str] = set()
    seen_content: set[str] = set()
    for order_type in FETCH_TYPES:
        page = 0
        while True:
            page += 1
            if page > s.orders_max_pages:
                raise OrdersSyncError(f"{day}: more than ORDERS_MAX_PAGES={s.orders_max_pages} pages; day not stored")
            items, total = await client.get_orders_page(order_type, start, end, page)
            stats.pages += 1
            for raw in items:
                stats.items += 1
                item_id = _item_id(raw)
                if item_id is not None:  # exact: the same item id twice is the same line (pages shifted)
                    k = f"{order_type}|{item_id}"
                    if k in seen_ids:
                        stats.duplicates_dropped += 1
                        continue
                    seen_ids.add(k)
                else:  # no item id: identical-looking lines may be two real items. Keep both, warn.
                    ck = _content_key(raw, order_type)
                    if ck is not None:
                        if ck in seen_content:
                            stats.suspect_duplicates += 1
                        seen_content.add(ck)
                parsed = parse_order_line(raw, order_type, s)
                if parsed is None:
                    stats.canceled_dropped += 1
                    continue
                if isinstance(parsed, str):
                    stats.rejected += 1
                    continue
                d, pvid, qty, price = parsed
                if d != day:
                    stats.rejected += 1  # outside the requested day: the API ignored the date window; never mix days
                    continue
                agg[(pvid, price)] = agg.get((pvid, price), 0) + qty
            if not items or (total is not None and page >= total) or (total is None and len(items) < s.page_size):
                break
    return agg


async def sync_orders(client, session: Session, s: Settings, days: list[date], now: datetime,
                      force: bool = False) -> OrdersSyncResult:
    """Read each day completely (GET, rate limited, bounded pages), then replace that day's rows in one go."""
    result = OrdersSyncResult()
    for day in days:
        stats = DaySync(day)
        last = orders_synced_at(session, day)
        if not force and last is not None and (now - last).total_seconds() < s.orders_cache_seconds:
            stats.cached = True
            result.days.append(stats)
            continue
        agg = await _read_day(client, s, day, stats)  # raises before anything is touched
        session.execute(delete(DailySales).where(DailySales.day == day))
        for (pvid, price), qty in sorted(agg.items()):
            if qty != 0:
                session.add(DailySales(day=day, product_variant_id=pvid, unit_sale_price=price, quantity=qty, synced_at=now))
                stats.lines += 1
        data = {"lines": stats.lines, "items": stats.items, "pages": stats.pages, "rejected": stats.rejected,
                "suspect_duplicates": stats.suspect_duplicates}
        m = session.get(FeeCache, _marker(day))
        if m is None:
            session.add(FeeCache(key=_marker(day), data=data, fetched_at=now))
        else:
            m.data, m.fetched_at = data, now
        session.commit()
        if stats.rejected:
            log.warning("orders %s: %d lines rejected (missing/invalid fields): day is INCOMPLETE", day, stats.rejected)
        if stats.suspect_duplicates:
            log.warning("orders %s: %d possible duplicate lines kept (no item id)", day, stats.suspect_duplicates)
        result.days.append(stats)
    return result


def daily_rows(session: Session, day: date) -> list[DailySales]:
    return list(session.scalars(select(DailySales).where(DailySales.day == day)
                                .order_by(DailySales.product_variant_id, DailySales.unit_sale_price)))
