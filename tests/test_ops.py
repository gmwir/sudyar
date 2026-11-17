"""Part 6: write layer, pricing bot, stock pools, promotions, bulk, ship-by-seller, finance."""
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient, ReadOnlyViolation
from sudyar.floor import OK, FloorResult
from sudyar.models import Base, RepriceAction, RepriceRule, SbsShipment, Variant, WriteLog
from sudyar.writer import WRITE_OPS, DigikalaWriter, WriteDisabled, WriteRefused

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def factory():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    return sessionmaker(engine)


def mk(settings, **kw):
    return settings.model_copy(update=kw)


def add_variant(session, dk="111", price=1_000_000, bb=900_000, winner=False, challenge=False, pvid="9111"):
    v = Variant(digikala_variant_id=dk, product_variant_id=pvid, title="T", price_sale=price, buy_box_price=bb,
                is_seller_buy_box_winner=winner, is_in_buy_box_challenge=challenge, active=True, raw_json={})
    session.add(v)
    session.commit()
    return v


class FakeFloor:
    def __init__(self, floor_toman=80_000, status=OK):
        self.r = FloorResult(status, floor_toman if status == OK else None)

    async def evaluate(self, session, v, now, allow_fetch=True):
        return self.r


# ------------------------------------------------------------------ writer
async def test_write_mode_off_refuses_everything(settings, make_limiter, factory):
    async with DigikalaWriter(settings, make_limiter(), factory) as w:
        with pytest.raises(WriteDisabled):
            await w.write("variant_update", {"selling_price": 10}, params={"variant_id": 1})
    with factory() as s:
        assert s.scalar(select(WriteLog)) is None


async def test_dry_run_logs_and_sends_nothing(settings, make_limiter, factory):
    sent = []
    t = httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(200, json={}))
    async with DigikalaWriter(mk(settings, write_mode="dry_run"), make_limiter(), factory, transport=t) as w:
        assert await w.write("variant_update", {"selling_price": 10}, params={"variant_id": 5}) == {"dry_run": True}
    assert sent == []
    with factory() as s:
        row = s.scalar(select(WriteLog))
        assert row.mode == "dry_run" and row.op == "variant_update" and row.payload == {"selling_price": 10}


async def test_live_sends_exact_path_and_body(settings, make_limiter, factory):
    seen = []

    def h(r):
        seen.append(r)
        return httpx.Response(200, json={"status": "ok"})

    async with DigikalaWriter(mk(settings, write_mode="live"), make_limiter(), factory, transport=httpx.MockTransport(h)) as w:
        await w.write("variant_update", {"selling_price": 120_000}, params={"variant_id": 77})
    assert seen[0].method == "PUT" and seen[0].url.path == "/open-api/v1/variants/77"
    assert json.loads(seen[0].content) == {"selling_price": 120_000}
    assert seen[0].headers["authorization"].endswith("SECRET-TOKEN-abc123")
    with factory() as s:
        assert s.scalar(select(WriteLog)).ok is True


async def test_live_error_is_logged_without_token(settings, make_limiter, factory):
    t = httpx.MockTransport(lambda r: httpx.Response(400, json={"message": "price invalid"}))
    async with DigikalaWriter(mk(settings, write_mode="live"), make_limiter(), factory, transport=t) as w:
        with pytest.raises(Exception):
            await w.write("variant_update", {"selling_price": 1}, params={"variant_id": 7})
    with factory() as s:
        row = s.scalar(select(WriteLog))
        assert row.ok is False and row.http_status == 400 and "price invalid" in row.error
        assert "SECRET" not in json.dumps(row.payload)


@pytest.mark.parametrize("name,body,params", [
    ("nope", {}, {}),
    ("variant_update", {"activation": False}, {"variant_id": 1}),  # deactivation is not allowed
    ("variant_update", {"selling_price": 1}, {"variant_id": 0}),
    ("variant_update", {"selling_price": 1}, {"variant_id": "1/../orders"}),
    ("sbs_update_status", {"order_shipment_id": 1, "new_status": "full_delivered_to_customer"}, {}),
    ("batch_variant_update", {"items": [{"variant_id": 1, "payload": {"activation": False}}]}, {}),
    ("promotion_join", {"data": [{"variant_id": 1, "evil": 2}]}, {"promotion_id": 3}),
])
async def test_refused_writes(settings, make_limiter, factory, name, body, params):
    async with DigikalaWriter(mk(settings, write_mode="live"), make_limiter(), factory,
                              transport=httpx.MockTransport(lambda r: pytest.fail("must not send"))) as w:
        with pytest.raises(WriteRefused):
            await w.write(name, body, params=params)


def test_no_write_op_can_cancel_or_delete():
    for name, op in WRITE_OPS.items():
        assert op.method in ("PUT", "POST")
        assert not any(w in op.path for w in ("cancel", "delete", "archive", "/orders/")), name
        assert "activation" not in op.keys | op.item_keys


# ------------------------------------------------------------------ read client allow-list
async def test_extra_read_paths(settings, make_limiter):
    seen = []
    t = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={"data": {"default_price_boundary": {"min_allowed_price": 1}}}))
    async with DigikalaClient(settings, make_limiter(), transport=t) as c:
        assert (await c.get_price_boundary(5))["min_allowed_price"] == 1
        with pytest.raises(ReadOnlyViolation):
            await c.get("/open-api/v1/ship-by-seller-orders/cancel-item")
        with pytest.raises(ReadOnlyViolation):
            await c.get("/open-api/v1/pricing/price-stats/x/boundary")
    assert all(r.method == "GET" for r in seen)


# ------------------------------------------------------------------ pricing decision
from sudyar.repricer import Inputs, Repricer, caps_block, decide, set_rule  # noqa: E402


def rule(**kw):
    base = dict(enabled=True, strategy="buybox", raise_when_alone=True)
    base.update(kw)
    return RepriceRule(**base)


def test_no_floor_no_change(settings):
    d = decide(rule(), Inputs(1_000_000, None, False, suggested_rial=900_000), settings)
    assert d.new_rial is None and "floor" in d.reason


def test_follows_suggestion_but_never_below_floor(settings):
    s = mk(settings, reprice_max_change_pct=50)
    assert decide(rule(), Inputs(1_000_000, 80_000, True, suggested_rial=905_500), s).new_rial == 905_000
    d = decide(rule(), Inputs(1_000_000, 95_000, True, suggested_rial=900_000), s)
    assert d.new_rial == 950_000 and "floor" in d.reason


def test_max_change_per_action(settings):
    d = decide(rule(), Inputs(1_000_000, 10_000, True, suggested_rial=500_000), mk(settings, reprice_max_change_pct=10))
    assert d.new_rial == 900_000


def test_winner_steps_up_only_with_ceiling(settings):
    alone = Inputs(1_000_000, 50_000, True, is_winner=True, in_challenge=False)
    assert decide(rule(), alone, settings).new_rial is None  # no ceiling: never raise
    d = decide(rule(max_toman=101_500, raise_step_pct=5), alone, settings)
    assert d.new_rial == 1_015_000 and "ceiling" in d.reason


def test_boundary_and_hold_and_undercut(settings):
    s = mk(settings, reprice_max_change_pct=50)
    d = decide(rule(), Inputs(1_000_000, 50_000, True, suggested_rial=600_000, boundary_min_rial=700_000), s)
    assert d.new_rial == 700_000
    assert decide(rule(strategy="hold"), Inputs(1_000_000, 50_000, True, suggested_rial=1), s).new_rial is None
    d = decide(rule(strategy="undercut", gap_toman=2_000), Inputs(1_000_000, 50_000, True, buy_box_rial=950_000), s)
    assert d.new_rial == 930_000
    lo_hi = decide(rule(max_toman=90_000), Inputs(1_000_000, 95_000, True, suggested_rial=900_000), s)
    assert lo_hi.new_rial is None


def test_fx_strategy(settings):
    r = rule(strategy="fx", fx_base_amount=2.0, fx_markup_pct=10, max_toman=None)
    d = decide(r, Inputs(1_900_000, 50_000, True, fx_rate_toman=90_000), mk(settings, reprice_max_change_pct=50))
    assert d.new_rial == 1_980_000


def test_caps(settings, session):
    v = add_variant(session)
    s = mk(settings, reprice_max_changes_per_day=2, reprice_cooldown_seconds=600)
    assert caps_block(session, v.id, NOW, s) is None
    session.add(RepriceAction(variant_id=v.id, ts=NOW - timedelta(seconds=60), reason="x", mode="live", applied=True))
    session.commit()
    assert caps_block(session, v.id, NOW, s) == "cooldown"
    session.add(RepriceAction(variant_id=v.id, ts=NOW - timedelta(hours=2), reason="x", mode="live", applied=True))
    session.commit()
    assert caps_block(session, v.id, NOW + timedelta(hours=1), s) == "daily change limit reached"


class FakeClient:
    def __init__(self, suggested=None):
        self.suggested = suggested

    async def get_winning_price(self, pvid):
        return self.suggested

    async def get_nth_rank_winning_price(self, pvid, rank):
        return self.suggested

    async def get_price_boundary(self, vid):
        return {"min_allowed_price": 100_000, "max_allowed_price": 5_000_000}


async def test_repricer_dry_run_records_action_and_write(settings, make_limiter, factory):
    s = mk(settings, write_mode="dry_run")
    with factory() as session:
        vid = add_variant(session).id
        set_rule(session, "111", strategy="buybox")
    async with DigikalaWriter(s, make_limiter(), factory) as w:
        rep = await Repricer(FakeClient(950_000), w, factory, s, FakeFloor(80_000)).run_once(NOW)
    assert (rep.checked, rep.changed, rep.errors) == (1, 0, 0)  # dry-run never counts as applied
    with factory() as session:
        a = session.scalar(select(RepriceAction))
        assert a.new_price == 950_000 and a.applied is False and a.mode == "dry_run"
        w = session.scalar(select(WriteLog))
        assert w.payload == {"selling_price": 950_000} and w.target == "111"
        assert session.get(Variant, vid).price_sale == 1_000_000


async def test_repricer_off_mode_sends_nothing(settings, make_limiter, factory):
    with factory() as session:
        add_variant(session)
        set_rule(session, "111")
    async with DigikalaWriter(settings, make_limiter(), factory) as w:
        await Repricer(FakeClient(950_000), w, factory, settings, FakeFloor()).run_once(NOW)
    with factory() as session:
        assert "WRITE_MODE=off" in session.scalar(select(RepriceAction)).reason
        assert session.scalar(select(WriteLog)) is None


def test_set_rule_validation(session):
    add_variant(session)
    with pytest.raises(ValueError):
        set_rule(session, "111", strategy="crazy")
    with pytest.raises(ValueError):
        set_rule(session, "111", strategy="rank")
    with pytest.raises(ValueError):
        set_rule(session, "404")


# ------------------------------------------------------------------ stock pools
from sudyar.inventory import plan_pool, set_pool, split_stock  # noqa: E402


@pytest.mark.parametrize("qty,w,out", [(10, [1, 1], [5, 5]), (7, [2, 1], [5, 2]), (1, [1, 1, 1], [1, 0, 0]),
                                       (5, [0, 0], [3, 2]), (0, [1, 2], [0, 0]), (-3, [1], [0])])
def test_split_stock(qty, w, out):
    res = split_stock(qty, w)
    assert sum(res) == max(0, qty) and res == out


def test_pool_plan(session):
    add_variant(session, "1", pvid="a")
    add_variant(session, "2", pvid="b")
    p = set_pool(session, "brake pads", 9, [("1", 2), ("2", 1)])
    assert plan_pool(session, p).lines == [("1", 6), ("2", 3)]
    with pytest.raises(ValueError):
        set_pool(session, "other", 1, [("1", 1)])


# ------------------------------------------------------------------ promotions / bulk
from sudyar.bulk import plan_bulk  # noqa: E402
from sudyar.promotions import promo_price  # noqa: E402


def test_promo_price():
    assert promo_price({"selling_price": 1_000_000, "min_category_discount": 10, "max_allowable_price": 950_000}, 1000) == 900_000
    assert promo_price({"selling_price": 1_000_000, "min_category_discount": 1, "max_allowable_price": 950_000}, 1000) == 950_000
    assert promo_price({"selling_price": None}, 1000) is None


async def test_bulk_rejects_below_floor_and_unknown(session):
    add_variant(session, "111")
    rows = [["variant_id", "price_toman", "seller_stock"], ["111", "70,000", "4"], ["222", "", "3"], ["111", "", "2"]]
    plan = await plan_bulk(session, FakeFloor(80_000), rows, NOW)
    assert plan.items == []
    assert any("below profit floor" in e for e in plan.errors) and any("222" in e for e in plan.errors)
    rows = [["variant_id", "price_toman", "seller_stock"], ["۱۱۱", "۹۰٬۰۰۰", "4"]]
    plan = await plan_bulk(session, FakeFloor(80_000), rows, NOW)
    assert plan.items == [{"variant_id": 111, "payload": {"selling_price": 900_000, "seller_stock": 4}}]


# ------------------------------------------------------------------ ship-by-seller
from sudyar.sbs import parse_shipment, parse_tracking_file, render_labels  # noqa: E402


def test_shipment_parse_keeps_no_customer_data():
    p = parse_shipment({"shipmentId": 5, "orderId": 9, "address": {"city": "شیراز"}, "status": {"text": "new"},
                        "variants": [{"title": "لنت", "count": 2, "price": 1}], "customer": {"name": "x"}})
    assert p["items"] == [{"title": "لنت", "qty": 2}]
    assert "address" not in json.dumps(p, ensure_ascii=False) and "شیراز" not in json.dumps(p, ensure_ascii=False)
    assert set(p) <= {c.name for c in SbsShipment.__table__.columns}


def test_tracking_file():
    ok, errs = parse_tracking_file(b"shipment_id,tracking_code\n5,ABC123\nx,1\n6,\n", "t.csv")
    assert ok == [(5, "ABC123")] and len(errs) == 2


def test_labels_escape_html():
    sh = SbsShipment(shipment_id=1, order_id=2, items=[{"title": "<b>x</b>", "qty": 1}])
    out = render_labels([(sh, {"name": "<script>alert(1)</script>"})])
    assert "<script>" not in out and "&lt;script&gt;" in out


# ------------------------------------------------------------------ settings / migration
def test_write_mode_setting():
    assert Settings().write_mode == "off"
    with pytest.raises(Exception):
        Settings(write_mode="yolo")


def test_migration_0011_matches_models():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("m11", Path(__file__).parents[1] / "migrations/versions/0011_operations.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    for t in m.TABLES:
        assert t in Base.metadata.tables
    src = (Path(__file__).parents[1] / "migrations/versions/0011_operations.py").read_text()
    for t in m.TABLES:
        for c in Base.metadata.tables[t].columns:
            assert f'"{c.name}"' in src, (t, c.name)


# ------------------------------------------------------------------ web page
def test_ops_page_shows_mode_and_data_without_secrets():
    from webfx import TOKEN, client, make_app, make_factory, make_settings, seed

    from sudyar.models import WriteLog as WL
    f = make_factory()
    seed(f)
    with f() as s:
        s.add(WL(op="variant_update", target="1", mode="dry_run", payload={"selling_price": 1}, ok=True))
        s.add(SbsShipment(shipment_id=42, order_id=7, status_fa="جدید", items=[]))
        s.commit()
    r = client(make_app(f, settings=make_settings(write_mode="dry_run"))).get("/ops")
    assert r.status_code == 200 and "آزمایشی" in r.text and "variant_update" in r.text and "۴۲" in r.text
    assert TOKEN not in r.text
