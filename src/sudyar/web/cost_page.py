"""Buy-cost page logic: search, manual edit, file preview. Local database only; Digikala is never involved.

Preview/confirm: the upload is parsed and validated, NOTHING is written; the validated rows wait in memory under a
random token (15 min, this login only). Only the confirm button writes, and it re-reads the current costs first.
"""
from __future__ import annotations

import re
import secrets
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..cost_import import (MAX_UPLOAD_BYTES, MAX_UPLOAD_ROWS, CostImportError, PlanEntry, build_plan, parse_cost,
                           read_table)
from ..costs import last_changes
from ..floor import to_toman
from ..models import CostAudit, Variant, VariantCost

PAGE_SIZE = 50
PREVIEW_TTL = 15 * 60
SHOW_REJECTED = 50
SHOW_CHANGES = 100
_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")

_PARSE_FA = (
    ("is empty", "قیمت خرید خالی است"),
    ("whole number", "قیمت خرید باید عدد صحیح (تومان) باشد"),
    ("greater than 0", "قیمت خرید باید بیشتر از صفر باشد"),
    ("unrealistically large", "قیمت خرید بیش‌ازحد بزرگ است"),
    ("is not a number", "قیمت خرید عدد نیست"),
)


def _clip(s: str) -> str:
    return s if len(s) <= 40 else s[:40] + "…"


def reason_fa(reason: str) -> str:
    """Plain Persian text for a rejected-row reason produced by the shared validator."""
    m = re.match(r"variant_id '(.*)' not found", reason)
    if m:
        return f"شناسه‌ی «{_clip(m.group(1))}» در کالاهای خوانده‌شده نیست (اول همگام‌سازی کالاها)"
    m = re.match(r"sku '(.*)' not found", reason)
    if m:
        return f"کد کالای «{_clip(m.group(1))}» پیدا نشد"
    if reason.startswith("sku matching is not configured"):
        return "تطبیق با کد کالا (SKU) تنظیم نشده؛ ستون variant_id را پر کنید"
    if reason.startswith("both variant_id and sku are empty"):
        return "شناسه‌ی کالا و کد کالا هر دو خالی است"
    m = re.match(r"duplicate of row (\d+)", reason)
    if m:
        return f"تکراری: همین کالا در ردیف {m.group(1)} هم آمده"
    for key, fa in _PARSE_FA:
        if key in reason:
            return fa
    return "ردیف معتبر نیست"


def file_error_fa(msg: str) -> str:
    table = (
        ("Unsupported file type", "فقط فایل .xlsx یا .csv پذیرفته می‌شود."),
        ("Columns missing", "ستون‌ها کم است: ستون «buy_cost» و یکی از «variant_id» یا «sku» لازم است."),
        ("is empty", "فایل خالی است."),
        ("Too many rows", f"ردیف‌ها بیشتر از سقف {MAX_UPLOAD_ROWS} است؛ فایل را کوچک‌تر کنید."),
        ("macros", "فایل با ماکرو پذیرفته نمی‌شود."),
        ("too large", "حجم فایل بازشده بیش از حد است."),
        ("UTF-8", "فایل CSV را با کدگذاری UTF-8 ذخیره کنید."),
        ("Not a text CSV", "این فایل CSV متنی نیست."),
        ("could not be read", "فایل .xlsx خوانده نشد؛ سالم نیست یا قالب دیگری دارد."),
    )
    for key, fa in table:
        if key in msg:
            return fa
    return "فایل خوانده نشد."


HIGH_FACTOR = 3
HIGH_WARNING_FA = "این عدد خیلی بالاست؛ مطمئنید تومان است؟"


def is_high(cost: int | None, variant: Variant | None, settings: Settings) -> bool:
    """Sanity check only (never a block): cost > 3x the variant's current selling price, when that price is known."""
    if cost is None or variant is None or variant.price_sale is None:
        return False
    price = to_toman(variant.price_sale, settings.price_unit)
    return price is not None and price > 0 and cost > HIGH_FACTOR * price


def high_variant_ids(session: Session, settings: Settings, entries: list[PlanEntry]) -> set[int]:
    return {e.variant_id for e in entries if is_high(e.new, session.get(Variant, e.variant_id), settings)}


def manual_cost_error_fa(raw: str) -> tuple[int | None, str | None]:
    """-> (cost, None) or (None, Persian reason). Same parser as the CLI and the file import."""
    try:
        return parse_cost(raw[:60]), None
    except ValueError as e:
        return None, reason_fa(str(e))


# ---------------------------------------------------------------- list view
@dataclass
class CostRow:
    variant: Variant
    cost: int | None
    updated_at: object | None
    source: str | None


@dataclass
class CostsView:
    rows: list[CostRow]
    total: int
    page: int
    pages: int
    q: str
    with_cost: int
    changes: list[tuple[CostAudit, str]] = field(default_factory=list)  # (audit line, variant title)


def cost_row(session: Session, variant: Variant) -> CostRow:
    c = session.get(VariantCost, variant.id)
    return CostRow(variant, c.buy_cost if c else None, c.updated_at if c else None, c.source if c else None)


def audit_lines(session: Session, limit: int = 20) -> list[tuple[CostAudit, str]]:
    out = []
    for a in last_changes(session, limit):
        v = session.get(Variant, a.variant_id)
        out.append((a, (v.title if v and v.title else a.digikala_variant_id)))
    return out


def build_costs(session: Session, q: str, page: int) -> CostsView:
    q = (q or "").strip()[:100]
    stmt = select(Variant).where(Variant.active.is_(True))
    if q:
        ascii_q = q.translate(_DIGITS)
        stmt = stmt.where(or_(Variant.title.icontains(q, autoescape=True),
                              Variant.digikala_variant_id.icontains(ascii_q, autoescape=True),
                              Variant.product_variant_id.icontains(ascii_q, autoescape=True)))
    variants = list(session.scalars(stmt.order_by(Variant.title, Variant.id)))
    total = len(variants)
    pages = max(1, -(-total // PAGE_SIZE))
    page = min(max(1, page), pages)
    chunk = variants[(page - 1) * PAGE_SIZE: page * PAGE_SIZE]
    costs = {c.variant_id: c for c in session.scalars(select(VariantCost).where(VariantCost.variant_id.in_([v.id for v in chunk])))}
    rows = [CostRow(v, costs[v.id].buy_cost if v.id in costs else None, costs[v.id].updated_at if v.id in costs else None,
                    costs[v.id].source if v.id in costs else None) for v in chunk]
    with_cost = len(list(session.scalars(select(VariantCost.variant_id).where(VariantCost.buy_cost.is_not(None)))))
    return CostsView(rows, total, page, pages, q, with_cost, audit_lines(session))


# ---------------------------------------------------------------- upload preview
@dataclass
class Preview:
    entries: list[PlanEntry]
    rejected: list[tuple[int, str]]  # Persian reasons
    high_ids: set[int] = field(default_factory=set)  # variants whose new cost is > 3x the selling price

    @property
    def high(self): return [e for e in self.entries if e.variant_id in self.high_ids and e.kind != "unchanged"]

    @property
    def created(self): return [e for e in self.entries if e.kind == "created"]
    @property
    def updated(self): return [e for e in self.entries if e.kind == "updated"]
    @property
    def unchanged(self): return [e for e in self.entries if e.kind == "unchanged"]
    @property
    def to_apply(self): return [e for e in self.entries if e.kind != "unchanged"]


def make_preview(session: Session, settings: Settings, filename: str, content: bytes) -> Preview:
    """Validate an uploaded file. Raises CostImportError (English message; use file_error_fa). Writes nothing."""
    name = (filename or "").lower()
    if not (name.endswith(".xlsx") or name.endswith(".csv")):
        raise CostImportError("Unsupported file type. Use .xlsx or .csv")
    if len(content) > MAX_UPLOAD_BYTES:
        raise CostImportError("too large")
    suffix = ".xlsx" if name.endswith(".xlsx") else ".csv"
    if suffix == ".xlsx" and not content.startswith(b"PK"):
        raise CostImportError("The file could not be read as .xlsx.")
    with tempfile.TemporaryDirectory(prefix="sudyar-up-") as d:
        path = Path(d) / f"upload{suffix}"  # our own name: the client's file name is never used on disk
        path.write_bytes(content)
        rows = read_table(path, max_rows=MAX_UPLOAD_ROWS)
    entries, rejected = build_plan(session, settings, rows)
    return Preview(entries, [(n, reason_fa(r)) for n, r in rejected], high_variant_ids(session, settings, entries))


class PreviewStore:
    """In-memory, short-lived, bound to the login's CSRF token. Holds only validated (variant, cost) rows."""

    def __init__(self, clock=time.monotonic, max_items: int = 8):
        self._clock, self._max = clock, max_items
        self._items: dict[str, tuple[str, float, list[PlanEntry]]] = {}
        self._lock = threading.Lock()

    def keep(self, owner: str, entries: list[PlanEntry]) -> str:
        token = secrets.token_urlsafe(24)
        with self._lock:
            self._purge()
            while len(self._items) >= self._max:
                self._items.pop(next(iter(self._items)))
            self._items[token] = (owner, self._clock() + PREVIEW_TTL, entries)
        return token

    def peek(self, owner: str, token: str) -> list[PlanEntry] | None:
        with self._lock:
            self._purge()
            item = self._items.get(token)
            return item[2] if item is not None and secrets.compare_digest(item[0], owner) else None

    def take(self, owner: str, token: str) -> list[PlanEntry] | None:
        with self._lock:
            self._purge()
            item = self._items.get(token)
            if item is None or not secrets.compare_digest(item[0], owner):
                return None
            del self._items[token]  # single use
            return item[2]

    def _purge(self) -> None:
        now = self._clock()
        for k in [k for k, v in self._items.items() if v[1] < now]:
            del self._items[k]
