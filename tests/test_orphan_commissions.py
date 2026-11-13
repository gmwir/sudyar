"""Part 3e: one commission row with no usable category_id makes ALL floors fail closed (needs_fees)."""
import logging
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from shapes import commission_item as ci, commissions_page
from sudyar import __main__ as cli
from sudyar import fees as fees_mod
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import (ALL_CATEGORIES, LIMIT_MESSAGE_FA, ORPHAN_MESSAGE_FA, FeeProvider, FeeSyncRefused,
                         sync_commissions, usable_category_id)
from sudyar.floor import FloorEngine, set_floor_rule
from sudyar.floor_report import build_report, format_report
from sudyar.models import Base, Commission, FeeCache, Variant, VariantCost

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
EXPECTED_FA = "یک ردیف کمیسیون بدون دسته پیدا شد؛ تا اصلاح نشود هیچ کفی نمایش داده نمی‌شود"


def settings(**kw):
    return Settings(**{"digikala_self_token": "t", "postgres_password": "p", "page_size": 1000, **kw})


def mkvar(session, vid, category, price_rial=10_000_000):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=f"p{vid}", price_sale=price_rial,
                stock=5, active=True, raw_json={"category_id": category})
    session.add(v)
    session.flush()
    return v


def cost(session, v, toman=600_000):
    session.add(VariantCost(variant_id=v.id, buy_cost=toman, source="excel", updated_at=NOW))
    session.flush()


async def do_sync(session, make_limiter, items, s=None, force=False, now=NOW):
    s = s or settings()
    client = DigikalaClient(s, make_limiter(requests=100_000),
                            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=commissions_page(items))))
    async with client as c:
        return await sync_commissions(c, session, s, now, force=force)


def good_items():
    return [ci(101, None, None, 0.10), ci(102, None, None, 0.08)]


def engine(**kw):
    s = settings(**kw)
    return FloorEngine(s, FeeProvider(None, s))


def test_message_is_exactly_the_requested_persian_text():
    assert ORPHAN_MESSAGE_FA == EXPECTED_FA


@pytest.mark.parametrize("value,usable", [
    (101, True), ("101", True), (0, True), ("abc", True), (None, False), ("", False), ("   ", False),
    (False, False), (True, False), ({}, False), ([], False), ({"id": 1}, False), ([1], False),
])
def test_usable_category_id(value, usable):
    assert usable_category_id(value) is usable


# ---------- one orphan among valid rows -> everything needs_fees ----------
@pytest.mark.parametrize("orphan_category", [None, "", "   ", False, {}, []])
async def test_one_orphan_row_makes_all_floors_needs_fees(session, make_limiter, orphan_category):
    res = await do_sync(session, make_limiter, good_items() + [ci(orphan_category, 5, "X", 0.30)])
    assert res.orphan_rows == 1 and res.rows == 2 and len(res.rejected) == 1
    data = session.get(FeeCache, "commissions").data
    assert data["partial_categories"] == [ALL_CATEGORIES] and data["orphan_rows"] == 1      # same marker as the 50,000 limit
    set_floor_rule(session, "global", margin_pct=10)
    eng = engine()
    for vid, cat in (("a", "101"), ("b", "102"), ("c", "999")):
        v = mkvar(session, vid, cat)
        cost(session, v)
        r = await eng.evaluate(session, v, NOW, allow_fetch=False)
        assert r.status == "needs_fees" and r.floor_toman is None and r.computed_floor_toman is None
        assert "no category" in r.reason and "ALL categories" in r.reason
        assert await eng.profit_now(session, v, NOW) is None                                # no profit figure either


async def test_orphan_row_is_logged_as_warning(session, make_limiter, caplog):
    caplog.set_level(logging.WARNING)
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    assert "1 rows have no usable category_id" in caplog.text and "NO floors are shown" in caplog.text


async def test_orphan_with_valid_rows_still_stored_but_never_used(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    assert session.scalar(select(func.count()).select_from(Commission)) == 2        # data kept for inspection
    assert FeeProvider(None, settings()).lookup(session, "101", None) is None       # ... but no category can use it
    p = FeeProvider(None, settings())
    p.preload(session)
    assert p.lookup(session, "102", None) is None


# ---------- no orphan -> behaviour unchanged ----------
async def test_no_orphan_keeps_normal_behaviour(session, make_limiter):
    res = await do_sync(session, make_limiter, good_items())
    assert res.orphan_rows == 0
    data = session.get(FeeCache, "commissions").data
    assert data["partial_categories"] == [] and data["orphan_rows"] == 0
    set_floor_rule(session, "global", margin_pct=10)
    v = mkvar(session, "a", "101")
    cost(session, v, 600_000)
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "ok" and r.floor_toman == 750_000 and r.fee_reason == "fee_category_row"
    assert engine().fees.incomplete_message_fa(session) is None


async def test_invalid_row_with_a_category_is_still_only_partial_not_global(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(103, 5, "B", 3.0)])        # bad commission, but category known
    data = session.get(FeeCache, "commissions").data
    assert data["partial_categories"] == ["103"] and data["orphan_rows"] == 0
    set_floor_rule(session, "global", margin_pct=10)
    v = mkvar(session, "a", "101")
    cost(session, v)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "ok"   # other categories unaffected


# ---------- manual floors must not bypass ----------
async def test_manual_floor_does_not_bypass_orphan(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    eng = engine()
    no_cost = mkvar(session, "n", "101")                                    # manual floor, no cost: used to be ok
    r = await eng.evaluate(session, no_cost, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None
    with_cost = mkvar(session, "c", "101")
    cost(session, with_cost, 900_000)                                       # manual floor with cost
    r = await eng.evaluate(session, with_cost, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None
    unknown_cat = mkvar(session, "u", "555")
    assert (await eng.evaluate(session, unknown_cat, NOW, allow_fetch=False)).status == "needs_fees"


async def test_manual_pct_floor_and_margin_plus_manual_do_not_bypass(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    set_floor_rule(session, "global", floor_manual_pct=90, margin_pct=10, floor_manual_toman=1)
    v = mkvar(session, "a", "101")
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "needs_fees"
    cost(session, v)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).floor_toman is None


async def test_manual_floor_works_without_orphan(session, make_limiter):
    await do_sync(session, make_limiter, good_items())
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    v = mkvar(session, "a", "101")
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "ok" and r.floor_toman == 800_000                    # unchanged without an orphan


async def test_variant_without_any_rule_is_still_no_rule(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    v = mkvar(session, "a", "101")
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "no_rule"   # no floor existed anyway


# ---------- same fail-closed path as the 50,000 safety limit ----------
async def test_safety_limit_uses_the_same_path_and_now_blocks_manual_floors(session, make_limiter, monkeypatch):
    monkeypatch.setattr(fees_mod, "MAX_PARTIAL_CATEGORIES", 2)
    items = good_items() + [ci(c, 5, "A", 3.0) for c in (201, 202, 203)] + [ci(c, 6, "B", 0.07) for c in (201, 202, 203)]
    res = await do_sync(session, make_limiter, items)
    data = session.get(FeeCache, "commissions").data
    assert res.orphan_rows == 0 and data["partial_categories"] == [ALL_CATEGORIES] and data["orphan_rows"] == 0
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    v = mkvar(session, "a", "101")
    r = await engine().evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None and "too many invalid" in r.reason
    assert engine().fees.incomplete_message_fa(session) == LIMIT_MESSAGE_FA != ORPHAN_MESSAGE_FA


# ---------- recovery and persistence ----------
async def test_next_clean_sync_recovers(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    set_floor_rule(session, "global", margin_pct=10)
    v = mkvar(session, "a", "101")
    cost(session, v, 600_000)
    assert (await engine().evaluate(session, v, NOW, allow_fetch=False)).status == "needs_fees"
    await do_sync(session, make_limiter, good_items(), now=NOW + timedelta(days=1))
    r = await engine().evaluate(session, v, NOW + timedelta(days=1), allow_fetch=False)
    assert r.status == "ok" and r.floor_toman == 750_000
    assert session.get(FeeCache, "commissions").data["orphan_rows"] == 0


async def test_refused_sync_keeps_the_fail_closed_state(session, make_limiter):
    ten = [ci(100 + i, None, None, 0.05) for i in range(9)] + [ci(None, 5, "X", 0.3)]
    await do_sync(session, make_limiter, ten)
    assert session.get(FeeCache, "commissions").data["orphan_rows"] == 1
    with pytest.raises(FeeSyncRefused):                                      # >30% drop: refused, old state kept
        await do_sync(session, make_limiter, [ci(100, None, None, 0.05)], now=NOW + timedelta(days=1))
    assert session.get(FeeCache, "commissions").data["partial_categories"] == [ALL_CATEGORIES]
    assert engine().fees.incomplete_message_fa(session) == ORPHAN_MESSAGE_FA


async def test_orphan_in_a_later_page_is_found(session, make_limiter):
    s = settings(page_size=2)
    pages = {1: [ci(101, None, None, 0.10), ci(102, None, None, 0.08)], 2: [ci(None, 5, "X", 0.30)]}

    def handler(request):
        p = int(request.url.params["page"])
        return httpx.Response(200, json=commissions_page(pages[p], p, 2))

    async with DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(handler)) as c:
        res = await sync_commissions(c, session, s, NOW)
    assert res.orphan_rows == 1 and session.get(FeeCache, "commissions").data["partial_categories"] == [ALL_CATEGORIES]


# ---------- report: Persian message ----------
async def test_report_shows_persian_message_and_only_needs_fees(session, make_limiter):
    await do_sync(session, make_limiter, good_items() + [ci(None, 5, "X", 0.30)])
    set_floor_rule(session, "global", margin_pct=10, floor_manual_toman=500_000)
    for vid, cat in (("a", "101"), ("b", "102"), ("c", "999")):
        v = mkvar(session, vid, cat)
        cost(session, v)
    rep = await build_report(session, engine(), NOW)
    text = format_report(rep)
    assert rep.status_counts == {"needs_fees": 3}
    assert EXPECTED_FA in text and text.splitlines()[0].startswith("!!!")
    assert "ok:" not in text and rep.below_floor == [] and rep.sells_low_profit == []


async def test_report_without_orphan_has_no_warning(session, make_limiter):
    await do_sync(session, make_limiter, good_items())
    set_floor_rule(session, "global", margin_pct=10)
    v = mkvar(session, "a", "101")
    cost(session, v)
    text = format_report(await build_report(session, engine(), NOW))
    assert EXPECTED_FA not in text and "!!!" not in text


# ---------- check-config + sync-fees CLI ----------
@pytest.fixture
def cli_db(monkeypatch, tmp_path):
    db = tmp_path / "t.db"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok-secret-123")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    eng = create_engine(f"sqlite:///{db}")
    Base.metadata.create_all(eng)
    return sessionmaker(eng)


def test_check_config_shows_the_persian_message(cli_db, capsys):
    with cli_db() as s:
        s.add(FeeCache(key="commissions", data={"rows": 2, "orphan_rows": 1, "partial_categories": ["*"]}, fetched_at=NOW))
        s.commit()
    assert cli.main(["check-config"]) == 0
    out = capsys.readouterr().out
    assert f"WARNING: {EXPECTED_FA}" in out and "tok-secret-123" not in out


def test_check_config_limit_case_and_clean_case(cli_db, capsys):
    with cli_db() as s:
        s.add(FeeCache(key="commissions", data={"rows": 2, "orphan_rows": 0, "partial_categories": ["*"]}, fetched_at=NOW))
        s.commit()
    cli.main(["check-config"])
    assert LIMIT_MESSAGE_FA in capsys.readouterr().out
    with cli_db() as s:
        s.get(FeeCache, "commissions").data = {"rows": 2, "orphan_rows": 0, "partial_categories": []}
        s.commit()
    assert cli.main(["check-config"]) == 0
    out = capsys.readouterr().out
    assert EXPECTED_FA not in out and LIMIT_MESSAGE_FA not in out


def test_check_config_works_when_db_is_unreachable_or_empty(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'nothing.db'}")      # no tables at all
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "t")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    assert cli.main(["check-config"]) == 0
    assert EXPECTED_FA not in capsys.readouterr().out


def test_sync_fees_cli_warns_about_orphan(cli_db, capsys, monkeypatch):
    from sudyar.db import make_engine, make_session_factory
    from sudyar.rate_limiter import LimiterConfig, RateLimiter

    items = good_items() + [ci(None, 5, "X", 0.30)]

    def fake_build(s, radar=False):
        lim = RateLimiter(LimiterConfig(requests=1000, max_retries=0))
        return make_session_factory(make_engine(s.database_url)), DigikalaClient(
            s, lim, transport=httpx.MockTransport(lambda r: httpx.Response(200, json=commissions_page(items))))

    monkeypatch.setattr(cli, "_build", fake_build)
    assert cli.main(["sync-fees"]) == 0
    out = capsys.readouterr().out
    assert f"WARNING: {EXPECTED_FA}" in out and "Commissions saved: 2 rows" in out
    assert cli.main(["check-config"]) == 0
    assert EXPECTED_FA in capsys.readouterr().out                                    # persisted for check-config
