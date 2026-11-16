"""Finance (Part 6, read-only): Digikala invoices and payouts -> "when does my money arrive?".

GET /open-api/v1/invoices and GET /open-api/v1/finance/payouts (scope invoice). Amounts are stored as returned
(Rial). Nothing is ever written to Digikala here.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Invoice, Payout, utcnow

INVOICES_PATH = "/open-api/v1/invoices"
PAYOUTS_PATH = "/open-api/v1/finance/payouts"


def _int(v: Any) -> int | None:
    try:
        return None if v is None or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


def _s(v: Any, n: int = 40) -> str | None:
    if v is None:
        return None
    if isinstance(v, dict):
        v = v.get("key") or v.get("title")
    return str(v)[:n]


async def sync_finance(client, session: Session, now: datetime | None = None) -> tuple[int, int]:
    now = now or utcnow()
    invoices = [it async for it in client.iter_list(INVOICES_PATH)]
    payouts = [it async for it in client.iter_list(PAYOUTS_PATH)]
    for it in invoices:
        i = _int(it.get("id"))
        if i is None:
            continue
        row = session.get(Invoice, i) or Invoice(id=i)
        row.start_date, row.end_date = _s(it.get("start_date")), _s(it.get("end_date"))
        row.cash_sale_date, row.credit_sale_date = _s(it.get("cash_sale_date")), _s(it.get("credit_sale_date"))
        row.total_amount = _int(it.get("invoice_total_amount"))
        row.payout_status = _s(it.get("payout_order_status"))
        row.settlement_status = _s(it.get("settlement_status"))
        row.fetched_at = now
        session.add(row)
    for it in payouts:
        i = _int(it.get("id"))
        if i is None:
            continue
        row = session.get(Payout, i) or Payout(id=i)
        row.amount = _int(it.get("amount"))
        row.status = _s(it.get("status"))
        row.tracking_code = _s(it.get("tracking_code"), 100)
        row.payout_date = _s(it.get("payout_date") or it.get("suggested_payout_at"))
        row.fetched_at = now
        session.add(row)
    session.commit()
    return len(invoices), len(payouts)


def money_summary(session: Session) -> dict[str, int]:
    """Totals (Rial): invoices not paid yet vs paid; payouts by status."""
    out = {"invoices_unpaid": 0, "invoices_paid": 0, "payouts_done": 0, "payouts_pending": 0}
    for inv in session.scalars(select(Invoice)):
        amt = inv.total_amount or 0
        out["invoices_paid" if inv.payout_status == "paid" else "invoices_unpaid"] += amt
    for p in session.scalars(select(Payout)):
        amt = p.amount or 0
        done = (p.status or "").lower() in ("paid", "done", "success", "completed")
        out["payouts_done" if done else "payouts_pending"] += amt
    return out
