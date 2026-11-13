import math
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from shapes import commission_item as ci
from sudyar.config import Settings
from sudyar.fees import FEE_ASSUMED_MAX_BRAND, FEE_BRAND_ROW, FeeProvider, parse_commission_row
from sudyar.floor import (CAN_WIN, COMPONENTS, IMPOSSIBLE, NEED_BELOW, NEEDS_COST, NEEDS_FEES, NEEDS_UNIT, NO_RULE, OK,
                          Components, FloorEngine, FloorResult, compute_floor, net_profit, record_floor_event,
                          resolve_components, resolve_setting, set_floor_rule, set_variant_brand, to_toman)
from sudyar.models import Commission, FeeCache, FloorEvent, FloorSetting, Variant, VariantBrand, VariantCost

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def settings(**kw):
    return Settings(**{"price_unit": "rial", **kw})


def mkvar(session, vid="1", price_rial=10_000_000, category="101", pid="500", **kw):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=pid, price_sale=price_rial,
                stock=5, active=True, raw_json={"category_id": category, "supplier_code": f"S{vid}"}, **kw)
    session.add(v)
    session.flush()
    return v


def seed_fee(session, *items):
    for it in items:
        row, _ = parse_commission_row(it)
        session.add(Commission(fetched_at=NOW, **row))
    session.add(FeeCache(key="commissions", data={}, fetched_at=NOW)) if session.get(FeeCache, "commissions") is None else None
    session.flush()


def cost(session, v, toman):
    session.add(VariantCost(variant_id=v.id, buy_cost=toman, source="excel", updated_at=NOW))
    session.flush()


def engine(s=None):
    s = s or settings()
    return FloorEngine(s, FeeProvider(None, s))


# ---------- units ----------
def test_to_toman_rial_is_divided_by_ten():
    assert to_toman(1000, "rial") == 100 and to_toman(1000, "toman") == 1000
    assert to_toman(1000, "unknown") is None and to_toman(None, "rial") is None


# ---------- math (Toman) ----------
def test_net_profit_all_components():
    comps = Components(pct={"fulfillment": 2, "tax": 1, "ad_share": 3, "return_reserve": 2},
                       toman={"fulfillment": 500, "packaging": 700})
    # price 100_000 toman: commission 10% + 8% = 18_000; fixed = cost 50_000 + 500 + 700
    assert net_profit(100_000, 50_000, 10, comps) == pytest.approx(100_000 - 18_000 - 51_200)


def test_floor_is_smallest_price_meeting_margin():
    f, why = compute_floor(60_000, 10, Components(), margin_pct=10, min_profit_toman=None)
    assert why == "computed" and f == math.ceil(60_000 / 0.8)
    assert net_profit(f, 60_000, 10) / f >= 0.10 - 1e-9
    assert net_profit(f - 1, 60_000, 10) / (f - 1) < 0.10


def test_floor_min_profit_dominates_when_larger():
    f, _ = compute_floor(60_000, 10, Components(), margin_pct=1, min_profit_toman=20_000)
    assert f == math.ceil(80_000 / 0.9) and net_profit(f, 60_000, 10) >= 20_000


def test_floor_with_components():
    comps = Components(pct={"ad_share": 5, "tax": 5}, toman={"packaging": 1000, "fulfillment": 2000})
    f, _ = compute_floor(10_000, 5, comps, 20, None)
    assert f == 20_000                                            # 13_000 / 0.65
    assert net_profit(f, 10_000, 5, comps) / f == pytest.approx(0.20)


def test_floor_impossible_and_no_rule():
    assert compute_floor(1, 60, Components(), 50, None) == (None, "margin_impossible")
    assert compute_floor(1, 10, Components(), None, None)[0] is None


def test_components_included_and_unset():
    c = Components(pct={"tax": 9}, toman={"packaging": 100})
    assert c.included == ["tax", "packaging"] or set(c.included) == {"tax", "packaging"}
    assert set(c.unset) == {"fulfillment", "ad_share", "return_reserve"}
    assert Components().unset == list(COMPONENTS)


# ---------- rule resolution ----------
def test_precedence_variant_brand_category_global(session):
    seed_fee(session, ci(101, 5, "Bosch", 0.03))
    s = settings()
    v = mkvar(session)
    set_floor_rule(session, "global", margin_pct=5)
    assert resolve_setting(session, v, s).scope == "global"
    set_floor_rule(session, "category", "101", margin_pct=6)
    assert resolve_setting(session, v, s).scope == "category"
    set_variant_brand(session, "1", "5")
    set_floor_rule(session, "brand", "5", margin_pct=7)
    assert resolve_setting(session, v, s).scope == "brand"
    set_floor_rule(session, "variant", "1", margin_pct=8)
    assert resolve_setting(session, v, s).margin_pct == 8


def test_brand_scope_ignored_without_manual_brand(session):
    s = settings()
    v = mkvar(session)
    set_floor_rule(session, "brand", "5", margin_pct=7)          # exists, but this variant has no brand set
    set_floor_rule(session, "global", margin_pct=5)
    assert resolve_setting(session, v, s).scope == "global"


def test_rows_that_set_no_rule_are_skipped(session):
    v = mkvar(session)
    set_floor_rule(session, "global", margin_pct=5)
    session.add(FloorSetting(scope="variant", scope_key="1", ad_share_pct=2))   # components only: not a margin rule
    session.flush()
    assert resolve_setting(session, v, settings()).scope == "global"


def test_components_resolved_per_component_most_specific_first(session):
    v = mkvar(session)
    set_floor_rule(session, "global", tax_pct=9, packaging_toman=1000, ad_share_pct=2)
    set_floor_rule(session, "category", "101", ad_share_pct=4, fulfillment_toman=5000)
    c = resolve_components(session, v, settings())
    assert c.pct["ad_share"] == 4 and c.pct["tax"] == 9           # category overrides ad_share, global supplies tax
    assert c.toman["packaging"] == 1000 and c.toman["fulfillment"] == 5000
    assert "return_reserve" in c.unset and "tax" not in c.unset


def test_components_default_unset(session):
    assert resolve_components(session, mkvar(session), settings()).included == []


def test_set_floor_rule_validation_and_idempotence(session):
    set_floor_rule(session, "global", margin_pct=5)
    set_floor_rule(session, "global", min_profit_toman=1000, tax_pct=9)
    assert session.scalar(select(func.count()).select_from(FloorSetting)) == 1
    row = session.scalar(select(FloorSetting))
    assert (row.margin_pct, row.min_profit_toman, row.tax_pct) == (5, 1000, 9)
    for bad in (dict(scope="nope"), dict(scope="brand"), dict(scope="global", margin_pct=-1),
                dict(scope="global", margin_pct=100), dict(scope="global", tax_pct=100),
                dict(scope="global", bogus=1), dict(scope="global", packaging_toman=-5)):
        with pytest.raises(ValueError):
            set_floor_rule(session, **bad)


def test_set_variant_brand_validates_against_commissions(session):
    mkvar(session)
    with pytest.raises(ValueError, match="sync-fees"):
        set_variant_brand(session, "1", "5")
    seed_fee(session, ci(101, 5, "Bosch", 0.03))
    with pytest.raises(ValueError, match="not found in commissions"):
        set_variant_brand(session, "1", "999")
    with pytest.raises(ValueError, match="variant"):
        set_variant_brand(session, "nope", "5")
    set_variant_brand(session, "1", "5")
    set_variant_brand(session, "1", "5")                           # idempotent
    assert session.scalar(select(func.count()).select_from(VariantBrand)) == 1


# ---------- engine ----------
async def test_needs_cost_without_manual_floor(session):
    v = mkvar(session)
    set_floor_rule(session, "global", margin_pct=10)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == NEEDS_COST and r.floor_toman is None


async def test_manual_floor_used_when_cost_missing(session):
    v = mkvar(session, price_rial=10_000_000)                     # 1,000,000 toman
    set_floor_rule(session, "global", margin_pct=10, floor_manual_toman=800_000, floor_manual_pct=90)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == OK and r.floor_toman == 900_000 and r.reason == "manual_floor_no_cost"


async def test_manual_pct_needs_unit(session):
    v = mkvar(session)
    set_floor_rule(session, "global", floor_manual_pct=90)
    assert (await engine(settings(price_unit="unknown")).evaluate(session, v, NOW)).status == NEEDS_UNIT


async def test_no_rule(session):
    assert (await engine().evaluate(session, mkvar(session), NOW)).status == NO_RULE


async def test_needs_fees_without_commission_row_or_category(session):
    v = mkvar(session)
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == NEEDS_FEES
    seed_fee(session, ci(999))                                    # other category only
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == NEEDS_FEES
    nocat = Variant(digikala_variant_id="9", price_sale=1, active=True, raw_json={})
    session.add(nocat)
    session.flush()
    cost(session, nocat, 100)
    assert (await engine().evaluate(session, nocat, NOW)).status == NEEDS_FEES


async def test_floor_computed_with_real_commission_and_manual_components(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "Bosch", 0.08))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10, ad_share_pct=2)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == OK and r.floor_toman == math.ceil(600_000 / (1 - 0.08 - 0.02 - 0.10))
    assert r.reason == "computed" and r.fee_reason == "fee_category_row" and r.commission_pct == 8.0
    assert r.included_components == ["ad_share"] and set(r.unset_components) == set(COMPONENTS) - {"ad_share"}


async def test_unset_components_listed_and_not_included(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "Bosch", 0.10))
    cost(session, v, 100_000)
    set_floor_rule(session, "global", margin_pct=10)
    r = await engine().evaluate(session, v, NOW)
    assert r.unset_components == list(COMPONENTS) and r.included_components == []
    assert r.floor_toman == math.ceil(100_000 / 0.8)             # unset costs are counted as 0, and said so


async def test_fee_assumed_max_brand_recorded_in_result_and_event(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    r = await engine().evaluate(session, v, NOW)
    assert r.fee_reason == FEE_ASSUMED_MAX_BRAND and r.commission_pct == 8.0
    d = await engine().assess_loss(session, v, 1, 1, NOW)
    assert d["fee_reason"] == FEE_ASSUMED_MAX_BRAND
    ev = session.scalar(select(FloorEvent))
    assert ev.reason.endswith("+fee_assumed_max_brand")


async def test_manual_brand_selects_that_commission(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    set_variant_brand(session, "1", "5")
    r = await engine().evaluate(session, v, NOW)
    assert r.fee_reason == FEE_BRAND_ROW and r.commission_pct == 3.0
    assert r.floor_toman == math.ceil(600_000 / 0.87)


async def test_extra_commission_flags_change_the_floor(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "A", 0.03, extra=0.01, return_free=0.02))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    base = (await engine().evaluate(session, v, NOW)).floor_toman
    both = settings(floor_include_extra_commission=True, floor_include_return_free_commission=True)
    assert (await engine(both).evaluate(session, v, NOW)).floor_toman > base
    assert base == math.ceil(600_000 / 0.87)


async def test_manual_floor_acts_as_minimum_when_higher(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "A", 0.10))
    cost(session, v, 100_000)
    set_floor_rule(session, "global", margin_pct=10, floor_manual_toman=500_000)
    r = await engine().evaluate(session, v, NOW)
    assert r.floor_toman == 500_000 and r.reason == "manual_floor_higher" and r.computed_floor_toman < 500_000


async def test_impossible_margin(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "A", 0.70))
    cost(session, v, 1)
    set_floor_rule(session, "global", margin_pct=40)
    assert (await engine().evaluate(session, v, NOW)).status == IMPOSSIBLE


async def test_profit_now_is_in_toman_from_rial_price(session):
    v = mkvar(session, price_rial=10_000_000)                     # 1,000,000 toman
    eng = engine()
    assert await eng.profit_now(session, v, NOW) is None          # no cost
    cost(session, v, 950_000)
    assert await eng.profit_now(session, v, NOW) is None          # no commission
    seed_fee(session, ci(101, 5, "A", 0.10))
    assert await eng.profit_now(session, v, NOW) == pytest.approx(-50_000)
    set_floor_rule(session, "global", packaging_toman=10_000)
    assert await eng.profit_now(session, v, NOW) == pytest.approx(-60_000)
    assert await engine(settings(price_unit="unknown")).profit_now(session, v, NOW) is None
    toman = engine(settings(price_unit="toman"))
    v.price_sale = 1_000_000
    assert await toman.profit_now(session, v, NOW) == pytest.approx(-60_000)


def test_label_and_win_price():
    eng = engine()
    ok = FloorResult(OK, floor_toman=1000)
    assert eng.label(ok, 1000) == CAN_WIN and eng.label(ok, 999) == NEED_BELOW and eng.label(ok, None) == "unknown"
    assert eng.label(FloorResult(NEEDS_COST), 5000) == "needs_cost"
    assert eng.win_price_toman(20_000, 99) == 2000                # suggested price is Rial
    assert eng.win_price_toman(None, 50_000) == 5000              # price_unit rial
    assert engine(settings(price_unit="toman")).win_price_toman(None, 5000) == 5000
    assert engine(settings(price_unit="unknown")).win_price_toman(None, 5000) is None


async def test_assess_loss_labels_and_records_event_once(session):
    v = mkvar(session)
    seed_fee(session, ci(101, 5, "A", 0.10))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    eng = engine()
    floor = math.ceil(600_000 / 0.8)
    d = await eng.assess_loss(session, v, suggested_price=(floor + 1000) * 10, buy_box_price=None, now=NOW)
    assert d["label"] == CAN_WIN and d["floor_toman"] == floor and d["unset_components"] == list(COMPONENTS)
    d = await eng.assess_loss(session, v, suggested_price=(floor - 1000) * 10, buy_box_price=None, now=NOW)
    assert d["label"] == NEED_BELOW
    assert session.scalar(select(func.count()).select_from(FloorEvent)) == 1
    ev = session.scalar(select(FloorEvent))
    assert ev.floor == floor and ev.suggested_floor == floor and ev.reason.startswith("ok:")


def test_record_floor_event_on_change(session):
    v = mkvar(session)
    assert record_floor_event(session, v, FloorResult(NEEDS_COST, reason="x"), NOW) is not None
    assert record_floor_event(session, v, FloorResult(NEEDS_COST, reason="x"), NOW) is None
    assert record_floor_event(session, v, FloorResult(OK, 5, 5, "computed"), NOW + timedelta(minutes=1)) is not None
