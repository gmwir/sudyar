import logging

import httpx
import pytest

from conftest import TOKEN
from sudyar.digikala_client import DigikalaClient, ReadOnlyViolation
from sudyar.rate_limiter import ApiError


def pages_handler(pages, seen=None):
    def handler(request: httpx.Request):
        if seen is not None:
            seen.append(request)
        page = int(request.url.params["page"])
        items = pages.get(page, [])
        total = max(pages) if pages else 1
        return httpx.Response(200, json={"data": {"items": items, "pager": {
            "page": page, "item_per_page": 2, "total_pages": total, "total_rows": 99}}})
    return handler


async def collect(client):
    return [v async for v in client.list_variants()]


async def test_pagination_reads_all_pages(settings, make_limiter):
    pages = {1: [{"id": 1}, {"id": 2}], 2: [{"id": 3}, {"id": 4}], 3: [{"id": 5}]}
    seen = []
    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(pages_handler(pages, seen))) as c:
        items = await collect(c)
    assert [i["id"] for i in items] == [1, 2, 3, 4, 5]
    assert len(seen) == 3 and all(r.method == "GET" for r in seen)


async def test_pagination_stops_at_total_pages(settings, make_limiter):
    pages = {1: [{"id": 1}, {"id": 2}]}  # full page but pager says 1 page total -> no page 2 call
    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(pages_handler(pages))) as c:
        assert len(await collect(c)) == 2


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
async def test_non_get_is_blocked(settings, make_limiter, method):
    def handler(request):
        raise AssertionError("must never reach the network")
    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(handler)) as c:
        with pytest.raises(ReadOnlyViolation):
            await c._request(method, "/variants")
        # second line of defense: the raw http layer also refuses
        with pytest.raises(ReadOnlyViolation):
            await c._http.request(method, "/variants")


async def test_429_then_success_through_client(settings, make_limiter):
    codes = iter([429, 200])

    def handler(request):
        code = next(codes)
        return httpx.Response(code, json={"data": {"items": [], "pager": {"total_pages": 1}}}, headers={"Retry-After": "1"})

    logged = []
    async with DigikalaClient(settings, make_limiter(), lambda *a: logged.append(a), httpx.MockTransport(handler)) as c:
        assert await collect(c) == []
    assert [s for _, s, _ in logged] == [429, 200]  # every attempt is recorded


async def test_missing_path_raises(settings, make_limiter):
    settings.variants_path = ""
    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(lambda r: httpx.Response(200))) as c:
        with pytest.raises(ApiError):
            await collect(c)


async def test_token_sent_but_never_logged(settings, make_limiter, caplog):
    caplog.set_level(logging.DEBUG)
    headers = {}

    def handler(request):
        headers.update(request.headers)
        return httpx.Response(200, json={"data": {"items": [], "pager": {"total_pages": 1}}})

    async with DigikalaClient(settings, make_limiter(max_retries=0), transport=httpx.MockTransport(handler)) as c:
        await collect(c)
    assert TOKEN in headers["authorization"]
    assert TOKEN not in caplog.text
    assert TOKEN not in repr(settings)
    assert TOKEN not in settings.model_dump_json()


async def test_token_not_logged_on_failure(settings, make_limiter, caplog):
    caplog.set_level(logging.DEBUG)
    async with DigikalaClient(settings, make_limiter(max_retries=0), transport=httpx.MockTransport(lambda r: httpx.Response(500))) as c:
        with pytest.raises(ApiError) as e:
            await collect(c)
    assert TOKEN not in caplog.text and TOKEN not in str(e.value)


async def test_pagination_without_pager_uses_short_page(settings, make_limiter):
    seen = []

    def handler(request):
        seen.append(request)
        page = int(request.url.params["page"])
        return httpx.Response(200, json={"data": {"items": [{"id": 1}, {"id": 2}] if page == 1 else [{"id": 3}]}})

    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(handler)) as c:
        assert len(await collect(c)) == 3
    assert len(seen) == 2


async def test_request_shape_and_headers(settings, make_limiter):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"items": [], "pager": {"total_pages": 1}}})

    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(handler)) as c:
        await collect(c)
    r = seen[0]
    assert r.method == "GET"
    assert str(r.url).startswith("https://seller.digikala.com/open-api/v1/variants?")
    assert r.url.params["page"] == "1" and r.url.params["size"] == "2"
    assert r.headers["authorization"] == f"Bearer {TOKEN}"
    assert r.headers["content-type"] == "application/json"


async def test_get_winning_price(settings, make_limiter):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"suggested_price": 1234500}})

    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(handler)) as c:
        assert await c.get_winning_price(555) == 1234500
    r = seen[0]
    assert r.method == "GET"
    assert r.url.path == "/open-api/v1/pricing/buybox/price-suggestion/winning-price"
    assert r.url.params["product_variant_id"] == "555"


async def test_get_winning_price_null(settings, make_limiter):
    t = httpx.MockTransport(lambda r: httpx.Response(200, json={"data": {"suggested_price": None}}))
    async with DigikalaClient(settings, make_limiter(), transport=t) as c:
        assert await c.get_winning_price(1) is None


async def test_get_nth_rank_winning_price(settings, make_limiter):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"data": {"suggested_price": 900}})

    async with DigikalaClient(settings, make_limiter(), transport=httpx.MockTransport(handler)) as c:
        assert await c.get_nth_rank_winning_price(7, 3) == 900
    r = seen[0]
    assert r.method == "GET"
    assert r.url.path == "/open-api/v1/pricing/buybox/price-suggestion/nth-rank-winning-price"
    assert r.url.params["product_variant_id"] == "7" and r.url.params["target_rank"] == "3"


async def test_new_methods_go_through_rate_limiter(settings, make_limiter, ft):
    lim = make_limiter(requests=1, period_seconds=10)
    t = httpx.MockTransport(lambda r: httpx.Response(200, json={"data": {"suggested_price": 1}}))
    async with DigikalaClient(settings, lim, transport=t) as c:
        await c.get_winning_price(1)
        await c.get_nth_rank_winning_price(1, 2)
    assert ft.now == pytest.approx(10.0)
