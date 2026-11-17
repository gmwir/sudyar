"""Part 4c: real daily sales from the Order API. READ-ONLY, mocked HTTP only."""
import inspect
import pathlib
from datetime import date, datetime, timedelta, timezone

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import select

from sudyar import orders as om
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient, ReadOnlyViolation
from sudyar.floor import FloorEngine, set_floor_rule
from sudyar.fees import FeeProvider
from sudyar.models import ApiCallLog, Commission, DailySales, FeeCache, Variant, VariantCost
from sudyar.orders import parse_order_line, sync_orders, tehran_day_bounds
from sudyar.web import data
from webfx import NOW, client, make_app, make_factory, make_settings, variant

ROOT = pathlib.Path(__file__).resolve().parent.parent
DAY = date(2026, 11, 13)  # yesterday in Tehran relative to NOW (2026-11-14 12:00Z)


def st(**kw):
    return Settings(digikala_self_token="tok-orders-secret", postgres_password="pw", page_size=2, **kw)


def line(pvid="7", qty=1, price=1_000_000, disc=0, created="2026-11-13T08:00:00.000Z", oid=1, sid=1, **extra):
    return {"product_variant_id": pvid, "product_id": "p", "order_id": oid, "shipment_id": sid, "order_created_at": created,
            "order_status": "x", "quantity": qty, "unit_price": price, "unit_discount": disc, "total_price": qty * price,
            "seller_voucher_amount": 0, "cancellation_info": None, **extra}


def page(items, p=1, total=1):
    return {"data": {"items": items, "pager": {"current_page": p, "total_pages": total, "total_items": len(items)}}}


def mk(handler, s, make_limiter):
    return DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(handler))


# ---------- READ-ONLY guarantees ----------
async def test_client_cannot_use_any_non_get_method(make_limiter):
    c = mk(lambda r: httpx.Response(200, json=page([])), st(), make_limiter)
    async with c:
        for m in ("DELETE", "POST", "PUT", "PATCH"):
            with pytest.raises(ReadOnlyViolation):
                await c._request(m, "/open-api/v1/orders/123")
            with pytest.raises(ReadOnlyViolation):
                await c._http.request(m, "/open-api/v1/orders/123")


def test_no_delete_or_write_code_for_orders():
    names = [n.lower() for n, _ in inspect.getmembers(DigikalaClient, inspect.isfunction)]
    assert not [n for n in names if any(w in n for w in ("delete", "cancel", "remove", "post", "put", "patch"))]
    for f in (ROOT / "src" / "sudyar").rglob("*.py"):
        for ln in f.read_text().splitlines():
            if ln.lstrip().startswith("#") or "DELETE" in ln or "ITEM_ID_KEYS" in ln:  # ITEM_ID_KEYS = response field names, not paths  # comments/docs that warn about the DELETE endpoint
                continue
            assert "orders/{" not in ln and "order_item_id" not in ln, (f, ln)
            assert ".delete(" not in ln.replace("session.delete(", ""), (f, ln)


@pytest.mark.parametrize("bad", ["/open-api/v1/orders/123", "/open-api/v1/orders/{order_item_id}", "/open-api/v1/orders/history/",
                                 "/open-api/v1/variants", "https://evil.example/orders"])
def test_orders_path_allow_list(bad):
    with pytest.raises(ValidationError):
        st(orders_path=bad)


async def test_orders_request_is_get_with_documented_params(make_limiter):
    seen = []

    def h(r):
        seen.append(r)
        return httpx.Response(200, json=page([line()]))

    s = st()
    start, end = tehran_day_bounds(DAY)
    async with mk(h, s, make_limiter) as c:
        items, total = await c.get_orders_page("processed", start, end, 1)
        with pytest.raises(ValueError):
            await c.get_orders_page("bogus", start, end, 1)
    r = seen[0]
    assert r.method == "GET" and r.url.path == "/open-api/v1/orders/history"
    q = dict(r.url.params)
    assert q["order_type"] == "processed" and q["page"] == "1" and q["size"] == "2"
    assert q["order_created_at_from"] == "2026-11-12T20:30:00.000Z" and q["order_created_at_to"] == "2026-11-13T20:30:00.000Z"
    assert len(items) == 1 and total == 1


# ---------- parsing ----------
def test_tehran_day_bounds_and_assignment():
    a, b = tehran_day_bounds(DAY)
    assert (a, b) == (datetime(2026, 11, 12, 20, 30, tzinfo=timezone.utc), datetime(2026, 11, 13, 20, 30, tzinfo=timezone.utc))
    s = st()
    assert parse_order_line(line(created="2026-11-13T20:29:59.000Z"), "processed", s)[0] == DAY
    assert parse_order_line(line(created="2026-11-13T20:30:00.000Z"), "processed", s)[0] == DAY + timedelta(days=1)


def test_discount_modes_and_returned_negative():
    r = parse_order_line(line(qty=2, price=1_000_000, disc=100_000), "processed", st())
    assert r == (DAY, "7", 2, 900_000)
    assert parse_order_line(line(price=1_000_000, disc=100_000), "processed", st(orders_discount_mode="ignore"))[3] == 1_000_000
    assert parse_order_line(line(qty=3), "returned", st())[2] == -3


def test_canceled_and_bad_lines_are_not_counted():
    s = st()
    assert parse_order_line(line(cancellation_info={"reason": "x"}), "processed", s) is None
    for bad in (line(pvid=None), line(qty=0), line(qty="x"), line(price=-5), line(created="garbage"), line(disc=-1)):
        assert isinstance(parse_order_line(bad, "processed", s), str)


# ---------- sync ----------
def handler_for(by_type, calls=None):
    def h(r):
        if calls is not None:
            calls.append(r)
        t = r.url.params["order_type"]
        p = int(r.url.params["page"])
        pages = by_type.get(t, [[]])
        items = pages[p - 1] if p <= len(pages) else []
        return httpx.Response(200, json=page(items, p, len(pages)))
    return h


async def test_sync_aggregates_paginates_and_stores_no_personal_data(session, make_limiter):
    pages = {"processed": [[line(qty=2, oid=1, customer_name="Ali", phone="0912", address="x"), line(qty=1, oid=2, sid=2)],
                           [line(qty=1, oid=3, sid=3, pvid="8", price=500_000)]],
             "returned": [[line(qty=1, oid=9, sid=9)]]}
    calls = []
    async with mk(handler_for(pages, calls), st(), make_limiter) as c:
        r = await sync_orders(c, session, st(), [DAY], NOW)
    rows = {(x.product_variant_id, x.unit_sale_price): x.quantity for x in session.scalars(select(DailySales))}
    assert rows == {("7", 1_000_000): 2, ("8", 500_000): 1}  # 2+1 processed -1 returned
    assert all(c_.method == "GET" for c_ in calls) and r.days[0].pages == 3
    assert {c_.url.params["order_type"] for c_ in calls} == {"processed", "returned"}  # canceled never requested
    cols = {c_.name for c_ in DailySales.__table__.columns}
    assert cols == {"day", "product_variant_id", "unit_sale_price", "quantity", "synced_at"}
    dump = " ".join(str(v) for t in (DailySales, FeeCache) for x in session.scalars(select(t)) for v in vars(x).values())
    assert "Ali" not in dump and "0912" not in dump


async def test_sync_is_idempotent_cached_and_force(session, make_limiter):
    calls = []
    async with mk(handler_for({"processed": [[line()]]}, calls), st(), make_limiter) as c:
        await sync_orders(c, session, st(), [DAY], NOW)
        n = len(calls)
        r = await sync_orders(c, session, st(), [DAY], NOW + timedelta(minutes=5))
        assert r.days[0].cached and len(calls) == n
        await sync_orders(c, session, st(), [DAY], NOW + timedelta(minutes=5), force=True)
    assert len(list(session.scalars(select(DailySales)))) == 1  # replaced, not duplicated


async def test_duplicates_and_other_days_are_dropped(session, make_limiter):
    items = [line(), line(), line(created="2026-11-12T08:00:00.000Z", oid=5, sid=5)]
    async with mk(handler_for({"processed": [items]}), st(), make_limiter) as c:
        r = await sync_orders(c, session, st(), [DAY], NOW)
    assert [x.quantity for x in session.scalars(select(DailySales))] == [2]      # identical lines are KEPT (no item id)
    assert r.days[0].duplicates_dropped == 0 and r.days[0].suspect_duplicates == 1 and r.days[0].rejected == 1


async def test_page_cap_stores_nothing_and_failure_keeps_old_rows(session, make_limiter):
    session.add(DailySales(day=DAY, product_variant_id="old", unit_sale_price=1, quantity=5, synced_at=NOW))
    session.commit()
    big = {"processed": [[line(oid=i, sid=i)] for i in range(1, 6)]}
    s = st(orders_max_pages=2)
    async with mk(handler_for(big), s, make_limiter) as c:
        with pytest.raises(om.OrdersSyncError):
            await sync_orders(c, session, s, [DAY], NOW, force=True)

    def boom(r):
        return httpx.Response(500, json={})
    async with mk(boom, st(), make_limiter, ) as c:
        with pytest.raises(Exception):
            await sync_orders(c, session, st(), [DAY], NOW, force=True)
    assert [x.product_variant_id for x in session.scalars(select(DailySales))] == ["old"]


# ---------- profit math + web ----------
def _seed(f, price_unit="rial"):
    with f() as s:
        s.add(Commission(category_id="101", commission=0.10, fetched_at=NOW))
        s.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=NOW))
        set_floor_rule(s, "global", margin_pct=10)
        v = variant(s, "1001", "فیلتر", product="p1")
        s.add(VariantCost(variant_id=v.id, buy_cost=1_000_000, source="excel", updated_at=NOW))
        s.commit()
        return v.product_variant_id


def test_actual_profit_math_rial_to_toman_and_returns():
    f = make_factory()
    pv = _seed(f)
    with f() as s:
        # sold 3 @ 15,000,000 Rial (=1,500,000 Toman) and 1 returned; net 2. cost 1,000,000 T, commission 10%.
        s.add(DailySales(day=DAY, product_variant_id=pv, unit_sale_price=15_000_000, quantity=2, synced_at=NOW))
        s.add(FeeCache(key=f"orders:{DAY}", data={}, fetched_at=NOW))
        s.commit()
        y = data.build_yesterday(s, data.make_engine(make_settings()), make_settings(), NOW)
    assert y.state == "ok" and y.units == 2 and y.variants_used == 1
    assert y.total_toman == pytest.approx(2 * (1_500_000 * 0.9 - 1_000_000))  # 700,000


def test_unit_assumption_toman_switch():
    f = make_factory()
    pv = _seed(f)
    s_ = make_settings(orders_price_unit="toman")
    with f() as s:
        s.add(DailySales(day=DAY, product_variant_id=pv, unit_sale_price=1_500_000, quantity=1, synced_at=NOW))
        s.add(FeeCache(key=f"orders:{DAY}", data={}, fetched_at=NOW))
        s.commit()
        y = data.build_yesterday(s, data.make_engine(s_), s_, NOW)
    assert y.total_toman == pytest.approx(350_000)


def test_states_no_data_no_sales_nothing_usable_and_missing_scope():
    f = make_factory()
    pv = _seed(f)
    with f() as s:
        eng, se = data.make_engine(make_settings()), make_settings()
        assert data.build_yesterday(s, eng, se, NOW).state == "no_data"
        s.add(ApiCallLog(called_at=NOW, endpoint="/open-api/v1/orders/history", status=403, duration_ms=1))
        s.commit()
        assert data.build_yesterday(s, eng, se, NOW).state == "no_scope"
        s.add(FeeCache(key=f"orders:{DAY}", data={}, fetched_at=NOW))
        s.commit()
        assert data.build_yesterday(s, eng, se, NOW).state == "no_sales"
        s.add(DailySales(day=DAY, product_variant_id="unknown", unit_sale_price=1, quantity=1, synced_at=NOW))
        s.commit()
        y = data.build_yesterday(s, eng, se, NOW)
        assert y.state == "nothing_usable" and y.total_toman is None and y.unknown == 1 and y.excluded == 0


def test_today_page_shows_actual_profit_and_flags_assumptions():
    f = make_factory()
    pv = _seed(f)
    with f() as s:
        s.add(DailySales(day=DAY, product_variant_id=pv, unit_sale_price=15_000_000, quantity=2, synced_at=NOW))
        s.add(FeeCache(key=f"orders:{DAY}", data={}, fetched_at=NOW))
        s.commit()
    r = client(make_app(f)).get("/partials/profit")
    assert "سود واقعی دیروز" in r.text and "فرض‌های تأییدنشده" in r.text and "تخمین جایگزین" not in r.text


def test_today_page_falls_back_to_estimate_when_scope_missing():
    f = make_factory()
    with f() as s:
        s.add(ApiCallLog(called_at=NOW, endpoint="/open-api/v1/orders/history", status=403, duration_ms=1))
        s.commit()
    r = client(make_app(f)).get("/partials/profit")
    assert "دسترسی «order» به توکن داده نشده" in r.text and "آمار فروش هنوز خوانده نشده" in r.text


# ---------- CLI ----------
def test_orders_sync_cli_rejects_bad_days(monkeypatch, tmp_path):
    from sudyar import __main__ as cli
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw")
    assert cli.main(["orders-sync", "--days", "0"]) == 2
    assert cli.main(["orders-sync", "--days", "99"]) == 2


def test_orders_show_is_in_usage_and_bat_is_read_only():
    from sudyar import __main__ as m

    assert "orders-show" in m.USAGE
    bat = (pathlib.Path(__file__).resolve().parent.parent / "9-orders-sync.bat").read_text()
    assert "orders-sync --days 1" in bat and "orders-show" in bat
    assert "DELETE" not in bat.upper()


def test_order_status_object_from_the_real_panel_shape():
    """Real item shape seen on the seller panel: order_status / sell_type are {key, title}; created_at has +03:30."""
    s = Settings(digikala_self_token="t", postgres_password="p")
    base = {"product_variant_id": 73442722, "quantity": 2, "unit_price": 14433800, "unit_discount": 0,
            "total_price": 28867600, "order_created_at": "2026-11-15T00:59:02+03:30", "sell_type": {"key": "b2c"}}
    ok = parse_order_line({**base, "order_status": {"key": "processed", "title": "x"}}, "processed", s)
    assert ok == (date(2026, 11, 15), "73442722", 2, 14433800)
    assert parse_order_line({**base, "order_status": {"key": "canceled"}}, "processed", s) is None
    assert parse_order_line({**base, "order_status": {"key": "returned"}}, "processed", s) is None
    assert parse_order_line({**base, "order_status": {"key": "returned"}}, "returned", s)[2] == -2
