from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from sudyar import radar as R
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.models import Base, HotOverride, RadarEvent, Variant, VariantSnapshot
from sudyar.tiers import (CALM, HOT, WARM, classify_tiers, due_variants, estimate_requests_per_minute,
                          max_pages_per_tick, plan_pages)

T0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def prev(**kw):
    base = dict(is_seller_buy_box_winner=True, is_in_buy_box_challenge=False, price_sale=1000, stock=5, active=True)
    base.update(kw)
    return SimpleNamespace(**base)


def new(**kw):
    base = dict(is_seller_buy_box_winner=True, is_in_buy_box_challenge=False, price_sale=1000, stock=5, active=True)
    base.update(kw)
    return base


# ---------- event detection ----------
@pytest.mark.parametrize("p,n,expected", [
    (prev(), new(is_seller_buy_box_winner=False), R.BUYBOX_LOST),
    (prev(is_seller_buy_box_winner=False), new(), R.BUYBOX_REGAINED),
    (prev(), new(is_in_buy_box_challenge=True), R.ENTERED_CHALLENGE),
    (prev(is_in_buy_box_challenge=True), new(), R.LEFT_CHALLENGE),
    (prev(), new(price_sale=900), R.PRICE_CHANGED),
    (prev(), new(stock=0), R.STOCK_OUT),
    (prev(stock=0), new(stock=3), R.STOCK_BACK),
    (prev(), new(active=False), R.DEACTIVATED),
])
def test_each_event_type(p, n, expected):
    assert [e[0] for e in R.detect_events(p, n)] == [expected]


def test_no_change_and_unknown_never_emit():
    assert R.detect_events(prev(), new()) == []
    unknown_prev = prev(is_seller_buy_box_winner=None, is_in_buy_box_challenge=None, price_sale=None, stock=None, active=None)
    # previous values unknown -> we must not claim any change
    assert R.detect_events(unknown_prev, new(is_seller_buy_box_winner=False, price_sale=5, stock=0, active=False)) == []
    assert R.detect_events(unknown_prev, new(is_seller_buy_box_winner=False, is_in_buy_box_challenge=True)) == []


def test_old_and_new_values():
    assert R.detect_events(prev(), new(price_sale=900)) == [(R.PRICE_CHANGED, 1000, 900)]


# ---------- cause v1 ----------
def test_cause_priorities_and_gap():
    d = R.determine_cause({"price_sale": 1100, "buy_box_price": 1000, "stock": 5, "active": True})
    assert d == {"cause": "price_above", "gap_abs": 100, "gap_pct": 10.0}
    assert R.determine_cause({"price_sale": 1100, "buy_box_price": 1000, "stock": 0, "active": True})["cause"] == "stock_out"
    assert R.determine_cause({"price_sale": 1100, "buy_box_price": 1000, "stock": 5, "active": False})["cause"] == "inactive"


def test_cause_unknown_when_we_are_not_more_expensive():
    assert R.determine_cause({"price_sale": 900, "buy_box_price": 1000, "stock": 5, "active": True})["cause"] == "unknown"
    d = R.determine_cause({"price_sale": 900, "buy_box_price": None, "stock": None, "active": True})
    assert d["cause"] == "unknown" and d["gap_pct"] is None


# ---------- full cycle with mocked HTTP ----------
def item(i, win=True, challenge=False, price=1000, bb=1000, stock=5, active=True):
    return {"id": i, "product_id": i, "product_variant_id": 9000 + i, "title": f"v{i}", "active": active,
            "price_sale": price, "buy_box_price": bb, "marketplace_seller_stock": stock,
            "is_seller_buy_box_winner": win, "is_in_buy_box_challenge": challenge}


class FakeApi:
    def __init__(self, items, size=2):
        self.items, self.size, self.requests = items, size, []

    def handler(self, request: httpx.Request):
        self.requests.append(request)
        if request.url.path.endswith("winning-price"):
            return httpx.Response(200, json={"data": {"suggested_price": 950}})
        page = int(request.url.params["page"])
        chunk = self.items[(page - 1) * self.size: page * self.size]
        total = max(1, -(-len(self.items) // self.size))
        return httpx.Response(200, json={"data": {"items": chunk, "pager": {"total_pages": total}}})

    def pages(self):
        return [int(r.url.params["page"]) for r in self.requests if "page" in r.url.params]

    def wp_calls(self):
        return [r for r in self.requests if r.url.path.endswith("winning-price")]


@pytest.fixture
def env(make_limiter):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=__import__("sqlalchemy").pool.StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    s = Settings(digikala_self_token="tok-abcdef", postgres_password="pw", page_size=2)

    def build(items, notifier=None):
        api = FakeApi(items)
        client = DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(api.handler))
        return api, R.Radar(client, factory, s, notifier), factory

    return build, s


async def test_first_cycle_is_baseline_second_detects_events(env):
    build, s = env
    api, radar, factory = build([item(1), item(2), item(3)])
    r1 = await radar.run_cycle(T0)
    assert r1.events == [] and sorted(r1.pages_read) == [1, 2]
    with factory() as ses:
        assert ses.scalar(select(func.count()).select_from(VariantSnapshot)) == 3

    api.items[0] = item(1, win=False, price=1100, bb=1000)      # lost + price up
    api.items[1] = item(2, stock=0)                              # stock out
    r2 = await radar.run_cycle(T0 + timedelta(hours=1, seconds=10))   # CALM variants are due after 60 min
    kinds = sorted(e.type for e in r2.events)
    assert kinds == ["BUYBOX_LOST", "PRICE_CHANGED", "STOCK_OUT"]
    lost = next(e for e in r2.events if e.type == "BUYBOX_LOST")
    assert lost.details["cause"] == "price_above" and lost.details["gap_pct"] == 10.0
    assert lost.details["gap_abs"] == 100 and lost.details["suggested_price"] == 950
    assert lost.old_value == "True" and lost.new_value == "False"


async def test_winning_price_cached_for_10_minutes(env):
    build, s = env
    api, radar, _ = build([item(1)])
    await radar.run_cycle(T0)
    t = T0 + timedelta(hours=1)                                  # CALM variant: first re-read after 60 min
    for i, win in enumerate([False, True, False]):             # lost, regained, lost again
        t += timedelta(seconds=130 if i else 0)               # after the loss it is HOT (2 min)
        api.items[0] = item(1, win=win, price=1100)
        await radar.run_cycle(t)
    assert len(api.wp_calls()) == 1                              # 2nd loss within 10 min -> cache
    t += timedelta(seconds=700)
    api.items[0] = item(1, win=True)
    await radar.run_cycle(t)
    t += timedelta(seconds=130)
    api.items[0] = item(1, win=False, price=1100)
    await radar.run_cycle(t)
    assert len(api.wp_calls()) == 2                              # cache expired


async def test_winning_price_failure_gives_unknown(env, make_limiter):
    build, s = env
    api, radar, _ = build([item(1)])
    orig = api.handler
    api.handler = lambda r: httpx.Response(404) if r.url.path.endswith("winning-price") else orig(r)
    radar.client._http._transport = httpx.MockTransport(api.handler)
    radar.client.limiter.cfg.max_retries = 0
    await radar.run_cycle(T0)
    api.items[0] = item(1, win=False, price=1100)
    r = await radar.run_cycle(T0 + timedelta(hours=1))
    assert r.events[0].details["suggested_price"] is None


async def test_event_dedupe(env):
    build, s = env
    api, radar, factory = build([item(1)])
    await radar.run_cycle(T0)
    with factory() as ses:
        v = ses.scalar(select(Variant))
        snap = ses.scalar(select(VariantSnapshot))
        a = R.insert_event(ses, v, snap.id, R.STOCK_OUT, 5, 0, {}, T0)
        b = R.insert_event(ses, v, snap.id, R.STOCK_OUT, 5, 0, {}, T0)
        assert a is not None and b is None
        assert ses.scalar(select(func.count()).select_from(RadarEvent)) == 1


async def test_all_calls_are_get_only(env):
    build, s = env
    api, radar, _ = build([item(1), item(2)])
    await radar.run_cycle(T0)
    api.items[0] = item(1, win=False, price=1100)
    await radar.run_cycle(T0 + timedelta(seconds=130))
    assert api.requests and all(r.method == "GET" for r in api.requests)


async def test_hot_pages_polled_more_often_than_calm(env):
    build, s = env
    items = [item(i) for i in range(1, 9)]                       # 4 pages
    items[0] = item(1, challenge=True)                           # page 1 is HOT
    api, radar, _ = build(items)
    await radar.run_cycle(T0)
    assert sorted(api.pages()) == [1, 2, 3, 4]
    api.requests.clear()
    await radar.run_cycle(T0 + timedelta(seconds=125))
    assert api.pages() == [1]                                    # only the HOT page


# ---------- tiers ----------
def seed(session, vid, **kw):
    v = Variant(digikala_variant_id=str(vid), raw_json={}, active=True, is_seller_buy_box_winner=True,
                is_in_buy_box_challenge=False, **kw)
    session.add(v)
    session.flush()
    return v


def test_tier_assignment_and_moves(session):
    s = Settings()
    calm, chal, lost, warm, over = (seed(session, i) for i in range(5))
    chal.is_in_buy_box_challenge = True
    warm.is_seller_buy_box_winner = False
    lost.is_seller_buy_box_winner = False
    session.add(RadarEvent(variant_id=lost.id, type="BUYBOX_LOST", created_at=T0, dedupe_key="a"))
    session.add(HotOverride(variant_id=over.id, created_at=T0))
    session.flush()
    t = classify_tiers(session, T0 + timedelta(minutes=30), s)
    assert [t[v.id] for v in (calm, chal, lost, warm, over)] == [CALM, HOT, HOT, WARM, HOT]
    # 61 minutes after the loss: no longer HOT, but still WARM (not winning + recent event)
    t = classify_tiers(session, T0 + timedelta(minutes=61), s)
    assert t[lost.id] == WARM
    chal.is_in_buy_box_challenge = False                         # left the challenge -> calm
    session.flush()
    assert classify_tiers(session, T0, s)[chal.id] == CALM
    # a recent event of any kind makes a calm variant WARM for 24 h, then it calms down
    session.add(RadarEvent(variant_id=calm.id, type="PRICE_CHANGED", created_at=T0, dedupe_key="b"))
    session.flush()
    assert classify_tiers(session, T0 + timedelta(hours=2), s)[calm.id] == WARM
    assert classify_tiers(session, T0 + timedelta(hours=25), s)[calm.id] == CALM


def test_due_by_interval():
    s = Settings()
    tiers = {1: HOT, 2: WARM, 3: CALM, 4: HOT}
    last = {1: T0, 2: T0, 3: T0}                                  # 4 never read
    due = due_variants(tiers, last, T0 + timedelta(seconds=125), s)
    assert due == {HOT: [1, 4], WARM: [], CALM: []}
    due = due_variants(tiers, last, T0 + timedelta(seconds=605), s)
    assert due[WARM] == [2] and due[CALM] == []
    assert due_variants(tiers, last, T0 + timedelta(hours=1), s)[CALM] == [3]


# ---------- budget ----------
def test_budget_defaults_to_60_percent():
    s = Settings()
    assert max_pages_per_tick(s) == 72                            # 36 req/min * 2 min
    assert plan_pages({HOT: [1, 2], WARM: [3]}, {1: 5, 2: 6, 3: 7}, {1, 2, 3}, 2) == [5, 6]
    assert plan_pages({HOT: [1]}, {1: 5}, {1, 2, 3}, 10) == [5, 1, 2, 3]   # HOT page first, then full read


async def test_radar_limiter_uses_budget(ft):
    from sudyar.__main__ import _build
    s = Settings(digikala_self_token="t", postgres_password="p", database_url_override="sqlite://")
    _, client = _build(s, radar=True)
    assert client.limiter.cfg.requests == 18 and client.limiter.cfg.period_seconds == 30
    _, normal = _build(s)
    assert normal.limiter.cfg.requests == 30


def test_estimates_per_tier():
    s = Settings()
    est = estimate_requests_per_minute({HOT: 20, WARM: 300, CALM: 4680}, s)    # 100 pages
    assert est[HOT] == (0.5, 10.0) and est[WARM][1] == 10.0
    assert sum(hi for _, hi in est.values()) < 36                 # inside the budget
