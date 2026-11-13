import math
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import func, select

from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.floor import (CAN_WIN, NEED_BELOW, NEEDS_COST, NEEDS_FEES, NEEDS_UNIT, NO_RULE, OK, IMPOSSIBLE,
                          Extras, FeeProvider, Fees, FloorEngine, compute_floor, net_profit, parse_fees,
                          record_floor_event, resolve_setting, set_floor_rule, to_toman)
from sudyar.models import FeeCache, FloorEvent, FloorSetting, Variant, VariantCost

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
E0 = Extras()


def mkvar(session, vid="1", price=1_000_000, pvid="9001", raw=None, **kw):
    v = Variant(digikala_variant_id=vid, product_variant_id=pvid, price_sale=price, stock=5, active=True,
                raw_json=raw or {}, **kw)
    session.add(v)
    session.flush()
    return v


def settings(**kw):
    base = dict(price_unit="toman", fees_field_map={"commission_pct": "commissions:data.pct"},
                fees_commission_path="/fees/commissions")
    base.update(kw)
    return Settings(**base)


def cache_fees(session, pvid="9001", **fees):
    session.add(FeeCache(key=pvid, data=Fees(**fees).to_dict(), fetched_at=NOW))
    session.flush()


# ---------- units ----------
def test_to_toman():
    assert to_toman(1000, "rial") == 100 and to_toman(1000, "toman") == 1000
    assert to_toman(1000, "unknown") is None and to_toman(None, "rial") is None


# ---------- math ----------
def test_net_profit_all_components():
    fees = Fees(commission_pct=10, commission_fixed=1000, fulfillment_pct=2, fulfillment_fixed=500, tax_pct=1)
    ex = Extras(ad_share_pct=3, return_reserve_pct=2, packaging_toman=700)
    # price 100_000: variable 18% = 18_000; fixed = cost 50_000 + 1000 + 500 + 700
    assert net_profit(100_000, 50_000, fees, ex) == pytest.approx(100_000 - 18_000 - 52_200)


def test_floor_is_smallest_price_meeting_margin():
    fees = Fees(commission_pct=10)
    f, why = compute_floor(60_000, fees, E0, margin_pct=10, min_profit=None)
    assert why == "computed" and f == math.ceil(60_000 / 0.8)           # 75_000
    assert net_profit(f, 60_000, fees, E0) / f >= 0.10 - 1e-9
    assert net_profit(f - 1, 60_000, fees, E0) / (f - 1) < 0.10          # one toman less fails


def test_floor_min_profit_dominates_when_larger():
    fees = Fees(commission_pct=10)
    f, _ = compute_floor(60_000, fees, E0, margin_pct=1, min_profit=20_000)
    assert f == math.ceil((60_000 + 20_000) / 0.9)
    assert net_profit(f, 60_000, fees, E0) >= 20_000


def test_floor_impossible_margin_and_no_rule():
    assert compute_floor(1, Fees(commission_pct=60), E0, 50, None) == (None, "margin_impossible")
    assert compute_floor(1, Fees(commission_pct=10), E0, None, None)[0] is None


def test_floor_uses_extras_and_fixed_fees():
    fees = Fees(commission_pct=5, fulfillment_fixed=2000)
    ex = Extras(ad_share_pct=5, packaging_toman=1000)
    f, _ = compute_floor(10_000, fees, ex, 20, None)
    assert f == math.ceil((10_000 + 1000 + 2000) / (1 - 0.10 - 0.20))


# ---------- fee parsing / provider ----------
def test_parse_fees_from_two_sources():
    fm = {"commission_pct": "commissions:data.c", "fulfillment_fixed": "calculator:data.f", "tax_pct": "data.t"}
    fees = parse_fees({"commissions": {"data": {"c": "12.5", "t": 9}}, "calculator": {"data": {"f": 3000}}}, fm)
    assert (fees.commission_pct, fees.fulfillment_fixed, fees.tax_pct) == (12.5, 3000, 9)
    assert fees.commission_fixed is None and "commission_fixed" in fees.missing


async def test_fee_provider_gets_and_caches(session, make_limiter):
    s = settings(fees_params={"product_variant_id": "{product_variant_id}", "price": "{price}"})
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"pct": 11}})

    v = mkvar(session)
    async with DigikalaClient(s, make_limiter(requests=100), transport=httpx.MockTransport(handler)) as c:
        fp = FeeProvider(c, s)
        assert (await fp.get(session, v, NOW)).commission_pct == 11
        assert (await fp.get(session, v, NOW + timedelta(hours=1))).commission_pct == 11   # cache
        assert len(seen) == 1 and seen[0].method == "GET" and seen[0].url.params["product_variant_id"] == "9001"
        assert seen[0].url.params["price"] == "1000000"
        await fp.get(session, v, NOW + timedelta(hours=25))                                  # expired
        assert len(seen) == 2


async def test_fee_provider_disabled_or_no_fetch_returns_none(session, make_limiter):
    v = mkvar(session)
    assert await FeeProvider(None, Settings()).get(session, v, NOW) is None
    s = settings()
    async with DigikalaClient(s, make_limiter(), transport=httpx.MockTransport(lambda r: pytest.fail("no call"))) as c:
        assert await FeeProvider(c, s).get(session, v, NOW, allow_fetch=False) is None


async def test_fee_provider_error_gives_none(session, make_limiter):
    s = settings()
    v = mkvar(session)
    lim = make_limiter()
    lim.cfg.max_retries = 0
    async with DigikalaClient(s, lim, transport=httpx.MockTransport(lambda r: httpx.Response(404))) as c:
        assert await FeeProvider(c, s).get(session, v, NOW) is None


# ---------- precedence ----------
def test_precedence_variant_brand_category_global(session):
    s = settings(floor_brand_field="brand.name", floor_category_field="cat")
    v = mkvar(session, raw={"brand": {"name": "Bosch"}, "cat": "oil"})
    set_floor_rule(session, "global", margin_pct=5)
    assert resolve_setting(session, v, s).scope == "global"
    set_floor_rule(session, "category", "oil", margin_pct=6)
    assert resolve_setting(session, v, s).scope == "category"
    set_floor_rule(session, "brand", "Bosch", margin_pct=7)
    assert resolve_setting(session, v, s).scope == "brand"
    set_floor_rule(session, "variant", "1", margin_pct=8)
    assert resolve_setting(session, v, s).margin_pct == 8


def test_precedence_skips_empty_rows_and_unconfigured_scopes(session):
    s = settings()                                   # no brand/category fields configured
    v = mkvar(session, raw={"brand": "X"})
    set_floor_rule(session, "global", margin_pct=5)
    session.add(FloorSetting(scope="variant", scope_key="1"))   # exists but sets nothing
    session.flush()
    assert resolve_setting(session, v, s).scope == "global"
    other = mkvar(session, vid="2", pvid="2")
    assert resolve_setting(session, other, s).scope == "global"


def test_set_floor_rule_validation_and_idempotence(session):
    set_floor_rule(session, "global", margin_pct=5)
    set_floor_rule(session, "global", min_profit_toman=1000)           # updates same row
    assert session.scalar(select(func.count()).select_from(FloorSetting)) == 1
    row = session.scalar(select(FloorSetting))
    assert (row.margin_pct, row.min_profit_toman) == (5, 1000)
    for bad in (dict(scope="nope"), dict(scope="brand"), dict(scope="global", margin_pct=-1),
                dict(scope="global", margin_pct=100)):
        with pytest.raises(ValueError):
            set_floor_rule(session, **bad)


# ---------- engine ----------
async def test_needs_cost_without_manual_floor(session):
    s = settings()
    v = mkvar(session)
    set_floor_rule(session, "global", margin_pct=10)
    r = await FloorEngine(s).evaluate(session, v, NOW)
    assert r.status == NEEDS_COST and r.floor_toman is None


async def test_manual_floor_used_when_cost_missing(session):
    s = settings()
    v = mkvar(session, price=1_000_000)
    set_floor_rule(session, "global", margin_pct=10, floor_manual_toman=800_000, floor_manual_pct=90)
    r = await FloorEngine(s).evaluate(session, v, NOW)
    assert r.status == OK and r.floor_toman == 900_000 and r.reason == "manual_floor_no_cost"   # max(800k, 90% of 1M)


async def test_manual_pct_needs_unit(session):
    s = settings(price_unit="unknown")
    v = mkvar(session)
    set_floor_rule(session, "global", floor_manual_pct=90)
    assert (await FloorEngine(s).evaluate(session, v, NOW)).status == NEEDS_UNIT


async def test_no_rule(session):
    assert (await FloorEngine(settings()).evaluate(session, mkvar(session), NOW)).status == NO_RULE


async def test_needs_fees_when_not_cached_or_configured(session):
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=600_000, source="excel", updated_at=NOW))
    set_floor_rule(session, "global", margin_pct=10)
    r = await FloorEngine(settings()).evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == NEEDS_FEES


async def test_floor_computed_with_cost_and_fees(session):
    s = settings(cost_ad_share_pct=2)
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=600_000, source="excel", updated_at=NOW))
    cache_fees(session, commission_pct=8)
    set_floor_rule(session, "global", margin_pct=10)
    r = await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW)
    assert r.status == OK and r.floor_toman == math.ceil(600_000 / (1 - 0.10 - 0.10)) and r.reason == "computed"
    assert r.computed_floor_toman == r.floor_toman


async def test_manual_floor_acts_as_minimum_when_higher(session):
    s = settings()
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=100_000, source="manual", updated_at=NOW))
    cache_fees(session, commission_pct=10)
    set_floor_rule(session, "global", margin_pct=10, floor_manual_toman=500_000)
    r = await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW)
    assert r.floor_toman == 500_000 and r.reason == "manual_floor_higher" and r.computed_floor_toman < 500_000


async def test_fixed_fees_need_unit_but_percent_fees_do_not(session):
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=600_000, source="excel", updated_at=NOW))
    set_floor_rule(session, "global", margin_pct=10)
    s = settings(price_unit="unknown")
    cache_fees(session, commission_pct=8)
    assert (await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW)).status == OK
    session.get(FeeCache, "9001").data = Fees(commission_pct=8, fulfillment_fixed=5000).to_dict()
    assert (await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW)).status == NEEDS_UNIT


async def test_fixed_fees_converted_from_rial(session):
    s = settings(price_unit="rial")
    v = mkvar(session, price=10_000_000)                       # 1,000,000 toman
    session.add(VariantCost(variant_id=v.id, buy_cost=600_000, source="excel", updated_at=NOW))
    cache_fees(session, commission_pct=0, fulfillment_fixed=100_000)   # 100k rial = 10k toman
    set_floor_rule(session, "global", min_profit_toman=50_000)
    r = await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW)
    assert r.floor_toman == 660_000


async def test_impossible_margin(session):
    s = settings()
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=1, source="excel", updated_at=NOW))
    cache_fees(session, commission_pct=70)
    set_floor_rule(session, "global", margin_pct=40)
    assert (await FloorEngine(s, FeeProvider(None, s)).evaluate(session, v, NOW)).status == IMPOSSIBLE


async def test_profit_now(session):
    s = settings()
    v = mkvar(session, price=1_000_000)
    eng = FloorEngine(s, FeeProvider(None, s))
    assert await eng.profit_now(session, v, NOW) is None                       # no cost
    session.add(VariantCost(variant_id=v.id, buy_cost=950_000, source="excel", updated_at=NOW))
    assert await eng.profit_now(session, v, NOW) is None                       # no fees
    cache_fees(session, commission_pct=10)
    assert await eng.profit_now(session, v, NOW) == pytest.approx(-50_000)
    assert await FloorEngine(settings(price_unit="unknown"), FeeProvider(None, s)).profit_now(session, v, NOW) is None


def test_label_and_win_price(session):
    s = settings()
    eng = FloorEngine(s)
    from sudyar.floor import FloorResult
    ok = FloorResult(OK, floor_toman=1000)
    assert eng.label(ok, 1000) == CAN_WIN and eng.label(ok, 999) == NEED_BELOW and eng.label(ok, None) == "unknown"
    assert eng.label(FloorResult(NEEDS_COST), 5000) == "needs_cost"
    assert eng.win_price_toman(20_000, 99) == 2000                    # suggested price is Rial per Swagger
    assert eng.win_price_toman(None, 5000) == 5000                    # price_unit toman
    assert FloorEngine(settings(price_unit="unknown")).win_price_toman(None, 5000) is None


async def test_assess_loss_labels_and_records_event_once(session):
    s = settings()
    v = mkvar(session)
    session.add(VariantCost(variant_id=v.id, buy_cost=600_000, source="excel", updated_at=NOW))
    cache_fees(session, commission_pct=10)
    set_floor_rule(session, "global", margin_pct=10)
    eng = FloorEngine(s, FeeProvider(None, s))
    floor = math.ceil(600_000 / 0.8)
    d = await eng.assess_loss(session, v, suggested_price=(floor + 1000) * 10, buy_box_price=None, now=NOW)
    assert d["label"] == CAN_WIN and d["floor_toman"] == floor
    d = await eng.assess_loss(session, v, suggested_price=(floor - 1000) * 10, buy_box_price=None, now=NOW)
    assert d["label"] == NEED_BELOW
    assert session.scalar(select(func.count()).select_from(FloorEvent)) == 1      # unchanged floor -> 1 event
    ev = session.scalar(select(FloorEvent))
    assert ev.floor == floor and ev.suggested_floor == floor and ev.reason.startswith("ok:")


def test_record_floor_event_on_change(session):
    from sudyar.floor import FloorResult
    v = mkvar(session)
    assert record_floor_event(session, v, FloorResult(NEEDS_COST, reason="x"), NOW) is not None
    assert record_floor_event(session, v, FloorResult(NEEDS_COST, reason="x"), NOW) is None
    assert record_floor_event(session, v, FloorResult(OK, 5, 5, "computed"), NOW + timedelta(minutes=1)) is not None
