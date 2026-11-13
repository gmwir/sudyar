"""Tests for the Part 3c security fixes (one section per review finding)."""
import logging
import math
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError

from shapes import commission_item as ci, commissions_page
from sudyar import __main__ as cli
from sudyar.config import ConfigError, PATH_FIELDS, Settings, check_bale_base, load_settings
from sudyar.cost_import import parse_cost
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import FeeProvider, FeeSyncRefused, parse_commission_row, sync_commissions
from sudyar.floor import (MAX_MANUAL_PCT, MAX_TOMAN, Components, FloorEngine, compute_floor, set_floor_rule)
from sudyar.floor_report import build_report, format_report
from sudyar.logging_setup import error_code, redact, short_error
from sudyar.models import Commission, FeeCache, FloorSetting, Variant, VariantCost
from sudyar.notifier import build_notifiers
from sudyar.rate_limiter import ApiError

ROOT = Path(__file__).resolve().parent.parent
NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def mkvar(session, vid="1", price_rial=10_000_000, category="101", pid="500"):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=pid, price_sale=price_rial,
                stock=5, active=True, raw_json={"category_id": category, "supplier_code": f"S{vid}"})
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


# =========== 1. manual floor never below cost; manual <= 0 rejected ===========
async def test_manual_floor_is_raised_to_cost(session):
    v = mkvar(session)
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_toman=1_000)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == "ok" and r.floor_toman == 900_000 and r.reason == "manual_floor_raised_to_cost"


async def test_manual_pct_floor_also_raised_to_cost(session):
    v = mkvar(session, price_rial=10_000_000)                    # 1,000,000 toman
    cost(session, v, 900_000)
    set_floor_rule(session, "global", floor_manual_pct=50)       # 500,000 < cost
    assert (await engine().evaluate(session, v, NOW)).floor_toman == 900_000


async def test_manual_floor_above_cost_is_kept(session):
    v = mkvar(session)
    cost(session, v, 100_000)
    set_floor_rule(session, "global", floor_manual_toman=500_000)
    r = await engine().evaluate(session, v, NOW)
    assert r.floor_toman == 500_000 and r.reason == "manual_floor"


async def test_computed_floor_with_lower_manual_stays_computed(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10, floor_manual_toman=1)
    r = await engine().evaluate(session, v, NOW)
    assert r.floor_toman == math.ceil(600_000 / 0.8) and r.floor_toman >= 600_000


@pytest.mark.parametrize("name,value", [
    ("floor_manual_toman", 0), ("floor_manual_toman", -5), ("floor_manual_pct", 0), ("floor_manual_pct", -1),
    ("floor_manual_pct", MAX_MANUAL_PCT + 1), ("floor_manual_toman", MAX_TOMAN + 1),
])
def test_manual_floor_values_rejected(session, name, value):
    with pytest.raises(ValueError):
        set_floor_rule(session, "global", **{name: value})
    assert session.scalar(select(func.count()).select_from(FloorSetting)) == 0


async def test_legacy_zero_manual_floor_in_db_is_ignored(session):
    v = mkvar(session)
    session.add(FloorSetting(scope="global", scope_key="", floor_manual_toman=0, floor_manual_pct=float("inf")))
    session.flush()
    r = await engine().evaluate(session, v, NOW)                # no cost, manual values unusable
    assert r.status == "needs_cost" and r.floor_toman is None


# =========== 2. fees: single brand, rejected rows, partial sets, sharp drops ===========
def settings(**kw):
    return Settings(**{"digikala_self_token": "tok", "postgres_password": "pw", "page_size": 2, **kw})


def mk_client(handler, s, make_limiter, retries=0):
    lim = make_limiter(requests=1000)
    lim.cfg.max_retries = retries
    return DigikalaClient(s, lim, transport=httpx.MockTransport(handler))


async def test_single_brand_row_marked_assumed_in_floor_result(session):
    v = mkvar(session)
    seed(session, ci(101, 5, "A", 0.10))
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    assert (await engine().evaluate(session, v, NOW)).fee_reason == "fee_assumed_single_brand"


async def test_rejected_rows_counted_logged_and_category_marked_partial(session, make_limiter, caplog):
    s = settings()
    caplog.set_level(logging.WARNING)
    items = [ci(101, 5, "A", 0.03), ci(101, 6, "B", 3.0), ci(102, 7, "C", 0.05)]    # B (highest?) is invalid
    async with mk_client(lambda r: httpx.Response(200, json=commissions_page(items)), s, make_limiter) as c:
        res = await sync_commissions(c, session, s, NOW)
    assert res.rows == 2 and len(res.rejected) == 1 and res.partial_categories == 1
    assert "1 rows rejected" in caplog.text and "1 categories incomplete" in caplog.text
    p = FeeProvider(None, s)
    assert p.lookup(session, "101", None) is None                  # incomplete category: no max over partial rows
    assert p.lookup(session, "102", None).commission_pct == 5.0    # other categories unaffected
    v = mkvar(session)
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    r = await FloorEngine(s, p).evaluate(session, v, NOW, allow_fetch=False)
    assert r.status == "needs_fees" and "invalid" in r.reason
    p.preload(session)                                             # same behaviour with the report's preload
    assert p.lookup(session, "101", None) is None


async def test_failed_second_page_keeps_old_rows_and_never_uses_partial_set(session, make_limiter):
    s = settings()
    seed(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    old = session.scalar(select(func.count()).select_from(Commission))

    def handler(request):
        if request.url.params["page"] == "1":
            return httpx.Response(200, json=commissions_page([ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08)], 1, 2))
        return httpx.Response(500)

    async with mk_client(handler, s, make_limiter) as c:
        with pytest.raises(ApiError):
            await sync_commissions(c, session, s, NOW + timedelta(days=1))
    assert session.scalar(select(func.count()).select_from(Commission)) == old


async def test_sync_refused_when_rows_drop_more_than_30_percent(session, make_limiter):
    s = settings()
    ten = [ci(100 + i, i, f"B{i}", 0.05) for i in range(10)]
    body = {"v": ten}
    s2 = settings(page_size=50)
    async with mk_client(lambda r: httpx.Response(200, json=commissions_page(body["v"])), s2, make_limiter) as c:
        await sync_commissions(c, session, s2, NOW)                     # first sync: nothing to compare with
        body["v"] = ten[:7]                                             # exactly -30%: allowed
        await sync_commissions(c, session, s2, NOW + timedelta(days=1))
        assert session.scalar(select(func.count()).select_from(Commission)) == 7
        body["v"] = ten[:4]                                             # 7 -> 4 = -43%: refused
        with pytest.raises(FeeSyncRefused, match="keeping the old rows"):
            await sync_commissions(c, session, s2, NOW + timedelta(days=2))
        assert session.scalar(select(func.count()).select_from(Commission)) == 7      # old rows kept
        assert session.get(FeeCache, "commissions").fetched_at.replace(tzinfo=timezone.utc) == NOW + timedelta(days=1)
        await sync_commissions(c, session, s2, NOW + timedelta(days=2), force=True)    # explicit override
        assert session.scalar(select(func.count()).select_from(Commission)) == 4


async def test_drop_threshold_is_configurable(session, make_limiter):
    s = settings(fees_max_drop_pct=60, page_size=50)
    ten = [ci(100 + i, i, f"B{i}", 0.05) for i in range(10)]
    body = {"v": ten}
    async with mk_client(lambda r: httpx.Response(200, json=commissions_page(body["v"])), s, make_limiter) as c:
        await sync_commissions(c, session, s, NOW)
        body["v"] = ten[:5]
        await sync_commissions(c, session, s, NOW + timedelta(days=1))          # -50% is fine under a 60% limit
    assert session.scalar(select(func.count()).select_from(Commission)) == 5


# =========== 3. finite numbers, sane bounds, per-variant isolation ===========
NAN, INF = float("nan"), float("inf")


@pytest.mark.parametrize("name", ["margin_pct", "min_profit_toman", "floor_manual_toman", "floor_manual_pct",
                                  "tax_pct", "tax_toman", "ad_share_pct", "packaging_toman", "fulfillment_pct",
                                  "return_reserve_toman"])
@pytest.mark.parametrize("bad", [NAN, INF, -INF, 10**30, True])
def test_set_floor_rule_rejects_non_finite_and_huge(session, name, bad):
    with pytest.raises(ValueError):
        set_floor_rule(session, "global", **{name: bad})
    assert session.scalar(select(func.count()).select_from(FloorSetting)) == 0


def test_set_floor_rule_bounds_edges_ok(session):
    set_floor_rule(session, "global", margin_pct=99.9, min_profit_toman=MAX_TOMAN, floor_manual_pct=MAX_MANUAL_PCT,
                   tax_pct=0, packaging_toman=0)
    with pytest.raises(ValueError):
        set_floor_rule(session, "global", margin_pct=100)
    with pytest.raises(ValueError):
        set_floor_rule(session, "global", tax_pct=100)
    with pytest.raises(ValueError):
        set_floor_rule(session, "x" * 1 if False else "brand", "k" * 300, margin_pct=1)


@pytest.mark.parametrize("flag", [["--manual-pct", "nan"], ["--manual-pct", "inf"], ["--min-profit", "99999999999999999999999"],
                                  ["--margin-pct", "nan"], ["--tax-pct", "-1"], ["--manual-toman", "0"]])
def test_cli_set_floor_rejects_bad_numbers(monkeypatch, tmp_path, capsys, flag):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 't.db'}")
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    assert cli.main(["set-floor", "--scope", "global", *flag]) == 2
    assert "Invalid options" in capsys.readouterr().out


@pytest.mark.parametrize("v", ["nan", "inf", "-1", "0", "1e13", "99999999999999999999", "abc", "", True])
def test_import_cost_bounds(v):
    with pytest.raises(ValueError):
        parse_cost(v)
    assert parse_cost("1,000,000,000,000") == 10**12


def test_compute_floor_guards_non_finite_inputs():
    assert compute_floor(NAN, 10, Components(), 10, None) == (None, "invalid_input")
    assert compute_floor(100, INF, Components(), 10, None) == (None, "invalid_input")
    assert compute_floor(100, 10, Components(), NAN, None) == (None, "invalid_input")
    assert compute_floor(100, 10, Components(pct={"tax": NAN}), 10, None) == (None, "invalid_input")


async def test_corrupt_rule_in_db_cannot_crash_evaluate(session, monkeypatch):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10))
    cost(session, v, 600_000)
    from types import SimpleNamespace
    bad = SimpleNamespace(scope="global", margin_pct=NAN, min_profit_toman=5, floor_manual_toman=None,
                          floor_manual_pct=None)                 # SQLite would turn NaN into NULL, so inject it
    monkeypatch.setattr("sudyar.floor.resolve_setting", lambda *a, **k: bad)
    r = await engine().evaluate(session, v, NOW)
    assert r.status == "impossible" and r.floor_toman is None


async def test_floor_report_survives_a_bad_variant(session, monkeypatch, caplog):
    seed(session, ci(101, None, None, 0.10))
    set_floor_rule(session, "global", margin_pct=10)
    for vid in ("good1", "bad", "good2"):
        v = mkvar(session, vid=vid, pid=f"p{vid}")
        cost(session, v, 100_000)
    eng = engine()
    real = eng.evaluate

    async def flaky(session_, variant, now, allow_fetch=True):
        if variant.digikala_variant_id == "bad":
            raise OverflowError("cannot convert float infinity to integer")
        return await real(session_, variant, now, allow_fetch)

    eng.evaluate = flaky
    rep = await build_report(session, eng, NOW)
    assert rep.checked == 3 and rep.errors == 1 and rep.status_counts == {"ok": 2, "error": 1}
    text = format_report(rep)
    assert "error: 1 variants could not be evaluated" in text and "cannot convert" not in text + caplog.text


@pytest.mark.parametrize("args", [["--top", "0"], ["--top", "5000"], ["--top", "-3"]])
def test_floor_report_top_bounds(monkeypatch, tmp_path, capsys, args):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 't.db'}")
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    assert cli.main(["floor-report", *args]) == 2
    assert "--top must be between 1 and 1000" in capsys.readouterr().out


# =========== 4. stale commissions -> needs_fees ===========
async def test_stale_commissions_make_floors_needs_fees(session):
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10), at=NOW)
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    eng = engine()
    assert (await eng.evaluate(session, v, NOW + timedelta(days=2, hours=23), allow_fetch=False)).status == "ok"
    r = await eng.evaluate(session, v, NOW + timedelta(days=3, hours=1), allow_fetch=False)
    assert r.status == "needs_fees" and "older than 3 days" in r.reason and r.floor_toman is None
    assert (await engine(fees_max_stale_days=10).evaluate(session, v, NOW + timedelta(days=5), allow_fetch=False)).status == "ok"


async def test_failing_refresh_for_days_ends_in_needs_fees_and_recovery(session, make_limiter):
    s = settings()
    v = mkvar(session)
    seed(session, ci(101, None, None, 0.10), at=NOW)
    cost(session, v, 600_000)
    set_floor_rule(session, "global", margin_pct=10)
    mode = {"fail": True}

    def handler(request):
        return httpx.Response(500) if mode["fail"] else httpx.Response(200, json=commissions_page([ci(101, None, None, 0.12)]))

    async with mk_client(handler, s, make_limiter) as c:
        eng = FloorEngine(s, FeeProvider(c, s))
        assert (await eng.evaluate(session, v, NOW + timedelta(days=2))).status == "ok"          # refresh fails, still < 3 days
        r = await eng.evaluate(session, v, NOW + timedelta(days=4))                              # failing for 4 days
        assert r.status == "needs_fees" and "older than" in r.reason
        mode["fail"] = False
        r = await eng.evaluate(session, v, NOW + timedelta(days=6))                              # retry throttle (1h) passed
        assert r.status == "ok" and r.commission_pct == 12.0


# =========== 5. base URL / path validation ===========
@pytest.mark.parametrize("url", ["http://seller.digikala.com", "ftp://x.com", "seller.digikala.com", "https://",
                                 "https://user:pw@seller.digikala.com", "https://seller.digikala.com/?a=1",
                                 "https://seller.digikala.com/#x", ""])
def test_base_url_must_be_clean_https(url):
    with pytest.raises(ValueError):
        Settings(base_url=url)


def test_base_url_https_ok_and_normalised():
    assert Settings(base_url="https://seller.digikala.com/").base_url == "https://seller.digikala.com"


@pytest.mark.parametrize("field", PATH_FIELDS)
@pytest.mark.parametrize("path", ["open-api/v1/x", "//evil.com/x", "http://evil.com/x", "https://seller.digikala.com/x",
                                  "/a/../b", "/a?b=1", "/a#b", "/a b", "\\evil", ""])
def test_endpoint_paths_must_start_with_single_slash(field, path):
    if field == "variants_path" and path == "":
        Settings(variants_path="")                                    # empty is reported by problems(), not an error
        return
    with pytest.raises(ValueError):
        Settings(**{field: path})


def test_default_paths_are_valid():
    s = Settings()
    assert all(getattr(s, f).startswith("/") for f in PATH_FIELDS)


def test_invalid_env_gives_config_error_without_echoing_values(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_BASE_URL", "http://leak-me.example/secret-path")
    with pytest.raises(ConfigError) as e:
        load_settings()
    assert "DIGIKALA_BASE_URL" in str(e.value) and "https" in str(e.value)
    assert "leak-me" not in str(e.value) and "secret-path" not in str(e.value)


@pytest.mark.parametrize("name,value", [("RADAR_BUDGET_FRACTION", "nan"), ("RADAR_BUDGET_FRACTION", "0"),
                                        ("PAGE_SIZE_X", "1"), ("RATE_LIMIT_REQUESTS", "0"), ("MAX_CONCURRENT", "9999"),
                                        ("FEES_MAX_DROP_PCT", "150"), ("RADAR_HOT_INTERVAL_SECONDS", "inf")])
def test_numeric_env_values_are_bounded(monkeypatch, tmp_path, name, value):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(name, value)
    if name == "PAGE_SIZE_X":
        load_settings()                                               # unknown names are simply ignored
        return
    with pytest.raises(ConfigError):
        load_settings()


def test_cli_reports_invalid_config_and_exits(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_BASE_URL", "http://x.example")
    assert cli.main(["check-config"]) == 1
    assert "Invalid configuration" in capsys.readouterr().out


async def test_client_refuses_paths_without_leading_slash(make_limiter):
    s = Settings(digikala_self_token="t")
    async with DigikalaClient(s, make_limiter(), transport=httpx.MockTransport(lambda r: pytest.fail("no call"))) as c:
        for bad in ("variants", "https://evil.com/x", "//evil.com/x"):
            with pytest.raises(ValueError):
                await c.get(bad)


# =========== 6. error output: type + short code only ===========
SECRET = "SECRET-PARAM-VALUE-12345"


def test_error_codes():
    assert error_code(ApiError("GET /x failed with status 403")) == "HTTP-403"
    assert error_code(ApiError("Request failed after 6 attempts (last status: None)")) == "API"
    assert error_code(OperationalError("SELECT 1", {"p": SECRET}, Exception("boom"))) == "DB"
    assert error_code(httpx.ConnectError("x")) == "NET"
    assert error_code(ConfigError("x")) == "CONFIG"
    assert error_code(ValueError("x")) == "VALUE"
    assert error_code(RuntimeError("x")) == "ERR"


def test_short_error_hides_message_and_logs_redacted_details_at_debug(monkeypatch, caplog):
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok-very-secret-1")
    err = OperationalError("INSERT ...", {"title": SECRET, "t": "tok-very-secret-1"}, Exception("db down"))
    caplog.set_level(logging.DEBUG)
    out = short_error(err)
    assert "OperationalError" in out and "code DB" in out and SECRET not in out
    assert "error details" in caplog.text and "tok-very-secret-1" not in caplog.text and "***" in caplog.text
    caplog.clear()
    caplog.set_level(logging.INFO)
    short_error(err)
    assert caplog.text == ""                                          # details only at DEBUG level


def test_redact_removes_secrets_and_url_credentials(monkeypatch):
    monkeypatch.setenv("BALE_BOT_TOKEN", "bale-token-abcdef")
    assert "bale-token-abcdef" not in redact("url https://api/botbale-token-abcdef/x")
    assert "pw123" not in redact("postgresql://user:pw123@db/x") and "***@db" in redact("postgresql://user:pw123@db/x")


def test_command_failure_prints_no_message(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")

    def boom():
        raise RuntimeError(f"leaky {SECRET}")

    monkeypatch.setattr(cli, "run_sync", boom)
    assert cli.main(["sync-variants"]) == 1
    out = capsys.readouterr().out
    assert "RuntimeError (code ERR" in out and SECRET not in out


def test_api_hint_keeps_scope_help_without_raw_message():
    msg = cli._api_hint(ApiError("GET /open-api/v1/commissions/ failed with status 403"))
    assert "code HTTP-403" in msg and "scopes" in msg and "/open-api" not in msg


def test_radar_cycle_failure_line_has_no_message(monkeypatch, capsys):
    from sudyar.__main__ import radar_run

    class Boom:
        async def run_cycle(self):
            raise RuntimeError(f"leaky {SECRET}")

    class Cli:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False

    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "t")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("RADAR_HOT_INTERVAL_SECONDS", "1")
    monkeypatch.setattr(cli, "_radar", lambda s: (Cli(), Boom()))

    async def stop(_):  # end the loop after the first cycle
        raise KeyboardInterrupt

    monkeypatch.setattr(cli.asyncio, "sleep", stop)
    radar_run()
    out = capsys.readouterr().out
    assert "cycle failed: RuntimeError (code ERR" in out and SECRET not in out


# =========== 7. documented read-only scopes ===========
def test_check_config_lists_scopes(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    assert cli.main(["check-config"]) == 0
    out = capsys.readouterr().out
    for scope in ("variants", "pricing/buybox", "commissions", "insight"):
        assert f"- {scope}:" in out
    assert "READ-ONLY" in out and "no write scope is needed" in out


def test_readme_lists_scopes():
    text = (ROOT / "README_FA.md").read_text()
    for scope in ("variants", "pricing/buybox", "commissions", "insight"):
        assert scope in text
    assert "Self Token" in text and "فقط خواندن" in text


# =========== 8. batch file quoting ===========
def test_bat_quotes_the_file_name():
    text = (ROOT / "4-import-costs.bat").read_text()
    assert text.count('"/data/%F%"') == 2
    assert "/data/%F%" not in text.replace('"/data/%F%"', "")


# =========== 9. Bale allow-list ===========
def test_check_bale_base():
    assert check_bale_base("https://tapi.bale.ai", "tapi.bale.ai") is None
    assert check_bale_base("https://TAPI.bale.ai/", "tapi.bale.ai") is None
    assert "not in BALE_ALLOWED_HOSTS" in check_bale_base("https://evil.example", "tapi.bale.ai")
    assert "https" in check_bale_base("http://tapi.bale.ai", "tapi.bale.ai")
    assert check_bale_base("https://user:pw@tapi.bale.ai", "tapi.bale.ai")
    assert check_bale_base("https://evil.example", "tapi.bale.ai,evil.example") is None
    assert check_bale_base("", "tapi.bale.ai")


def bale_settings(base, **kw):
    return Settings(notify_enabled=True, notify_channels="bale", bale_bot_token="BT-123456", bale_chat_id="42",
                    bale_api_base=base, **kw)


def test_notifier_never_built_for_unlisted_bale_host():
    assert "bale" not in build_notifiers(bale_settings("https://evil.example"))
    assert "bale" not in build_notifiers(bale_settings("http://tapi.bale.ai"))
    assert "bale" in build_notifiers(bale_settings("https://tapi.bale.ai"))
    assert "bale" in build_notifiers(bale_settings("https://evil.example", bale_allowed_hosts="evil.example"))


def test_notify_problems_reports_unlisted_bale_host():
    probs = bale_settings("https://evil.example").notify_problems()
    assert any("BALE_ALLOWED_HOSTS" in p for p in probs) and "BT-123456" not in " ".join(probs)
    assert bale_settings("https://tapi.bale.ai").notify_problems() == []


# =========== 10. .env permission warning ===========
@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_env_file_permission_warning(tmp_path, monkeypatch, capsys):
    f = tmp_path / ".env"
    f.write_text("DIGIKALA_SELF_TOKEN=x\n")
    f.chmod(0o644)
    assert "readable by other users" in cli.env_file_warning(str(f)) and "chmod 600" in cli.env_file_warning(str(f))
    f.chmod(0o640)
    assert cli.env_file_warning(str(f)) is not None
    f.chmod(0o600)
    assert cli.env_file_warning(str(f)) is None
    assert cli.env_file_warning(str(tmp_path / "missing")) is None
    f.chmod(0o666)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "x")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    cli.main(["check-config"])
    out = capsys.readouterr().out
    assert "WARNING: .env is readable by other users" in out and "DIGIKALA_SELF_TOKEN=x" not in out
