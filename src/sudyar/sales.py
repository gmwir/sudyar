"""Sales: GET /open-api/v1/insight/sales-reports (scope: insight). Read-only, cached, bounded.

Required param `range` = last_7_days | last_14_days | last_30_days; optional category_id.
Items are per product_id: net_item_sold, net_sales_amount, order_count, visit_count, conversion_rate.
Sales are per PRODUCT, so all variants of a product share the same numbers.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .digikala_client import SALES_RANGES
from .fees import aware
from .models import FeeCache, ProductSales


@dataclass
class SalesSyncResult:
    range: str
    rows: int = 0
    pages: int = 0
    cached: bool = False
    truncated: bool = False
    rejected: list[str] = field(default_factory=list)


def _int(v: Any) -> int | None:
    try:
        return None if v is None or isinstance(v, bool) else int(float(v))
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    try:
        return None if v is None or isinstance(v, bool) else float(v)
    except (TypeError, ValueError):
        return None


def parse_sales_row(raw: dict[str, Any]) -> dict[str, Any] | None:
    if raw.get("product_id") in (None, ""):
        return None
    return {"product_id": str(raw["product_id"]), "net_item_sold": _int(raw.get("net_item_sold")),
            "net_sales_amount": _int(raw.get("net_sales_amount")), "order_count": _int(raw.get("order_count")),
            "visit_count": _int(raw.get("visit_count")), "conversion_rate": _float(raw.get("conversion_rate"))}


def _marker_key(range_: str) -> str:
    return f"sales:{range_}"


def sales_synced_at(session: Session, range_: str) -> datetime | None:
    m = session.get(FeeCache, _marker_key(range_))
    return aware(m.fetched_at) if m else None


async def sync_sales(client, session: Session, s: Settings, range_: str, now: datetime,
                     category_id: str | None = None, force: bool = False) -> SalesSyncResult:
    if range_ not in SALES_RANGES:
        raise ValueError(f"range must be one of {', '.join(SALES_RANGES)}")
    res = SalesSyncResult(range_)
    last = sales_synced_at(session, range_)
    if not force and category_id is None and last is not None and (now - last).total_seconds() < s.sales_cache_seconds:
        res.cached = True
        return res
    items, total = await client.get_sales_report_page(range_, None, category_id)
    res.pages = 1
    pages_items = [items]
    if total and total > 1:
        last_page = min(total, s.sales_max_pages)
        res.truncated = total > s.sales_max_pages
        for page in range(2, last_page + 1):
            more, _ = await client.get_sales_report_page(range_, page, category_id)
            pages_items.append(more)
            res.pages += 1
    for items in pages_items:
        for raw in items:
            row = parse_sales_row(raw)
            if row is None:
                res.rejected.append("item without product_id")
                continue
            existing = session.get(ProductSales, (row["product_id"], range_))
            if existing is None:
                session.add(ProductSales(range=range_, fetched_at=now, **row))
            else:
                for k, v in row.items():
                    setattr(existing, k, v)
                existing.fetched_at = now
            res.rows += 1
    if category_id is None and not res.truncated:  # only a complete read counts as "cached"
        m = session.get(FeeCache, _marker_key(range_))
        data = {"rows": res.rows, "pages": res.pages}
        if m is None:
            session.add(FeeCache(key=_marker_key(range_), data=data, fetched_at=now))
        else:
            m.data, m.fetched_at = data, now
    session.commit()
    return res


def load_sales(session: Session, range_: str) -> dict[str, ProductSales]:
    return {r.product_id: r for r in session.scalars(select(ProductSales).where(ProductSales.range == range_))}
