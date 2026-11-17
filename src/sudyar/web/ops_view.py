"""Data for the read-only Part 6 page (/ops). Reads our own database only; never calls Digikala."""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import Settings
from ..finance import money_summary
from ..inventory import low_stock
from ..models import Promotion, RepriceAction, RepriceRule, SbsShipment, Variant, WriteLog
from ..sbs import open_shipments

MODE_FA = {"off": "خاموش (هیچ چیزی فرستاده نمی‌شود)", "dry_run": "آزمایشی (فقط ثبت می‌شود)",
           "live": "واقعی (قیمت‌ها در دیجی‌کالا عوض می‌شوند)"}
STRATEGY_FA = {"buybox": "برنده‌ی بای‌باکس", "undercut": "کمی ارزان‌تر از بای‌باکس", "rank": "رتبه‌ی مشخص",
               "fx": "بر اساس ارز", "hold": "ثابت"}


@dataclass
class OpsView:
    mode: str
    mode_fa: str
    rules: list = field(default_factory=list)
    actions: list = field(default_factory=list)
    low: list = field(default_factory=list)
    money: dict = field(default_factory=dict)
    shipments: list = field(default_factory=list)
    promotions: list = field(default_factory=list)
    writes: list = field(default_factory=list)


def build_ops(session: Session, s: Settings) -> OpsView:
    v = OpsView(mode=s.write_mode, mode_fa=MODE_FA.get(s.write_mode, s.write_mode))
    v.rules = [(r, var, STRATEGY_FA.get(r.strategy, r.strategy)) for r, var in session.execute(
        select(RepriceRule, Variant).join(Variant, Variant.id == RepriceRule.variant_id).order_by(Variant.title))]
    v.actions = list(session.execute(select(RepriceAction, Variant).join(Variant, Variant.id == RepriceAction.variant_id)
                                     .order_by(RepriceAction.id.desc()).limit(30)))
    v.low = low_stock(session, s)[:50]
    v.money = {k: (x // 10) for k, x in money_summary(session).items()}  # Rial -> Toman
    v.shipments = open_shipments(session)[:50]
    v.promotions = list(session.scalars(select(Promotion).order_by(Promotion.start_at.desc()).limit(20)))
    v.writes = list(session.scalars(select(WriteLog).order_by(WriteLog.id.desc()).limit(20)))
    return v
