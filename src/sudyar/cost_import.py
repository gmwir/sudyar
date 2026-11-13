"""Optional buy-cost import from CSV / XLSX (columns: variant_id or sku, buy_cost).

Idempotent (same file twice = no change), validates every row, reports rejected rows.
The app works fully without this. Costs are whole numbers in Toman. Writes only to OUR database.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .floor import _field
from .models import Variant, VariantCost, utcnow


class CostImportError(Exception):
    """File-level problem (not found, wrong type, missing columns)."""


@dataclass
class ImportResult:
    dry_run: bool
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    rejected: list[tuple[int, str]] = field(default_factory=list)  # (row number in file, reason)

    @property
    def accepted(self) -> int:
        return self.created + self.updated + self.unchanged


_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def parse_cost(value: Any) -> int:
    """'1,200,000' / '۱۲۰۰۰۰۰' / 1200000.0 -> 1200000. Raises ValueError with a clear reason."""
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValueError("buy_cost is empty")
    if isinstance(value, bool):
        raise ValueError("buy_cost is not a number")
    if isinstance(value, (int, float)):
        num = float(value)
    else:
        txt = str(value).translate(_DIGITS)
        for ch in (",", "٬", " ", " ", "٫"):
            txt = txt.replace(ch, "")
        try:
            num = float(txt)
        except ValueError:
            raise ValueError(f"buy_cost '{value}' is not a number") from None
    if num != num or num in (float("inf"), float("-inf")):
        raise ValueError("buy_cost is not a number")
    if not num.is_integer():
        raise ValueError("buy_cost must be a whole number (Toman)")
    if num <= 0:
        raise ValueError("buy_cost must be greater than 0")
    if num > 10**12:
        raise ValueError("buy_cost is unrealistically large (more than 1,000,000,000,000 Toman)")
    return int(num)


def _norm_header(h: Any) -> str:
    return str(h or "").strip().lower().replace(" ", "_")


def read_table(path: Path) -> list[tuple[int, dict[str, Any]]]:
    """(row number as shown in the file, {column: value}) for every non-empty data row."""
    if not path.is_file():
        raise CostImportError(f"File not found: {path}")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        text = path.read_text(encoding="utf-8-sig")
        try:
            dialect = csv.Sniffer().sniff(text[:2048], delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        rows = list(csv.reader(text.splitlines(), dialect))
    elif suffix == ".xlsx":
        from openpyxl import load_workbook

        wb = load_workbook(path, read_only=True, data_only=True)
        rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
        wb.close()
    else:
        raise CostImportError("Unsupported file type. Use .xlsx or .csv")
    if not rows:
        raise CostImportError("The file is empty.")
    header = [_norm_header(h) for h in rows[0]]
    if "buy_cost" not in header or not ({"variant_id", "sku"} & set(header)):
        raise CostImportError("Columns missing: need 'buy_cost' and either 'variant_id' or 'sku'.")
    out = []
    for i, r in enumerate(rows[1:], start=2):
        if all(c is None or str(c).strip() == "" for c in r):
            continue
        out.append((i, {header[j]: r[j] for j in range(min(len(header), len(r)))}))
    return out


def _sku_index(session: Session, s: Settings) -> dict[str, Variant]:
    if not s.cost_sku_field:
        return {}
    idx: dict[str, Variant] = {}
    for v in session.scalars(select(Variant)):
        sku = _field(v.raw_json, s.cost_sku_field)
        if sku not in (None, ""):
            idx[sku.strip()] = v
    return idx


def import_costs(session: Session, path: str | Path, settings: Settings, dry_run: bool = False,
                 now: datetime | None = None) -> ImportResult:
    now = now or utcnow()
    rows = read_table(Path(path))
    res = ImportResult(dry_run=dry_run)
    skus = _sku_index(session, settings)
    seen: dict[int, int] = {}  # variant row id -> first row number
    for rownum, row in rows:
        vid_raw = str(row.get("variant_id") or "").strip()
        sku_raw = str(row.get("sku") or "").strip()
        variant: Variant | None = None
        if vid_raw:
            variant = session.scalar(select(Variant).where(Variant.digikala_variant_id == vid_raw))
            if variant is None:
                res.rejected.append((rownum, f"variant_id '{vid_raw}' not found (run sync-variants first)"))
                continue
        elif sku_raw:
            if not settings.cost_sku_field:
                res.rejected.append((rownum, "sku matching is not configured (COST_SKU_FIELD); use variant_id"))
                continue
            variant = skus.get(sku_raw)
            if variant is None:
                res.rejected.append((rownum, f"sku '{sku_raw}' not found"))
                continue
        else:
            res.rejected.append((rownum, "both variant_id and sku are empty"))
            continue
        try:
            cost = parse_cost(row.get("buy_cost"))
        except ValueError as e:
            res.rejected.append((rownum, str(e)))
            continue
        if variant.id in seen:
            res.rejected.append((rownum, f"duplicate of row {seen[variant.id]} (same variant)"))
            continue
        seen[variant.id] = rownum
        existing = session.get(VariantCost, variant.id)
        if existing is None:
            res.created += 1
            if not dry_run:
                session.add(VariantCost(variant_id=variant.id, buy_cost=cost, source="excel", updated_at=now))
        elif existing.buy_cost == cost and existing.source == "excel":
            res.unchanged += 1
        else:
            res.updated += 1
            if not dry_run:
                existing.buy_cost, existing.source, existing.updated_at = cost, "excel", now
    if dry_run:
        session.rollback()
    else:
        session.commit()
    return res
