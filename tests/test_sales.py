from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import func, select

from shapes import sales_item as si, sales_page
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.models import FeeCache, ProductSales
from sudyar.rate_limiter import ApiError
from sudyar.sales import load_sales, parse_sales_row, sales_synced_at, sync_sales

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def settings(**kw):
    return Settings(digikala_self_token="tok-sales-secret", postgres_password="pw", page_size=2, **kw)


def mk(handler, s, make_limiter, retries=None):
    lim = make_limiter(requests=1000)
    if retries is not None:
        lim.cfg.max_retries = retries
    return DigikalaClient(s, lim, transport=httpx.MockTransport(handler))


def test_parse_sales_row():
    r = parse_sales_row(si(123, 40, 4_000_000, 30, 900, 3.3))
    assert r == {"product_id": "123", "net_item_sold": 40, "net_sales_amount": 4_000_000, "order_count": 30,
                 "visit_count": 900, "conversion_rate": 3.3}
    assert parse_sales_row({"product_id": None}) is None
    r = parse_sales_row({"product_id": 1, "net_item_sold": None, "conversion_rate": "x"})
    assert r["net_item_sold"] is None and r["conversion_rate"] is None


async def test_single_call_sends_only_range(session, make_limiter):
    s = settings()
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=sales_page([si(1, 10), si(2, 0)]))

    async with mk(handler, s, make_limiter) as c:
        r = await sync_sales(c, session, s, "last_30_days", NOW)
    q = seen[0]
    assert q.method == "GET" and q.url.path == "/open-api/v1/insight/sales-reports"
    assert dict(q.url.params) == {"range": "last_30_days"}              # no unverified paging params on page 1
    assert q.headers["authorization"] == "Bearer tok-sales-secret"
    assert (r.rows, r.pages, r.cached) == (2, 1, False)
    assert load_sales(session, "last_30_days")["1"].net_item_sold == 10


async def test_follows_pager_and_passes_category(session, make_limiter):
    s = settings()
    seen = []

    def handler(request):
        seen.append(request)
        p = int(request.url.params.get("page", 1))
        return httpx.Response(200, json=sales_page([si(p * 10)], p, 3))

    async with mk(handler, s, make_limiter) as c:
        r = await sync_sales(c, session, s, "last_7_days", NOW, category_id="101")
    assert r.pages == 3 and r.rows == 3
    assert [q.url.params.get("page") for q in seen] == [None, "2", "3"]
    assert all(q.url.params["category_id"] == "101" and q.url.params["range"] == "last_7_days" for q in seen)
    assert sales_synced_at(session, "last_7_days") is None              # partial (category) read is not "cached"


async def test_bounded_by_max_pages(session, make_limiter):
    s = settings(sales_max_pages=2)
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json=sales_page([si(len(seen))], len(seen), 9))

    async with mk(handler, s, make_limiter) as c:
        r = await sync_sales(c, session, s, "last_14_days", NOW)
    assert len(seen) == 2 and r.truncated and sales_synced_at(session, "last_14_days") is None


async def test_cached_for_24h_and_force(session, make_limiter):
    s = settings()
    calls = []
    t = lambda r: calls.append(r) or httpx.Response(200, json=sales_page([si(1, 5)]))
    async with mk(t, s, make_limiter) as c:
        await sync_sales(c, session, s, "last_30_days", NOW)
        r = await sync_sales(c, session, s, "last_30_days", NOW + timedelta(hours=23))
        assert r.cached and len(calls) == 1
        await sync_sales(c, session, s, "last_30_days", NOW + timedelta(hours=23), force=True)
        assert len(calls) == 2
        await sync_sales(c, session, s, "last_30_days", NOW + timedelta(hours=49))
        assert len(calls) == 3
        await sync_sales(c, session, s, "last_7_days", NOW)             # other range has its own cache
        assert len(calls) == 4


async def test_upsert_idempotent_never_deletes(session, make_limiter):
    s = settings()
    body = {"v": [si(1, 5), si(2, 7)]}
    async with mk(lambda r: httpx.Response(200, json=sales_page(body["v"])), s, make_limiter) as c:
        await sync_sales(c, session, s, "last_30_days", NOW)
        body["v"] = [si(1, 9)]
        await sync_sales(c, session, s, "last_30_days", NOW + timedelta(days=2))
    assert session.scalar(select(func.count()).select_from(ProductSales)) == 2
    assert session.get(ProductSales, ("1", "last_30_days")).net_item_sold == 9
    assert session.get(ProductSales, ("2", "last_30_days")).net_item_sold == 7


async def test_invalid_range_never_calls_api(session, make_limiter):
    s = settings()
    async with mk(lambda r: pytest.fail("no call expected"), s, make_limiter) as c:
        with pytest.raises(ValueError):
            await sync_sales(c, session, s, "last_90_days", NOW)
        with pytest.raises(ValueError):
            await c.get_sales_report_page("yesterday")


async def test_missing_scope_is_an_api_error_without_secrets(session, make_limiter):
    s = settings()
    async with mk(lambda r: httpx.Response(403), s, make_limiter, retries=0) as c:
        with pytest.raises(ApiError) as e:
            await sync_sales(c, session, s, "last_30_days", NOW)
    assert "403" in str(e.value) and "tok-sales-secret" not in str(e.value)


async def test_rows_without_product_id_rejected(session, make_limiter):
    s = settings()
    async with mk(lambda r: httpx.Response(200, json=sales_page([si(1), {"net_item_sold": 3}])), s, make_limiter) as c:
        r = await sync_sales(c, session, s, "last_30_days", NOW)
    assert r.rows == 1 and len(r.rejected) == 1
