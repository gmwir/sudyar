import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import create_engine, func, pool, select
from sqlalchemy.orm import sessionmaker

from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from shapes import commission_item as ci
from sudyar.fees import FeeProvider, parse_commission_row
from sudyar.floor import FloorEngine, set_floor_rule
from sudyar.models import Base, Commission, FeeCache, FloorEvent, RadarEvent, Variant, VariantCost
from sudyar.notifier import Dispatcher, render_message
from sudyar.radar import Radar
from test_radar import FakeApi, item

T0 = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parent.parent


def citem(i, **kw):
    d = item(i, **kw)
    d["category_id"] = 101                       # variant list items carry category_id (and supplier_code)
    return d


def build(make_limiter, items, **settings_kw):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=pool.StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    s = Settings(digikala_self_token="tok", postgres_password="pw", page_size=2, **settings_kw)   # rial by default
    api = FakeApi(items)
    client = DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(api.handler))
    radar = Radar(client, factory, s, Dispatcher(s, {}, emit=lambda m: None), FloorEngine(s, FeeProvider(client, s)))
    return api, radar, factory


def prepare(factory, cost=None, brands=((5, "A", 0.10),)):
    with factory() as ses:
        v = ses.scalar(select(Variant))
        if cost is not None:
            ses.add(VariantCost(variant_id=v.id, buy_cost=cost, source="excel", updated_at=T0))
        for bid, title, c in brands:
            row, _ = parse_commission_row(ci(101, bid, title, c))
            ses.add(Commission(fetched_at=T0 + timedelta(hours=1), **row))
        ses.add(FeeCache(key="commissions", data={}, fetched_at=T0 + timedelta(hours=1)))     # fresh: no API call
        ses.commit()
        set_floor_rule(ses, "global", margin_pct=10)


async def lose(radar, api, **kw):
    await radar.run_cycle(T0)
    api.items[0] = citem(1, win=False, price=1100, bb=1000, **kw)
    return await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))


async def test_loss_labeled_would_need_below_floor(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=600)                 # floor = ceil(600/0.8) = 750 toman
    api.items[0] = citem(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))   # suggested 950 RIAL = 95 toman
    f = next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]
    assert f["floor_toman"] == 750 and f["label"] == "would_need_below_floor" and f["win_price_toman"] == 95
    assert f["fee_reason"] == "fee_assumed_single_brand" and f["commission_pct"] == 10.0


async def test_loss_labeled_can_win_when_suggestion_high(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=60)                  # floor = 75 toman
    api.items[0] = citem(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))   # 95 toman >= 75
    f = next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]
    assert f["label"] == "can_win_above_floor" and f["floor_toman"] == math.ceil(60 / 0.8)
    with factory() as ses:
        assert ses.scalar(select(func.count()).select_from(FloorEvent)) == 1


async def test_loss_with_several_brands_uses_highest_commission(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=600, brands=((5, "A", 0.03), (6, "B", 0.10)))
    api.items[0] = citem(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))
    f = next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]
    assert f["fee_reason"] == "fee_assumed_max_brand" and f["floor_toman"] == 750


async def test_loss_labeled_needs_cost_and_stays_read_only(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=None)
    api.items[0] = citem(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))
    f = next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]
    assert f["label"] == "needs_cost" and f["floor_toman"] is None
    assert api.requests and all(r.method == "GET" for r in api.requests)


async def test_loss_without_synced_commissions_says_needs_fees(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    await radar.run_cycle(T0)
    with factory() as ses:
        v = ses.scalar(select(Variant))
        ses.add(VariantCost(variant_id=v.id, buy_cost=600, source="excel", updated_at=T0))
        ses.commit()
        set_floor_rule(ses, "global", margin_pct=10)
    api.items[0] = citem(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))
    assert next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]["label"] == "needs_fees"
    assert any(r.url.path == "/open-api/v1/commissions/" and r.method == "GET" for r in api.requests)  # tried to sync (GET)


async def test_radar_without_floor_engine_still_works(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    radar.floor_engine = None
    res = await lose(radar, api)
    assert "floor" not in next(e for e in res.events if e.type == "BUYBOX_LOST").details


async def test_floor_failure_never_breaks_cycle(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])

    class Boom:
        async def assess_loss(self, *a, **k):
            raise RuntimeError("secret-ish detail")

    radar.floor_engine = Boom()
    res = await lose(radar, api)
    assert next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"] is None


async def test_event_records_price_units_for_messages(make_limiter):
    api, radar, factory = build(make_limiter, [citem(1)])
    res = await lose(radar, api)
    d = next(e for e in res.events if e.type == "BUYBOX_LOST").details
    assert d["price_unit"] == "rial" and d["suggested_price_unit"] == "rial"


def _event(details):
    return RadarEvent(variant_id=1, type="BUYBOX_LOST", old_value="True", new_value="False", dedupe_key="k",
                      details={"title": "روغن", "our_price": 1100, "buy_box_price": 1000, "gap_pct": 10.0,
                               "gap_abs": 100, "suggested_price": 950, "cause": "price_above", **details})


@pytest.mark.parametrize("label,fa", [
    ("can_win_above_floor", "می‌توان بالاتر از کف قیمت برنده شد"),
    ("would_need_below_floor", "برای برنده شدن باید پایین‌تر از کف قیمت رفت"),
    ("needs_cost", "قیمت خرید ثبت نشده"),
])
def test_notifier_persian_floor_text(label, fa):
    msg = render_message(_event({"floor": {"label": label, "floor_toman": 750, "win_price_toman": 95.0}}))
    assert fa in msg and "کف قیمت: 750 تومان" in msg and "فقط پیشنهاد است" in msg and "هنوز تأیید نشده" in msg  # legacy event: unit unknown


def test_notifier_shows_toman_when_unit_known():
    ev = _event({"price_unit": "rial", "suggested_price_unit": "rial", "our_price": 11_000, "buy_box_price": 10_000,
                 "gap_abs": 1_000, "suggested_price": 9_500,
                 "floor": {"label": "can_win_above_floor", "floor_toman": 750, "win_price_toman": 950.0,
                           "fee_reason": "fee_assumed_max_brand", "unset_components": ["tax", "ad_share"]}})
    msg = render_message(ev)
    assert "قیمت ما: 1,100 تومان" in msg and "قیمت باکس خرید: 1,000 تومان" in msg and "(100 تومان)" in msg
    assert "قیمت پیشنهادی: 950 تومان" in msg and "کف قیمت: 750 تومان" in msg
    assert "هنوز تأیید نشده" not in msg                                  # unit is known now
    assert "بیشترین مقدار برندهای این دسته" in msg
    assert "هزینه‌های تنظیم‌نشده (صفر حساب شده): مالیات، تبلیغات" in msg


def test_notifier_toman_unit_is_not_divided():
    msg = render_message(_event({"price_unit": "toman", "our_price": 1100, "buy_box_price": 1000, "gap_abs": 100,
                                 "suggested_price": 9500, "suggested_price_unit": "rial"}))
    assert "قیمت ما: 1,100 تومان" in msg and "قیمت پیشنهادی: 950 تومان" in msg


def test_notifier_without_floor_unchanged():
    assert "کف قیمت" not in render_message(_event({}))
    assert "کف قیمت: نامشخص" in render_message(_event({"floor": {"label": "needs_cost", "floor_toman": None}}))


# ---------- Docker hardening (static checks, run without a daemon) ----------
def test_dockerfile_is_hardened():
    t = (ROOT / "Dockerfile").read_text()
    assert "USER 10001" in t and "HEALTHCHECK" in t and "--no-cache-dir" in t
    assert "COPY .env" not in t and "ENV DIGIKALA" not in t and "ARG DIGIKALA" not in t
    assert "PYTHONDONTWRITEBYTECODE=1" in t and "/data" in t


def test_dockerignore_excludes_secrets_and_junk():
    lines = (ROOT / ".dockerignore").read_text().split()
    for must in (".env", ".git", "tests", "data", ".venv"):
        assert must in lines or f"{must}/" in lines


def test_compose_limits_and_readonly():
    t = (ROOT / "docker-compose.yml").read_text()
    for needle in ("restart: unless-stopped", "read_only: true", "mem_limit", "cpus", "env_file: .env",
                   "pgdata:", "cap_drop", "no-new-privileges", "10001:10001", "./data:/data"):
        assert needle in t, needle
    assert "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?" in t       # never a literal password


def test_gitignore_keeps_secrets_and_data_out():
    t = (ROOT / ".gitignore").read_text()
    assert ".env" in t.split() and "data/*" in t
