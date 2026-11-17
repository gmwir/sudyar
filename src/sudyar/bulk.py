"""Bulk update from Excel/CSV (Part 6): price, stock, lead time and max-per-order for many variants at once.

Columns: variant_id (Digikala variant id) and any of: price_toman, seller_stock, lead_time, maximum_per_order.
Every price is checked against the profit floor: a row below the floor, or with no floor, is rejected.
Sent with the Batch API (100 rows per batch) through DigikalaWriter (WRITE_MODE rules apply).
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .floor import OK, FloorEngine
from .models import Variant, utcnow
from .writer import DigikalaWriter

COLUMNS = {"price_toman": "selling_price", "seller_stock": "seller_stock", "lead_time": "lead_time",
           "maximum_per_order": "maximum_per_order"}
MAX_ROWS = 5000
CHUNK = 100


@dataclass
class BulkPlan:
    items: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _num(v: Any) -> int | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    s = str(v).strip().replace(",", "").replace("٬", "")
    s = s.translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))
    try:
        f = float(s)
    except ValueError:
        raise ValueError("not a number") from None
    if f != int(f) or f < 0:
        raise ValueError("must be a whole number >= 0")
    return int(f)


def read_rows(data: bytes, filename: str) -> list[list[Any]]:
    if filename.lower().endswith(".xlsx"):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        return [list(r) for r in wb.active.iter_rows(values_only=True)]
    return list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))


async def plan_bulk(session: Session, floor: FloorEngine, rows: list[list[Any]], now: datetime | None = None
                    ) -> BulkPlan:
    now = now or utcnow()
    plan = BulkPlan()
    if not rows:
        plan.errors.append("file is empty")
        return plan
    if len(rows) - 1 > MAX_ROWS:
        plan.errors.append(f"more than {MAX_ROWS} rows")
        return plan
    head = [str(h or "").strip().lower() for h in rows[0]]
    if "variant_id" not in head or not any(c in head for c in COLUMNS):
        plan.errors.append("columns: variant_id and at least one of " + ", ".join(COLUMNS))
        return plan
    idx = {c: head.index(c) for c in ["variant_id", *COLUMNS] if c in head}
    seen = set()
    for n, r in enumerate(rows[1:], start=2):
        cell = lambda c: r[idx[c]] if idx[c] < len(r) else None  # noqa: E731
        try:
            vid = _num(cell("variant_id"))
        except ValueError:
            vid = None
        if not vid:
            plan.errors.append(f"row {n}: bad variant_id")
            continue
        if vid in seen:
            plan.errors.append(f"row {n}: variant {vid} repeated")
            continue
        seen.add(vid)
        v = session.scalar(select(Variant).where(Variant.digikala_variant_id == str(vid)))
        if v is None:
            plan.errors.append(f"row {n}: variant {vid} not in Sudyar (run sync-variants)")
            continue
        payload: dict[str, Any] = {}
        try:
            for col, api in COLUMNS.items():
                if col in idx:
                    x = _num(cell(col))
                    if x is not None:
                        payload[api] = x * 10 if col == "price_toman" else x
        except ValueError as e:
            plan.errors.append(f"row {n}: {e}")
            continue
        if not payload:
            continue
        if "selling_price" in payload:
            fr = await floor.evaluate(session, v, now)
            if fr.status != OK or not fr.floor_toman:
                plan.errors.append(f"row {n}: no profit floor for {vid}; price not changed")
                continue
            if payload["selling_price"] < fr.floor_toman * 10:
                plan.errors.append(f"row {n}: price below profit floor ({fr.floor_toman:,} Toman)")
                continue
        plan.items.append({"variant_id": vid, "payload": payload})
    return plan


async def apply_bulk(writer: DigikalaWriter, plan: BulkPlan) -> list[dict]:
    out = []
    for i in range(0, len(plan.items), CHUNK):
        part = plan.items[i:i + CHUNK]
        out.append(await writer.write("batch_variant_update", {"deadline": 600, "items": part},
                                      target=f"{len(part)} variants", source="bulk"))
    return out
