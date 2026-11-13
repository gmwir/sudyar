import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from sudyar import __main__ as cli
from sudyar.floor import FeeProvider, Fees, FloorEngine, set_floor_rule
from sudyar.floor_report import build_report, format_report
from sudyar.config import Settings
from sudyar.models import Base, FeeCache, FloorSetting, Variant, VariantCost

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parent.parent


def mk(session, vid, price, bb=None, win=None, stock=5, cost=None, active=True, fees=10):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", price_sale=price, buy_box_price=bb,
                is_seller_buy_box_winner=win, stock=stock, active=active, raw_json={}, title=f"title {vid}")
    session.add(v)
    session.flush()
    if cost is not None:
        session.add(VariantCost(variant_id=v.id, buy_cost=cost, source="excel", updated_at=NOW))
    if fees is not None:
        session.add(FeeCache(key=f"pv{vid}", data=Fees(commission_pct=fees).to_dict(), fetched_at=NOW))
    session.flush()
    return v


async def test_report_lists_low_profit_and_below_floor(session):
    s = Settings(price_unit="toman")
    set_floor_rule(session, "global", margin_pct=10)
    mk(session, "loss", 1000, cost=1000, win=True)             # profit = 900-1000 = -100
    mk(session, "zero", 1000, cost=900, win=True)               # profit = 0
    mk(session, "fine", 1000, cost=500, win=True)               # profit 400
    mk(session, "nostock", 1000, cost=2000, stock=0, win=True)  # excluded: not in stock
    mk(session, "inactive", 1000, cost=2000, active=False)
    mk(session, "lose", 1000, bb=700, win=False, cost=600)      # floor = 750 > win 700
    mk(session, "lose_ok", 1000, bb=900, win=False, cost=600)   # floor 750 <= 900
    mk(session, "nocost", 1000, win=True)
    rep = await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW, top=10)
    assert [v.digikala_variant_id for v, _ in rep.low_profit] == ["loss", "zero"]
    assert [v.digikala_variant_id for v, *_ in rep.below_floor] == ["lose"]
    assert rep.status_counts["needs_cost"] == 1 and rep.status_counts["ok"] == 6
    text = format_report(rep)
    assert "loss" in text and "Suggestions only" in text and "sales data not available" in text


async def test_report_top_limit_and_unit_unknown(session):
    set_floor_rule(session, "global", margin_pct=10)
    for i in range(5):
        mk(session, f"v{i}", 1000, cost=2000 + i)
    s = Settings(price_unit="toman")
    assert len((await build_report(session, FloorEngine(s, FeeProvider(None, s)), NOW, top=3)).low_profit) == 3
    s2 = Settings(price_unit="unknown")
    rep = await build_report(session, FloorEngine(s2, FeeProvider(None, s2)), NOW)
    assert rep.low_profit == [] and rep.below_floor == []      # refuses to compare without a unit


# ---------- CLI ----------
@pytest.fixture
def cli_env(monkeypatch, tmp_path):
    db = tmp_path / "t.db"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok-secret-123")
    monkeypatch.setenv("DIGIKALA_PRICE_UNIT", "toman")
    eng = create_engine(f"sqlite:///{db}")
    Base.metadata.create_all(eng)
    return sessionmaker(eng)


def test_cli_set_floor_import_and_report(cli_env, capsys, tmp_path):
    with cli_env() as s:
        mk(s, "1", 1000, bb=700, win=False, cost=None)
        s.commit()
    assert cli.main(["set-floor", "--scope", "global", "--margin-pct", "10"]) == 0
    assert "Saved rule global/-" in capsys.readouterr().out
    f = tmp_path / "c.csv"
    f.write_text("variant_id,buy_cost\n1,600\n9,5\n")
    assert cli.main(["import-costs", str(f), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "DRY-RUN" in out and "rejected row 3" in out
    with cli_env() as s:
        assert s.scalar(select(VariantCost)) is None
    assert cli.main(["import-costs", str(f)]) == 0
    assert "New: 1" in capsys.readouterr().out
    assert cli.main(["import-costs", str(f)]) == 0
    assert "unchanged: 1" in capsys.readouterr().out
    assert cli.main(["floor-report", "--top", "5"]) == 0
    out = capsys.readouterr().out
    assert "needs_fees: 1" in out and "tok-secret-123" not in out    # no fees cached/configured -> honest status


def test_cli_set_floor_validation(cli_env, capsys):
    assert cli.main(["set-floor", "--scope", "brand", "--margin-pct", "5"]) == 2
    assert "Invalid options" in capsys.readouterr().out
    assert cli.main(["set-floor", "--margin-pct", "abc"]) == 2


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


def test_check_config_notes_for_part3(monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    assert cli.main(["check-config"]) == 0
    out = capsys.readouterr().out
    assert "DIGIKALA_PRICE_UNIT is not set" in out and "FEES_*" in out


def test_config_part3_defaults_and_env(monkeypatch, tmp_path):
    from sudyar.config import load_settings
    monkeypatch.chdir(tmp_path)
    s = Settings()
    assert s.price_unit == "unknown" and s.suggested_price_unit == "rial"
    assert (s.cost_ad_share_pct, s.cost_return_reserve_pct, s.cost_packaging_toman) == (0, 0, 0)
    monkeypatch.setenv("DIGIKALA_PRICE_UNIT", " Rial ")
    monkeypatch.setenv("FEES_FIELD_MAP", json.dumps({"commission_pct": "commissions:data.c"}))
    monkeypatch.setenv("COST_AD_SHARE_PCT", "2.5")
    s = load_settings()
    assert s.price_unit == "rial" and s.fees_field_map["commission_pct"] == "commissions:data.c"
    assert s.cost_ad_share_pct == 2.5


# ---------- read-only guarantee ----------
def test_no_write_http_methods_anywhere_toward_digikala():
    """Only notifier.py may POST (Telegram/Bale). Nothing else may even mention a write method call."""
    for f in (ROOT / "src" / "sudyar").glob("*.py"):
        text = f.read_text()
        if f.name in ("notifier.py", "digikala_client.py"):
            continue
        assert not re.search(r"\.(post|put|patch|delete)\(", text), f.name
