"""Part 3h: manual-only floors use the TRUE break-even (with cost components); absurd floors are refused."""
import math
from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from shapes import commission_item as ci
from sudyar.config import Settings
from sudyar.fees import FeeProvider, parse_commission_row
from sudyar.floor import (MAX_FLOOR_TOMAN, Components, FloorEngine, breakeven_floor, compute_floor, net_profit,
                          resolve_components, set_floor_rule)
from sudyar.models import Commission, FeeCache, FloorEvent, Variant, VariantCost

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def mkvar(session, vid="1", price_rial=10_000_000, category="101"):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=f"p{vid}", price_sale=price_rial,
                stock=5, active=True, raw_json={"category_id": category})
    session.add(v)
    session.flush()
    return v


def setup(session, commission=0.10, cost=900_000, price_rial=10_000_000):
    row, _ = parse_commission_row(ci(101, None, None, commission))
    session.add(Commission(fetched_at=NOW, **row))
    session.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=NOW))
    v = mkvar(session, price_rial=price_rial)
    if cost is not None:
        session.add(VariantCost(variant_id=v.id, buy_cost=cost, source="excel", updated_at=NOW))
    session.flush()
    return v


def engine():
    s = Settings()
    return FloorEngine(s, FeeProvider(None, s))


async def evaluate(session, v):
    eng = engine()
    return eng, await eng.evaluate(session, v, NOW, allow_fetch=False)


# ================= 1. manual-only floor includes tax, packaging, ... =================
async def test_review_case_cost_900k_commission_10_tax_9_packaging_50k(session):
    v = setup(session, commission=0.10, cost=900_000)
    set_floor_rule(session, "global", floor_manual_toman=1, tax_pct=9, packaging_toman=50_000)
    eng, r = await evaluate(session, v)
    comps = resolve_components(session, v, eng.s)
    assert r.status == "ok" and r.reason == "manual_floor_raised_to_breakeven"
    assert r.floor_toman == math.ceil(950_000 / 0.81) == 1_172_840                  # (900k + 50k) / (1 - 0.10 - 0.09)
    assert r.floor_toman > 1_000_000                                                 # the old formula (cost / 0.9) was too low
    assert net_profit(1_000_000, 900_000, 10, comps) < 0                              # ... and lost money
    assert net_profit(r.floor_toman, 900_000, 10, comps) >= -1e-6                     # selling at the floor does not lose money
    assert net_profit(r.floor_toman - 1, 900_000, 10, comps) < 1e-6                   # and it is the smallest such integer


async def test_manual_floor_above_the_true_breakeven_is_kept(session):
    v = setup(session)
    set_floor_rule(session, "global", floor_manual_toman=2_000_000, tax_pct=9, packaging_toman=50_000)
    _, r = await evaluate(session, v)
    assert r.floor_toman == 2_000_000 and r.reason == "manual_floor"


async def test_manual_floor_between_old_and_true_breakeven_is_raised(session):
    v = setup(session)
    set_floor_rule(session, "global", floor_manual_toman=1_050_000, tax_pct=9, packaging_toman=50_000)  # old formula would keep it
    _, r = await evaluate(session, v)
    assert r.floor_toman == 1_172_840 and r.reason == "manual_floor_raised_to_breakeven"


@pytest.mark.parametrize("rule,expected", [
    (dict(tax_pct=9), math.ceil(900_000 / 0.81)),
    (dict(packaging_toman=50_000), math.ceil(950_000 / 0.90)),
    (dict(ad_share_pct=2, return_reserve_pct=3, fulfillment_toman=30_000), math.ceil(930_000 / 0.85)),
    (dict(), 1_000_000),                                                              # no components: plain cost / (1 - commission)
])
async def test_each_component_type_is_in_the_breakeven(session, rule, expected):
    v = setup(session)
    set_floor_rule(session, "global", floor_manual_toman=1, **rule)
    _, r = await evaluate(session, v)
    assert r.floor_toman == expected


async def test_components_from_category_scope_are_included(session):
    v = setup(session)
    set_floor_rule(session, "global", floor_manual_toman=1)
    set_floor_rule(session, "category", "101", tax_pct=9, packaging_toman=50_000)
    _, r = await evaluate(session, v)
    assert r.floor_toman == 1_172_840


async def test_manual_only_floor_equals_margin_floor_with_zero_margin(session):
    v = setup(session)
    set_floor_rule(session, "global", floor_manual_toman=1, tax_pct=9, packaging_toman=50_000)
    manual = (await evaluate(session, v))[1].floor_toman
    set_floor_rule(session, "global", margin_pct=0, min_profit_toman=0)
    both = (await evaluate(session, v))[1]                                            # now a margin rule exists too
    assert both.floor_toman == manual == compute_floor(900_000, 10, resolve_components(session, v, Settings()), 0, 0)[0]


async def test_components_plus_commission_at_100_percent_are_impossible_for_manual_floors(session):
    v = setup(session, commission=0.50)
    set_floor_rule(session, "global", floor_manual_toman=5_000_000, tax_pct=50)       # 50% + 50% = 100%
    _, r = await evaluate(session, v)
    assert r.status == "impossible" and r.reason == "margin_impossible" and r.floor_toman is None


async def test_commission_share_below_100_message_unchanged(session):
    s = Settings(floor_include_extra_commission=True)
    row, _ = parse_commission_row(ci(101, None, None, 0.60, extra=0.40))
    session.add(Commission(fetched_at=NOW, **row))
    session.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=NOW))
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=900_000, source="excel", updated_at=NOW))
    session.flush()
    set_floor_rule(session, "global", floor_manual_toman=5_000_000)
    r = await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "impossible" and "below 100%" in r.reason


@pytest.mark.parametrize("cost,commission,tax,pack", [
    (900_000, 0.10, 9, 50_000), (1, 0.0, 0, 0), (123_457, 0.03, 9, 7_777), (5_000_000, 0.25, 10, 100_000),
    (999_999, 0.075, 2.5, 1), (10**9, 0.12, 15, 10**6), (777, 0.5, 20, 3),
])
async def test_manual_only_floor_never_loses_money_grid(session, cost, commission, tax, pack):
    v = setup(session, commission=commission, cost=cost)
    set_floor_rule(session, "global", floor_manual_toman=1, tax_pct=tax, packaging_toman=pack)
    eng, r = await evaluate(session, v)
    comps = resolve_components(session, v, eng.s)
    assert r.status == "ok"
    assert net_profit(r.floor_toman, cost, commission * 100, comps) >= -1e-6
    assert net_profit(r.floor_toman - 1, cost, commission * 100, comps) < 1e-6


# ================= 2. absurd floors are refused =================
def test_cap_constant():
    assert MAX_FLOOR_TOMAN == 10**15


def test_compute_floor_refuses_absurd_values():
    assert compute_floor(10**12, 0, Components(), 99.9999, None) == (None, "floor_too_large")      # ~1e18
    assert compute_floor(10**12, 0, Components(), None, 10**12 * 10**4) == (None, "floor_too_large")
    f, why = compute_floor(10**12, 0, Components(), 99.8, None)                                    # ~5e14: allowed
    assert why == "computed" and f <= MAX_FLOOR_TOMAN
    assert compute_floor(100, 10, Components(), 10, None)[1] == "computed"


def test_breakeven_floor_refuses_absurd_values():
    assert breakeven_floor(10**12, 0.9999999) is None
    assert breakeven_floor(10**12, 0.5) == 2 * 10**12


async def test_absurd_margin_floor_is_impossible_not_ok(session):
    v = setup(session, commission=0.0, cost=10**12)
    set_floor_rule(session, "global", margin_pct=99.9999)                                         # allowed input, absurd result
    _, r = await evaluate(session, v)
    assert r.status == "impossible" and r.reason == "floor_too_large"
    assert r.floor_toman is None and r.computed_floor_toman is None


async def test_absurd_floor_never_reaches_the_database(session):
    v = setup(session, commission=0.0, cost=10**12)
    set_floor_rule(session, "global", margin_pct=99.9999)
    d = await engine().assess_loss(session, v, suggested_price=10**6, buy_box_price=None, now=NOW)   # would raise OverflowError on 1e19 in SQLite
    assert d["status"] == "impossible" and d["floor_toman"] is None and d["label"] == "impossible"
    ev = session.scalar(select(FloorEvent))
    assert ev.floor is None and ev.suggested_floor is None and "floor_too_large" in ev.reason


async def test_absurd_manual_pct_floor_is_refused(session):
    v = setup(session, cost=None, price_rial=10**17)                                               # 1e16 Toman price
    set_floor_rule(session, "global", floor_manual_pct=1000)                                       # 1e17 Toman > cap
    _, r = await evaluate(session, v)
    assert r.status == "impossible" and r.reason == "floor_too_large" and r.floor_toman is None


async def test_absurd_manual_pct_floor_with_cost_is_refused(session):
    v = setup(session, cost=900_000, price_rial=10**17)
    set_floor_rule(session, "global", floor_manual_pct=1000)
    _, r = await evaluate(session, v)
    assert r.status == "impossible" and r.reason == "floor_too_large"


async def test_floor_at_the_largest_allowed_manual_value_is_still_ok(session):
    v = setup(session, cost=None)
    set_floor_rule(session, "global", floor_manual_toman=10**12)                                   # the input maximum, far below the cap
    _, r = await evaluate(session, v)
    assert r.status == "ok" and r.floor_toman == 10**12


async def test_normal_floors_are_unchanged_by_the_cap(session):
    v = setup(session, commission=0.10, cost=600_000)
    set_floor_rule(session, "global", margin_pct=10)
    _, r = await evaluate(session, v)
    assert r.status == "ok" and r.floor_toman == 750_000 and r.reason == "computed"
