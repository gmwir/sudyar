import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from sqlalchemy import create_engine, func, pool, select
from sqlalchemy.orm import sessionmaker

from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.floor import FeeProvider, Fees, FloorEngine, set_floor_rule
from sudyar.models import Base, FeeCache, FloorEvent, RadarEvent, Variant, VariantCost
from sudyar.notifier import Dispatcher, render_message
from sudyar.radar import Radar
from test_radar import FakeApi, item

T0 = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
ROOT = Path(__file__).resolve().parent.parent


def build(make_limiter, items, **settings_kw):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=pool.StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    s = Settings(digikala_self_token="tok", postgres_password="pw", page_size=2, price_unit="toman", **settings_kw)
    api = FakeApi(items)
    client = DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(api.handler))
    radar = Radar(client, factory, s, Dispatcher(s, {}, emit=lambda m: None), FloorEngine(s, FeeProvider(client, s)))
    return api, radar, factory


async def lose_one(radar, api, t=T0):
    await radar.run_cycle(t)
    api.items[0] = item(1, win=False, price=1100, bb=1000)
    return await radar.run_cycle(t + timedelta(hours=1, seconds=5))


def prepare(factory, cost=None, rule=True):
    with factory() as ses:
        v = ses.scalar(select(Variant))
        if cost is not None:
            ses.add(VariantCost(variant_id=v.id, buy_cost=cost, source="excel", updated_at=T0))
        ses.add(FeeCache(key=v.product_variant_id, data=Fees(commission_pct=10).to_dict(), fetched_at=T0 + timedelta(hours=1)))
        ses.commit()
        if rule:
            set_floor_rule(ses, "global", margin_pct=10)


async def test_loss_labeled_can_win_above_floor(make_limiter):
    api, radar, factory = build(make_limiter, [item(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=600)                 # floor = ceil(600/0.8) = 750 toman
    api.items[0] = item(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))   # suggested 950 Rial = 95 toman
    # 95 toman < 750 -> would need below floor
    f = next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]
    assert f["floor_toman"] == 750 and f["label"] == "would_need_below_floor" and f["win_price_toman"] == 95


async def test_loss_labeled_can_win_when_suggestion_high(make_limiter):
    api, radar, factory = build(make_limiter, [item(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=60)                  # floor = 75
    api.items[0] = item(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))   # 95 toman >= 75
    f = next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"]
    assert f["label"] == "can_win_above_floor" and f["floor_toman"] == math.ceil(60 / 0.8)
    with factory() as ses:
        assert ses.scalar(select(func.count()).select_from(FloorEvent)) == 1


async def test_loss_labeled_needs_cost_and_no_price_changes(make_limiter):
    api, radar, factory = build(make_limiter, [item(1)])
    await radar.run_cycle(T0)
    prepare(factory, cost=None)
    api.items[0] = item(1, win=False, price=1100, bb=1000)
    res = await radar.run_cycle(T0 + timedelta(hours=1, seconds=5))
    lost = next(e for e in res.events if e.type == "BUYBOX_LOST")
    assert lost.details["floor"]["label"] == "needs_cost" and lost.details["floor"]["floor_toman"] is None
    assert api.requests and all(r.method == "GET" for r in api.requests)       # still read-only


async def test_radar_without_floor_engine_still_works(make_limiter):
    api, radar, factory = build(make_limiter, [item(1)])
    radar.floor_engine = None
    res = await lose_one(radar, api)
    assert "floor" not in next(e for e in res.events if e.type == "BUYBOX_LOST").details


async def test_floor_failure_never_breaks_cycle(make_limiter):
    api, radar, factory = build(make_limiter, [item(1)])

    class Boom:
        async def assess_loss(self, *a, **k):
            raise RuntimeError("secret-ish detail")

    radar.floor_engine = Boom()
    res = await lose_one(radar, api)
    assert next(e for e in res.events if e.type == "BUYBOX_LOST").details["floor"] is None


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
    assert fa in msg and "کف قیمت: 750 تومان" in msg and "فقط پیشنهاد است" in msg


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
