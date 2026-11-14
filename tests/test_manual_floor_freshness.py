"""Part 3f: a manual floor (even with no buy cost) is only shown while commission data is fresh."""
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import delete

from shapes import commission_item as ci, commissions_page
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import FeeProvider, parse_commission_row
from sudyar.floor import FloorEngine, set_floor_rule
from sudyar.floor_report import build_report
from sudyar.models import Commission, FeeCache, Variant, VariantCost

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def mkvar(session, vid="1", category="101", price_rial=10_000_000):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=f"p{vid}", price_sale=price_rial,
                stock=5, active=True, raw_json={"category_id": category})
    session.add(v)
    session.flush()
    return v


def add_rows(session, at, *items):
    for it in items or [ci(101, None, None, 0.10)]:
        row, _ = parse_commission_row(it)
        session.add(Commission(fetched_at=at, **row))
    session.flush()


def add_marker(session, at):
    session.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=at))
    session.flush()


def engine(**kw):
    s = Settings(**kw)
    return FloorEngine(s, FeeProvider(None, s))


# ---------- manual floor + NO cost ----------
async def test_manual_floor_no_cost_stale_commission_is_needs_fees(session):
    v = mkvar(session)
    add_rows(session, NOW)
    add_marker(session, NOW)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    eng = engine()
    assert (await eng.evaluate(session, v, NOW + timedelta(days=2), allow_fetch=False)).status == "ok"      # still fresh
    r = await eng.evaluate(session, v, NOW + timedelta(days=3, hours=1), allow_fetch=False)                  # > 3 days
    assert r.status == "needs_fees" and r.floor_toman is None and "older than 3 days" in r.reason


async def test_manual_floor_no_cost_never_synced_is_needs_fees(session):
    v = mkvar(session)                                           # no rows, no marker at all
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None and "never synced" in r.reason


async def test_manual_floor_no_cost_fresh_commission_is_ok(session):
    v = mkvar(session)
    add_rows(session, NOW)
    add_marker(session, NOW)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    r = await engine().evaluate(session, v, NOW + timedelta(hours=1), allow_fetch=False)
    assert r.status == "ok" and r.floor_toman == 800_000 and r.reason == "manual_floor_no_cost"


async def test_manual_pct_and_both_manual_values_follow_the_same_rule(session):
    v = mkvar(session, price_rial=10_000_000)
    set_floor_rule(session, "global", floor_manual_pct=90, floor_manual_toman=700_000)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "needs_fees"      # never synced
    add_rows(session, NOW)
    add_marker(session, NOW)
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "ok" and r.floor_toman == 900_000


async def test_manual_floor_with_no_commission_row_for_the_category_still_needs_fresh_data_not_a_row(session):
    v = mkvar(session, category="999")                           # category has no commission row, but data is fresh
    add_rows(session, NOW)
    add_marker(session, NOW)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "ok"             # freshness gate only


# ---------- rows without a sync marker ----------
async def test_rows_without_marker_400_days_old_are_needs_fees(session):
    v = mkvar(session)
    add_rows(session, NOW - timedelta(days=400))                 # rows exist, no sync record, very old
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None and "no sync record" in r.reason


async def test_rows_without_marker_are_never_fresh_even_if_just_inserted(session):
    v = mkvar(session)
    add_rows(session, NOW)                                       # brand new rows, but unknown provenance
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "needs_fees"


async def test_rows_without_marker_block_cost_known_floors_too(session):
    v = mkvar(session)
    add_rows(session, NOW - timedelta(days=400))
    session.add(VariantCost(variant_id=v.id, buy_cost=900_000, source="excel", updated_at=NOW))
    session.flush()
    set_floor_rule(session, "global", margin_pct=10)
    eng = engine()
    r = await eng.evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None
    assert await eng.profit_now(session, v, NOW) is None


def test_provider_staleness_rules(session):
    p = FeeProvider(None, Settings())
    assert p.is_stale(session, NOW) is False and p.data_usable(session, NOW) is False       # empty: nothing to distrust, nothing usable
    add_rows(session, NOW)
    assert p.is_stale(session, NOW) is True and p.data_usable(session, NOW) is False        # rows without marker
    add_marker(session, NOW)
    assert p.is_stale(session, NOW) is False and p.data_usable(session, NOW) is True
    assert p.is_stale(session, NOW + timedelta(days=4)) is True and p.data_usable(session, NOW + timedelta(days=4)) is False


async def test_get_returns_none_for_rows_without_marker(session):
    add_rows(session, NOW)
    p = FeeProvider(None, Settings())
    assert await p.get(session, "101", None, NOW, allow_fetch=False) is None
    assert p.lookup(session, "101", None) is not None            # lookup alone is not the gate; get() is


# ---------- unchanged outcomes ----------
async def test_no_manual_floor_and_no_cost_is_still_needs_cost(session):
    v = mkvar(session)
    set_floor_rule(session, "global", margin_pct=10)             # stale/never-synced data does not change this
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "needs_cost"


async def test_no_rule_is_still_no_rule(session):
    assert (await engine().evaluate(session, mkvar(session), NOW, allow_fetch=False)).status == "no_rule"


async def test_orphan_marker_still_wins_with_fresh_data(session):
    v = mkvar(session)
    add_rows(session, NOW)
    session.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 1, "partial_categories": ["*"]}, fetched_at=NOW))
    session.flush()
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and "no category" in r.reason


# ---------- allow_fetch: a refresh can rescue, a failed refresh cannot ----------
async def test_stale_data_is_refreshed_before_the_manual_floor_is_shown(session, make_limiter):
    s = Settings(digikala_self_token="t", postgres_password="p")
    v = mkvar(session)
    add_rows(session, NOW)
    add_marker(session, NOW)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=commissions_page([ci(101, None, None, 0.12)]))

    later = NOW + timedelta(days=5)
    async with DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(handler)) as c:
        eng = FloorEngine(s, FeeProvider(c, s))
        r = await eng.evaluate(session, v, later)                # allow_fetch=True: GET refresh, then ok
    assert r.status == "ok" and r.floor_toman == 800_000 and len(calls) == 1 and calls[0].method == "GET"


async def test_failed_refresh_keeps_needs_fees(session, make_limiter):
    s = Settings(digikala_self_token="t", postgres_password="p")
    v = mkvar(session)
    add_rows(session, NOW)
    add_marker(session, NOW)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    lim = make_limiter(requests=1000)
    lim.cfg.max_retries = 0
    async with DigikalaClient(s, lim, transport=httpx.MockTransport(lambda r: httpx.Response(500))) as c:
        r = await FloorEngine(s, FeeProvider(c, s)).evaluate(session, v, NOW + timedelta(days=5))
    assert r.status == "needs_fees" and r.floor_toman is None


# ---------- radar label + report ----------
async def test_assess_loss_labels_needs_fees_for_stale_manual_floor(session):
    v = mkvar(session)
    add_rows(session, NOW)
    add_marker(session, NOW)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    d = await engine().assess_loss(session, v, suggested_price=20_000_000, buy_box_price=None, now=NOW + timedelta(days=9))
    assert d["label"] == "needs_fees" and d["floor_toman"] is None


async def test_report_counts_manual_floors_as_needs_fees_when_stale(session):
    for i in range(3):
        mkvar(session, vid=str(i))
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    rep = await build_report(session, engine(), NOW)                   # never synced
    assert rep.status_counts == {"needs_fees": 3}


# ---------- README: 3b scopes ----------
def test_readme_3b_section_lists_the_four_scopes():
    text = (ROOT / "README_FA.md").read_text()
    section = text.split("## توکن شما این دسترسی‌ها را لازم دارد")[1].split("اگر پیام «check the Self Token scopes»")[0]
    assert all(f"- **{k}**" in section for k in ("variant", "commission", "insight", "order"))
    assert "pricing/buybox" not in section and "commissions**" not in section
    assert section.count("- **") == 4
