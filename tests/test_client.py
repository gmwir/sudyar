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
        return httpx.Response(200, json={"items": pages.get(page, [])})
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


async def test_pagination_stops_on_empty_exact_page(settings, make_limiter):
    pages = {1: [{"id": 1}, {"id": 2}]}  # full page, then empty page 2
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
        return httpx.Response(code, json={"items": []}, headers={"Retry-After": "1"})

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
        return httpx.Response(200, json={"items": []})

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
