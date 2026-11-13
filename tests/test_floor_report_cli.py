import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from shapes import commission_item as ci, commissions_page, sales_item as si, sales_page
from sudyar import __main__ as cli
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import FeeProvider, parse_commission_row
from sudyar.floor import FloorEngine, set_floor_rule
from sudyar.floor_report import build_report, format_report
from sudyar.models import Base, Commission, FeeCache, ProductSales, Variant, VariantCost
from sudyar.rate_limiter import LimiterConfig, RateLimiter

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parent.parent


def mk(session, vid, price_rial, pid, bb_rial=None, win=None, stock=5, cost=None, active=True, category="101"):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=pid, price_sale=price_rial,
                buy_box_price=bb_rial, is_seller_buy_box_winner=win, stock=stock, active=active, title=f"title {vid}",
                raw_json={"category_id": category, "supplier_code": f"SC-{vid}"})
    session.add(v)
    session.flush()
    if cost is not None:
        session.add(VariantCost(variant_id=v.id, buy_cost=cost, source="excel", updated_at=NOW))
    session.flush()
    return v


def seed_fees(session, *items, at=NOW):
    for it in items:
        row, _ = parse_commission_row(it)
        session.add(Commission(fetched_at=at, **row))
    session.add(FeeCache(key="commissions", data={}, fetched_at=at))
    session.flush()


def sell(session, pid, sold, amount=1_000_000, range_="last_30_days"):
    session.add(ProductSales(product_id=str(pid), range=range_, net_item_sold=sold, net_sales_amount=amount,
                             fetched_at=NOW))
    session.flush()


def seed_scenario(session):
    seed_fees(session, ci(101, 5, "A", 0.10))
    set_floor_rule(session, "global", margin_pct=10)
    # price 10_000 rial = 1000 toman; commission 10% -> profit = 900 - cost
    mk(session, "loss", 10_000, "p1", cost=1000, win=True)       # -100
    mk(session, "zero", 10_000, "p2", cost=900, win=True)        # 0
    mk(session, "fine", 10_000, "p3", cost=500, win=True)        # +400
    mk(session, "nosales", 10_000, "p4", cost=2000, win=True)    # negative, but no sales row
    mk(session, "soldzero", 10_000, "p5", cost=2000, win=True)   # negative, sold 0
    mk(session, "inactive", 10_000, "p6", cost=2000, active=False)
    mk(session, "lose", 10_000, "p7", bb_rial=7_000, win=False, cost=600)       # floor 750 > win 700 toman
    mk(session, "lose_ok", 10_000, "p8", bb_rial=9_000, win=False, cost=600)     # win 900 >= 750
    mk(session, "nocost", 10_000, "p9", win=True)
    for pid, n in (("p1", 50), ("p2", 80), ("p3", 100), ("p5", 0), ("p6", 70)):
        sell(session, pid, n)


async def test_report_ranks_selling_low_profit_by_units(session):
    s = Settings()
    seed_scenario(session)
    rep = await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW, top=10)
    assert [(v.digikala_variant_id, sold) for v, sold, _, _ in rep.sells_low_profit] == [("zero", 80), ("loss", 50)]
    assert rep.low_profit_total == 4                              # loss, zero, nosales, soldzero (inactive excluded)
    assert [v.digikala_variant_id for v, *_ in rep.below_floor] == ["lose"]
    assert rep.status_counts["needs_cost"] == 1 and rep.status_counts["ok"] == 7
    assert rep.sales_rows == 5


async def test_report_text_lists_included_and_unset_components(session):
    s = Settings()
    seed_scenario(session)
    set_floor_rule(session, "global", ad_share_pct=2, packaging_toman=10)
    text = format_report(await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW))
    assert "included: commission from Digikala (the `commission` field only)" in text
    assert "included (manual): ad share - set for 8 of 8" in text and "included (manual): packaging" in text
    assert "NOT included (unset, counted as 0" in text and "tax (8 variants)" in text and "fulfillment/processing" in text
    assert "UNCONFIRMED" in text and "extra_commission: not included" in text
    assert "SELLING (net_item_sold > 0, last_30_days)" in text and "zero" in text
    assert "Suggestions only" in text and "all floor math in Toman" in text


async def test_report_flags_when_extra_commissions_are_included(session):
    s = Settings(floor_include_extra_commission=True)
    seed_scenario(session)
    text = format_report(await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW))
    assert "extra_commission: INCLUDED" in text and "return_free_commission: not included" in text


async def test_report_without_sales_says_so(session):
    s = Settings()
    seed_fees(session, ci(101, 5, "A", 0.10))
    set_floor_rule(session, "global", margin_pct=10)
    mk(session, "x", 10_000, "p1", cost=5000, win=True)
    rep = await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW)
    text = format_report(rep)
    assert rep.sells_low_profit == [] and rep.low_profit_total == 1
    assert "no sales data yet: run sales-sync" in text and "NEVER (run sales-sync)" in text


async def test_report_notes_assumed_max_brand_and_missing_fees(session):
    s = Settings()
    seed_fees(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    set_floor_rule(session, "global", margin_pct=10)
    mk(session, "x", 10_000, "p1", cost=500, win=True)
    text = format_report(await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW))
    assert "1 variants use the HIGHEST brand commission" in text and "fee_assumed_max_brand" in text
    session.query(Commission).delete()
    session.query(FeeCache).delete()
    session.flush()
    rep = await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW)
    assert rep.status_counts == {"needs_fees": 1} and "NEVER (run sync-fees)" in format_report(rep)


async def test_report_refuses_to_compare_without_unit(session):
    s = Settings(price_unit="unknown")
    seed_scenario(session)
    rep = await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW)
    assert rep.sells_low_profit == [] and rep.below_floor == [] and rep.low_profit_total == 0


async def test_report_top_limit(session):
    s = Settings()
    seed_fees(session, ci(101, 5, "A", 0.10))
    set_floor_rule(session, "global", margin_pct=10)
    for i in range(5):
        mk(session, f"v{i}", 10_000, f"p{i}", cost=5000 + i, win=True)
        sell(session, f"p{i}", 10 + i)
    rep = await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW, top=3)
    assert [sold for _, sold, _, _ in rep.sells_low_profit] == [14, 13, 12]


# ---------- CLI ----------
@pytest.fixture
def cli_env(monkeypatch, tmp_path):
    db = tmp_path / "t.db"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok-secret-123")
    eng = create_engine(f"sqlite:///{db}")
    Base.metadata.create_all(eng)
    return sessionmaker(eng)


def patch_client(monkeypatch, handler, retries=0):
    """Make the CLI use a mocked transport instead of the network."""
    def fake_build(s, radar=False):
        from sudyar.db import make_engine, make_session_factory
        lim = RateLimiter(LimiterConfig(requests=1000, max_retries=retries, backoff_base=0.0, backoff_max=0.0))
        return make_session_factory(make_engine(s.database_url)), DigikalaClient(s, lim, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(cli, "_build", fake_build)


def test_cli_sync_fees_and_sales_sync(cli_env, capsys, monkeypatch):
    def handler(request):
        if request.url.path.endswith("/commissions/"):
            return httpx.Response(200, json=commissions_page([ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08)]))
        return httpx.Response(200, json=sales_page([si(1, 5), si(2, 7)]))

    patch_client(monkeypatch, handler)
    assert cli.main(["sync-fees"]) == 0 and "Commissions saved: 2 rows" in capsys.readouterr().out
    assert cli.main(["sales-sync", "--range", "last_14_days"]) == 0
    assert "Sales saved for last_14_days: 2 products" in capsys.readouterr().out
    assert cli.main(["sales-sync", "--range", "last_14_days"]) == 0
    assert "less than 24 h ago" in capsys.readouterr().out
    assert cli.main(["sales-sync", "--range", "last_14_days", "--force"]) == 0
    assert cli.main(["sales-sync", "--range", "last_99_days"]) == 2
    assert "Invalid options" in capsys.readouterr().out
    with cli_env() as s:
        assert s.scalar(select(func.count()).select_from(Commission)) == 2


def test_cli_scope_error_is_explained_without_secrets(cli_env, capsys, monkeypatch):
    patch_client(monkeypatch, lambda r: httpx.Response(403))
    assert cli.main(["sync-fees"]) == 1
    out = capsys.readouterr().out
    assert "scope" in out and "commission" in out and "tok-secret-123" not in out
    assert cli.main(["sales-sync"]) == 1
    assert "insight" in capsys.readouterr().out


def test_cli_full_flow_set_floor_brand_import_report(cli_env, capsys, monkeypatch, tmp_path):
    with cli_env() as s:
        seed_fees(s, ci(101, 5, "Bosch", 0.03), ci(101, 6, "Mann", 0.08), at=datetime.now(timezone.utc))
        mk(s, "1", 10_000, "p1", bb_rial=7_000, win=False)
        sell(s, "p1", 12)
        s.commit()
    assert cli.main(["list-brands", "101"]) == 0
    out = capsys.readouterr().out
    assert "brand_id=6  Mann  commission=8.0%" in out
    assert cli.main(["set-brand", "--variant", "1", "--brand-id", "999"]) == 2
    assert cli.main(["set-brand", "--variant", "1", "--brand-id", "5"]) == 0
    assert cli.main(["set-floor", "--scope", "global", "--margin-pct", "10", "--tax-pct", "9",
                     "--packaging-toman", "100", "--ad-share-pct", "2"]) == 0
    assert "tax_pct" in capsys.readouterr().out
    f = tmp_path / "c.csv"
    f.write_text("sku,buy_cost\nSC-1,600\nSC-404,5\n")             # SKU = supplier_code
    assert cli.main(["import-costs", str(f), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "DRY-RUN" in out and "rejected row 3" in out
    assert cli.main(["import-costs", str(f)]) == 0
    assert cli.main(["import-costs", str(f)]) == 0
    assert "unchanged: 1" in capsys.readouterr().out
    assert cli.main(["floor-report", "--top", "5"]) == 0
    out = capsys.readouterr().out
    assert "ok: 1" in out and "set for 1 of 1" in out and "return reserve" in out and "tok-secret-123" not in out
    assert "win 700 < floor" in out                                # floor ~ (600+100)/(1-.03-.09-.02-.10)


def test_cli_set_floor_validation(cli_env, capsys):
    assert cli.main(["set-floor", "--scope", "brand", "--margin-pct", "5"]) == 2
    assert "Invalid options" in capsys.readouterr().out
    assert cli.main(["set-floor", "--margin-pct", "abc"]) == 2
    assert cli.main(["set-floor", "--tax-pct", "120"]) == 2


def test_cli_import_errors(cli_env, capsys):
    assert cli.main(["import-costs", "missing.csv"]) == 1
    assert "File not found" in capsys.readouterr().out
    assert cli.main(["import-costs"]) == 2


def test_cli_healthcheck(cli_env, capsys, monkeypatch):
    assert cli.main(["healthcheck"]) == 0 and "healthy" in capsys.readouterr().out
    monkeypatch.setenv("DATABASE_URL", "sqlite:////nonexistent_dir_xyz/db.sqlite")
    assert cli.main(["healthcheck"]) == 1
    out = capsys.readouterr().out
    assert "unhealthy" in out and "tok-secret-123" not in out


def test_check_config_notes(monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    assert cli.main(["check-config"]) == 0
    assert "DIGIKALA_PRICE_UNIT is not set" not in capsys.readouterr().out      # default is rial now
    monkeypatch.setenv("DIGIKALA_PRICE_UNIT", "unknown")
    assert cli.main(["check-config"]) == 0
    assert "DIGIKALA_PRICE_UNIT is not set" in capsys.readouterr().out
    monkeypatch.setenv("DIGIKALA_PRICE_UNIT", "bogus")                     # not a valid unit: refused outright
    assert cli.main(["check-config"]) == 1
    assert "DIGIKALA_PRICE_UNIT" in capsys.readouterr().out


def test_config_defaults_and_env(monkeypatch, tmp_path):
    from sudyar.config import load_settings
    monkeypatch.chdir(tmp_path)
    s = Settings()
    assert s.price_unit == "rial" and s.suggested_price_unit == "rial"
    assert s.cost_sku_field == "supplier_code" and s.floor_category_field == "category_id"
    assert s.commissions_path == "/open-api/v1/commissions/" and s.sales_reports_path == "/open-api/v1/insight/sales-reports"
    assert s.floor_include_extra_commission is False and s.floor_include_return_free_commission is False
    assert not hasattr(s, "floor_brand_field")                       # no automatic brand matching
    monkeypatch.setenv("FLOOR_INCLUDE_EXTRA_COMMISSION", "true")
    monkeypatch.setenv("DIGIKALA_PRICE_UNIT", " Toman ")
    s = load_settings()
    assert s.floor_include_extra_commission is True and s.price_unit == "toman"


# ---------- read-only guarantee ----------
def test_no_write_http_methods_anywhere_toward_digikala():
    """Only notifier.py may POST (Telegram/Bale). Nothing else may even mention a write method call."""
    for f in (ROOT / "src" / "sudyar").glob("*.py"):
        text = f.read_text()
        if f.name in ("notifier.py", "digikala_client.py"):
            continue
        assert not re.search(r"\.(post|put|patch|delete)\(", text), f.name


def test_client_has_no_call_to_a_price_calculator():
    text = (ROOT / "src" / "sudyar" / "digikala_client.py").read_text() + (ROOT / "src" / "sudyar" / "fees.py").read_text()
    assert "calculator" not in text.lower()                          # not in the Swagger: never called
