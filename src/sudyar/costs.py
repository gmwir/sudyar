"""Write a buy cost (Toman) to OUR database with an audit line. Used by the web page and the file import.

Local only: nothing here talks to Digikala. Cost is optional; clearing removes the row (the variant then simply
has no cost and keeps working with its manual floor).
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .models import CostAudit, Variant, VariantCost, utcnow

SOURCES = ("manual", "file")
_STORED = {"manual": "manual", "file": "excel"}  # variant_costs.source values (kept as before)


def set_cost(session: Session, variant: Variant, new: int | None, source: str, now: datetime | None = None) -> bool:
    """Set (int > 0) or clear (None) the cost of one variant. Returns True if anything changed. Does not commit."""
    if source not in SOURCES:
        raise ValueError("source must be manual or file")
    if new is not None and (isinstance(new, bool) or not isinstance(new, int) or new <= 0):
        raise ValueError("cost must be a positive whole number")
    now = now or utcnow()
    existing = session.get(VariantCost, variant.id)
    old = existing.buy_cost if existing is not None else None
    if new is None:
        if existing is None:
            return False
        session.execute(delete(VariantCost).where(VariantCost.variant_id == variant.id))
    else:
        stored = _STORED[source]
        if existing is not None and existing.buy_cost == new and existing.source == stored:
            return False
        if existing is None:
            session.add(VariantCost(variant_id=variant.id, buy_cost=new, source=stored, updated_at=now))
        else:
            existing.buy_cost, existing.source, existing.updated_at = new, stored, now
    session.add(CostAudit(variant_id=variant.id, digikala_variant_id=variant.digikala_variant_id, old_cost=old,
                          new_cost=new, source=source, changed_at=now))
    return True


def last_changes(session: Session, limit: int = 20) -> list[CostAudit]:
    return list(session.scalars(select(CostAudit).order_by(CostAudit.changed_at.desc(), CostAudit.id.desc()).limit(limit)))
