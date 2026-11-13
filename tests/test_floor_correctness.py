"""Part 3d: the exact edge cases from the second security review."""
import json
import math
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from shapes import commission_item as ci, commissions_page
from sudyar import __main__ as cli
from sudyar import fees as fees_mod
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import ALL_CATEGORIES, FeeProvider, parse_commission_row, sync_commissions
from sudyar.floor import (CAN_WIN, NEED_BELOW, NO_FLOOR, FloorEngine, FloorResult, _valid_cost, breakeven_floor,
                          set_floor_rule)
from sudyar.floor_report import build_report, format_report
from sudyar.models import Base, Commission, FeeCache, FloorSetting, Variant, VariantCost
from sudyar.notifier import FLOOR_LABEL_FA

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def mkvar(session, vid="1", price_rial=10_000_000, category="101", pid="500"):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=pid, price_sale=price_rial,
                stock=5, active=True, raw_json={"category_id": category})
    session.add(v)
    session.flush()
    return v


def seed(session, *items, at=NOW, partial=()):
    for it in items:
        row, _ = parse_commission_row(it)
        session.add(Commission(fetched_at=at, **row))
    m = session.get(FeeCache, "commissions")
    data = {"rows": len(items), "partial_categories": list(partial)}
    if m is None:
        session.add(FeeCache(key="commissions", data=data, fetched_at=at))
    else:
        m.data, m.fetched_at = data, at
    session.flush()


def cost(session, v, toman):
    session.add(VariantCost(variant_id=v.id, buy_cost=toman, source="excel", updated_at=NOW))
    session.flush()


def engine(**kw):
    s = Settings(**kw)
    return FloorEngine(s, FeeProvider(None, s))


# ============ 1. a computed manual floor of 0 is never an "ok" floor ============
@pytest.mark.parametrize("price_rial", [0, 1, 4])          # 1 rial = 0.1 toman; 90% of it rounds up to 1, of 0 stays 0
async def test_manual_pct_on_zero_price_is_no_floor_not_ok_zero(session, price_rial):
    seed(session, ci(101, None, None, 0.10))                     # fresh commission data (Part 3f)
    v = mkvar(session, price_rial=price_rial)
    set_floor_rule(session, "global", floor_manual_pct=90)
    r = await engine().evaluate(session, v, NOW)
    if price_rial == 0:
        assert r.status == NO_FLOOR and r.floor_toman is None            # the exact review case: price 0 + manual 90%
    else:
        assert r.status == "ok" and r.floor_toman and r.floor_toman > 0   # tiny but real prices still give a floor > 0


async def test_zero_price_with_cost_known_and_manual_only_is_no_floor(session):
    v = mkvar(session, price_rial=0)
    seed(session, ci(101, None, None, 0.10))
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_pct=90)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == NO_FLOOR and r.floor_toman is None


async def test_zero_price_manual_pct_plus_valid_manual_toman_uses_the_toman(session):
    seed(session, ci(101, None, None, 0.10))                     # fresh commission data (Part 3f)
    v = mkvar(session, price_rial=0)
    set_floor_rule(session, "global", floor_manual_pct=90, floor_manual_toman=700)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == "ok" and r.floor_toman == 700


async def test_zero_price_with_margin_rule_and_no_cost_still_asks_for_cost(session):
    v = mkvar(session, price_rial=0)
    set_floor_rule(session, "global", margin_pct=10, floor_manual_pct=90)
    assert (await engine().evaluate(session, v, NOW)).status == "needs_cost"


async def test_no_floor_never_labels_a_win(session):
    eng = engine()
    r = FloorResult(NO_FLOOR)
    assert eng.label(r, 10**9) == "no_floor"
    assert "no_floor" in FLOOR_LABEL_FA


async def test_report_counts_no_floor_status(session):
    v = mkvar(session, price_rial=0)
    set_floor_rule(session, "global", floor_manual_pct=90)
    rep = await build_report(session, engine(), NOW)
    assert rep.status_counts == {"no_floor": 1} and "no_floor: 1" in format_report(rep)


# ============ 2. floor >= cost / (1 - commission) when the commission is known ============
async def test_review_example_cost_900000_commission_10_gives_1000000(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_toman=1)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == "ok" and r.floor_toman == 1_000_000
    assert r.floor_toman * (1 - 0.10) - 900_000 >= -1e-6                 # at the floor, commission + cost are covered


def test_breakeven_floor_math_and_invalid_shares():
    assert breakeven_floor(900_000, 0.10) == 1_000_000
    assert breakeven_floor(100, 0) == 100
    assert breakeven_floor(100, 0.5) == 200
    for bad in (1.0, 1.5, -0.1, float("nan"), float("inf")):
        assert breakeven_floor(100, bad) is None


async def test_commission_share_100_percent_is_rejected(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.60, extra=0.40))                 # 60% + 40% extra = 100% when extra is included
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_toman=5_000_000)
    ok = await engine().evaluate(session, v, NOW)                        # extra excluded by default: 60% is fine
    assert ok.status == "ok" and ok.floor_toman == 5_000_000
    both = await engine(floor_include_extra_commission=True).evaluate(session, v, NOW)
    assert both.status == "impossible" and "below 100%" in both.reason and both.floor_toman is None


async def test_commission_unknown_keeps_needs_fees_even_with_manual_floor(session):
    v = mkvar(session)
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_toman=2_000_000)      # no commission rows at all
    r = await engine().evaluate(session, v, NOW)
    assert r.status == "needs_fees" and r.floor_toman is None


async def test_commission_stale_keeps_needs_fees_even_with_manual_floor(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10), at=NOW)
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_toman=2_000_000)
    eng = engine()
    assert (await eng.evaluate(session, v, NOW + timedelta(days=1), allow_fetch=False)).status == "ok"
    r = await eng.evaluate(session, v, NOW + timedelta(days=4), allow_fetch=False)
    assert r.status == "needs_fees" and "older than" in r.reason


async def test_margin_rule_floor_also_never_below_breakeven(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))
    cost(session, v, 900_000)
    set_floor_rule(session, "global", margin_pct=0, min_profit_toman=0)
    r = await engine().evaluate(session, v, NOW)
    assert r.floor_toman >= 1_000_000 and r.floor_toman == breakeven_floor(900_000, 0.10)


async def test_no_cost_manual_floor_is_unchanged(session):
    seed(session, ci(101, None, None, 0.10))                     # fresh commission data (Part 3f)
    v = mkvar(session)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == "ok" and r.floor_toman == 800_000 and r.reason == "manual_floor_no_cost"


async def test_labels_use_the_raised_floor(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_toman=1)
    eng = engine()
    low = await eng.assess_loss(session, v, suggested_price=9_000_000, buy_box_price=None, now=NOW)    # 900,000 toman
    assert low["floor_toman"] == 1_000_000 and low["label"] == NEED_BELOW
    high = await eng.assess_loss(session, v, suggested_price=10_500_000, buy_box_price=None, now=NOW)  # 1,050,000 toman
    assert high["label"] == CAN_WIN


# ============ 3. buy_cost <= 0 / NaN / inf is missing; DB CHECK constraint ============
@pytest.mark.parametrize("bad", [0, -1, -900_000, float("nan"), float("inf"), float("-inf"), True, None])
def test_valid_cost_helper(bad):
    assert _valid_cost(bad) is None


def test_valid_cost_accepts_positive():
    assert _valid_cost(1) == 1 and _valid_cost(900_000) == 900_000


def test_model_check_constraint_rejects_zero_and_negative(session):
    v = mkvar(session)
    for bad in (0, -5):
        session.add(VariantCost(variant_id=v.id, buy_cost=bad, source="excel", updated_at=NOW))
        with pytest.raises(IntegrityError):
            session.flush()
        session.rollback()
        v = mkvar(session, vid=f"x{bad}")
    session.add(VariantCost(variant_id=v.id, buy_cost=None, source="excel", updated_at=NOW))   # unknown cost is allowed
    session.flush()


async def test_cost_zero_row_in_old_database_is_treated_as_missing(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))
    session.execute(text("PRAGMA ignore_check_constraints = ON"))          # simulate a database from before the constraint
    session.add(VariantCost(variant_id=v.id, buy_cost=0, source="manual", updated_at=NOW))
    session.flush()
    session.execute(text("PRAGMA ignore_check_constraints = OFF"))
    set_floor_rule(session, "global", margin_pct=0)
    eng = engine()
    r = await eng.evaluate(session, v, NOW)
    assert r.status == "needs_cost" and r.floor_toman is None             # NOT "ok with floor 0"
    assert await eng.profit_now(session, v, NOW) is None


async def test_negative_cost_row_with_manual_floor_behaves_like_no_cost(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))                              # fresh commission data (Part 3f)
    session.execute(text("PRAGMA ignore_check_constraints = ON"))
    session.add(VariantCost(variant_id=v.id, buy_cost=-10, source="manual", updated_at=NOW))
    session.flush()
    session.execute(text("PRAGMA ignore_check_constraints = OFF"))
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    r = await engine().evaluate(session, v, NOW)
    assert r.reason == "manual_floor_no_cost" and r.floor_toman == 800_000


def run_alembic(db: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db}", "DIGIKALA_SELF_TOKEN": "x", "PYTHONPATH": str(ROOT / "src")}
    return subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, capture_output=True, text=True)


def test_migration_0006_nulls_bad_rows_and_enforces_check(tmp_path):
    import sqlite3
    db = tmp_path / "m.db"
    assert run_alembic(db, "upgrade", "0005").returncode == 0
    con = sqlite3.connect(db)
    con.execute("insert into variants(id,digikala_variant_id,active,last_seen_at,raw_json) "
                "values (1,'a',1,'2026-01-01','{}'),(2,'b',1,'2026-01-01','{}'),(3,'c',1,'2026-01-01','{}')")
    con.execute("insert into variant_costs values (1,0,'excel','2026-01-01'),(2,-5,'excel','2026-01-01'),(3,500,'excel','2026-01-01')")
    con.commit()
    con.close()
    out = run_alembic(db, "upgrade", "head")
    assert out.returncode == 0, out.stderr
    con = sqlite3.connect(db)
    assert con.execute("select variant_id, buy_cost from variant_costs order by 1").fetchall() == [(1, None), (2, None), (3, 500)]
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("update variant_costs set buy_cost = 0 where variant_id = 3")
    con.close()
    assert run_alembic(db, "downgrade", "0005").returncode == 0           # reversible
    assert run_alembic(db, "upgrade", "head").returncode == 0             # and repeatable


# ============ 4. incomplete categories: no 2,000 cap, never partial ============
def mk_client(handler, s, make_limiter):
    return DigikalaClient(s, make_limiter(requests=100_000), transport=httpx.MockTransport(handler))


def big_settings():
    return Settings(digikala_self_token="t", postgres_password="p", page_size=1000)


async def test_more_than_2000_incomplete_categories_are_all_incomplete(session, make_limiter):
    s = big_settings()
    items = [ci(10_000 + i, None, None, 0.05) for i in range(10)]                    # 10 healthy categories
    items += [ci(i, 5, "A", 3.0) for i in range(2_500)]                              # 2,500 categories whose row is invalid
    items += [ci(i, 6, "B", 0.07) for i in range(2_500)]                             # ... each with another valid brand row
    async with mk_client(lambda r: httpx.Response(200, json=commissions_page(items)), s, make_limiter) as c:
        res = await sync_commissions(c, session, s, NOW)
    assert res.partial_categories == 2_500 and len(res.rejected) == 2_500
    stored = session.get(FeeCache, "commissions").data["partial_categories"]
    assert len(stored) == 2_500 and ALL_CATEGORIES not in stored                       # nothing silently dropped at 2,000
    p = FeeProvider(None, s)
    for cat in ("0", "1999", "2000", "2499"):                                         # beyond the old 2,000 cap too
        assert p.lookup(session, cat, None) is None
    assert p.lookup(session, "10000", None).commission_pct == 5.0                     # healthy categories still work
    p.preload(session)
    assert p.lookup(session, "2400", None) is None and p.lookup(session, "10001", None) is not None


async def test_if_the_safety_limit_is_exceeded_every_category_is_incomplete(session, make_limiter, monkeypatch):
    s = big_settings()
    monkeypatch.setattr(fees_mod, "MAX_PARTIAL_CATEGORIES", 5)
    items = [ci(10_000, None, None, 0.05)] + [ci(i, 5, "A", 3.0) for i in range(6)] + [ci(i, 6, "B", 0.07) for i in range(6)]
    async with mk_client(lambda r: httpx.Response(200, json=commissions_page(items)), s, make_limiter) as c:
        res = await sync_commissions(c, session, s, NOW)
    assert session.get(FeeCache, "commissions").data["partial_categories"] == [ALL_CATEGORIES]
    assert res.partial_categories == 6                                                  # the real count is still reported
    p = FeeProvider(None, s)
    assert p.lookup(session, "10000", None) is None and p.lookup(session, "3", None) is None   # no floors at all
    p.preload(session)
    assert p.lookup(session, "10000", None) is None
    v = mkvar(session, category="10000")
    cost(session, v, 1000)
    set_floor_rule(session, "global", margin_pct=10)
    r = await FloorEngine(s, p).evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and r.floor_toman is None and "invalid" in r.reason


async def test_limit_not_exceeded_marks_only_the_affected_categories(session, make_limiter, monkeypatch):
    s = big_settings()
    monkeypatch.setattr(fees_mod, "MAX_PARTIAL_CATEGORIES", 5)
    items = [ci(10_000, None, None, 0.05), ci(1, 5, "A", 3.0), ci(1, 6, "B", 0.07)]
    async with mk_client(lambda r: httpx.Response(200, json=commissions_page(items)), s, make_limiter) as c:
        await sync_commissions(c, session, s, NOW)
    p = FeeProvider(None, s)
    assert session.get(FeeCache, "commissions").data["partial_categories"] == ["1"]
    assert p.lookup(session, "1", None) is None and p.lookup(session, "10000", None) is not None


# ============ 5. Windows: say the .env check is skipped ============
def test_env_check_on_windows_prints_a_skip_note(tmp_path):
    f = tmp_path / ".env"
    f.write_text("X=1\n")
    msg = cli.env_file_warning(str(f), os_name="nt")
    assert msg and msg.startswith("Note:") and "skipped on Windows" in msg
    assert cli.env_file_warning(str(tmp_path / "missing"), os_name="nt") == msg      # even with no file: never silent


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_env_check_on_posix_unchanged(tmp_path):
    f = tmp_path / ".env"
    f.write_text("X=1\n")
    f.chmod(0o644)
    assert cli.env_file_warning(str(f), os_name="posix").startswith("WARNING: .env is readable by other users")
    f.chmod(0o600)
    assert cli.env_file_warning(str(f), os_name="posix") is None


def test_check_config_prints_the_windows_note(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "t")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setattr(cli.os if hasattr(cli, "os") else os, "name", "nt", raising=False)
    assert cli.main(["check-config"]) == 0
    out = capsys.readouterr().out
    assert out.count("skipped on Windows") == 1
