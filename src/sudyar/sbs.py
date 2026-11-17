"""Ship-by-seller orders (Part 6): list, bulk status, tracking codes, printable labels.

Privacy: the shipment list is stored in the database WITHOUT customer data. A label fetches the customer's
name/address for that one shipment at print time (GET .../customer/{id}) and only renders it into the printable
page (the CLI writes data/labels.html for printing; delete it after printing). It is never put in the database.
Writes (status, tracking code) go through DigikalaWriter: WRITE_MODE rules apply; only processing/processed
statuses are allowed; cancelling is impossible from Sudyar.
"""
from __future__ import annotations

import csv
import html
import io
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import SbsShipment, utcnow
from .writer import SBS_STATUSES, DigikalaWriter

SBS_PATH = "/open-api/v1/ship-by-seller-orders"


def _int(v: Any) -> int | None:
    try:
        return None if v is None or isinstance(v, bool) else int(v)
    except (TypeError, ValueError):
        return None


def parse_shipment(it: dict[str, Any]) -> dict[str, Any] | None:
    sid = _int(it.get("shipmentId"))
    if sid is None:
        return None
    st = it.get("status") if isinstance(it.get("status"), dict) else {}
    items = []
    for v in it.get("variants") or []:
        if isinstance(v, dict):
            items.append({"title": str(v.get("title") or "")[:200],
                          "qty": _int(v.get("quantity") or v.get("count")) or 1})
    return dict(shipment_id=sid, order_id=_int(it.get("orderId")), status=str(st.get("text") or "")[:64] or None,
                status_fa=str(st.get("text_fa") or "")[:200] or None, next_status=it.get("nextStatus"),
                promise_date=str(it.get("promiseDate") or it.get("postPromiseDate") or "")[:40] or None,
                order_date=str(it.get("orderDate") or "")[:40] or None,
                shipping_provider=str(it.get("shippingProvider") or "")[:40] or None,
                tracking_code=str(it.get("trackingCode") or "")[:100] or None,
                tracking_code_status=str(it.get("trackingCodeStatus") or "")[:20] or None,
                item_count=_int(it.get("itemCount")), is_cancelled=bool(it.get("isCancelled")), items=items)


async def sync_sbs(client, session: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    parsed = [p async for p in _iter(client)]
    for p in parsed:
        row = session.get(SbsShipment, p["shipment_id"]) or SbsShipment(shipment_id=p["shipment_id"])
        for k, v in p.items():
            setattr(row, k, v)
        row.fetched_at = now
        session.add(row)
    session.commit()
    return len(parsed)


async def _iter(client):
    async for it in client.iter_list(SBS_PATH):
        p = parse_shipment(it)
        if p:
            yield p


def open_shipments(session: Session) -> list[SbsShipment]:
    return list(session.scalars(select(SbsShipment).where(SbsShipment.is_cancelled.is_not(True))
                                .order_by(SbsShipment.promise_date, SbsShipment.shipment_id)))


async def set_status(writer: DigikalaWriter, shipment_ids: list[int], new_status: str) -> dict:
    if new_status not in SBS_STATUSES:
        raise ValueError("status must be processing or processed")
    ids = sorted({int(i) for i in shipment_ids if int(i) > 0})
    if not ids:
        raise ValueError("no shipment ids")
    if len(ids) == 1:
        return await writer.write("sbs_update_status", {"order_shipment_id": ids[0], "new_status": new_status},
                                  target=str(ids[0]), source="sbs")
    return await writer.write("sbs_batch_update_status", {"order_shipment_ids": ids, "new_status": new_status},
                              target=f"{len(ids)} shipments", source="sbs")


def parse_tracking_file(data: bytes, filename: str) -> tuple[list[tuple[int, str]], list[str]]:
    """CSV/XLSX with columns shipment_id, tracking_code -> ([(id, code)], [errors])."""
    rows: list[list[Any]]
    if filename.lower().endswith(".xlsx"):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        rows = [list(r) for r in wb.active.iter_rows(values_only=True)]
    else:
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    if not rows:
        return [], ["file is empty"]
    head = [str(h or "").strip().lower() for h in rows[0]]
    if "shipment_id" not in head or "tracking_code" not in head:
        return [], ["columns shipment_id and tracking_code are required"]
    si, ti = head.index("shipment_id"), head.index("tracking_code")
    out, errs = [], []
    for n, r in enumerate(rows[1:], start=2):
        sid = _int(r[si] if si < len(r) else None)
        code = str(r[ti] if ti < len(r) and r[ti] is not None else "").strip()
        if not sid or sid <= 0:
            errs.append(f"row {n}: bad shipment_id")
        elif not code or len(code) > 64 or not code.replace("-", "").isalnum():
            errs.append(f"row {n}: bad tracking_code")
        else:
            out.append((sid, code))
    return out, errs


async def send_tracking_codes(writer: DigikalaWriter, pairs: list[tuple[int, str]], infra_type: str = "post"
                              ) -> tuple[int, list[str]]:
    ok, errs = 0, []
    for sid, code in pairs:
        try:
            await writer.write("sbs_tracking_code", {"order_shipment_id": sid, "infra_type": infra_type,
                                                     "tracking_codes": [{"tracking_code": code}]},
                               target=str(sid), source="sbs")
            ok += 1
        except Exception as e:  # keep going; every attempt is in write_log
            errs.append(f"{sid}: {type(e).__name__}")
    return ok, errs


def render_labels(shipments: list[tuple[SbsShipment, dict[str, Any]]], sender: str = "") -> str:
    """Printable HTML labels (A6-ish, one per page). Customer data comes from the caller and is not stored."""
    e = html.escape
    parts = []
    for sh, c in shipments:
        items = "، ".join(f"{e(i.get('title', ''))} ×{int(i.get('qty') or 1)}" for i in (sh.items or []))
        parts.append(f"""<section class="label">
<div class="row big">مرسوله {sh.shipment_id} — سفارش {sh.order_id or ''}</div>
<div class="row"><b>گیرنده:</b> {e(str(c.get('name') or ''))} — {e(str(c.get('phoneNumber') or ''))}</div>
<div class="row"><b>نشانی:</b> {e(str(c.get('state') or ''))}، {e(str(c.get('city') or ''))}، {e(str(c.get('address') or ''))}</div>
<div class="row"><b>کد پستی:</b> {e(str(c.get('postalCode') or ''))}</div>
<div class="row"><b>اقلام:</b> {items}</div>
<div class="row"><b>فرستنده:</b> {e(sender)}</div>
<div class="row"><b>کد رهگیری:</b> {e(sh.tracking_code or '')}</div></section>""")
    return ("<!DOCTYPE html><html lang='fa' dir='rtl'><head><meta charset='utf-8'><title>برچسب مرسوله‌ها</title>"
            "<style>body{font-family:Vazirmatn,Tahoma,sans-serif}.label{border:2px solid #000;padding:10px;"
            "margin:8px;page-break-after:always;width:100mm}.row{margin:4px 0}.big{font-size:18px;font-weight:700}"
            "</style></head><body>" + "".join(parts) + "</body></html>")
