import asyncio

import httpx
import pytest

from sudyar.rate_limiter import ApiError


def ok():
    async def send():
        return httpx.Response(200, json={})
    return send


async def test_token_bucket_blocks_after_burst(ft, make_limiter):
    lim = make_limiter(requests=3, period_seconds=30)
    for _ in range(3):
        await lim.execute(ok())
    assert ft.sleeps == []          # burst of 3 is free
    await lim.execute(ok())
    assert ft.sleeps and ft.now == pytest.approx(10.0)  # 1 token per 10 s


async def test_default_is_30_per_30s(ft, make_limiter):
    lim = make_limiter()
    for _ in range(31):
        await lim.execute(ok())
    assert ft.now == pytest.approx(1.0)


async def test_429_backoff_exponential_and_succeeds(ft, make_limiter):
    lim = make_limiter(backoff_base=1.0, breaker_threshold=99)
    codes = iter([429, 429, 200])

    async def send():
        return httpx.Response(next(codes))

    resp = await lim.execute(send)
    assert resp.status_code == 200
    assert ft.sleeps == [0.5, 1.0]  # delay = expo/2 + jitter*expo/2, jitter=0: doubles each time


async def test_retry_after_honored(ft, make_limiter):
    lim = make_limiter(breaker_threshold=99)
    codes = iter([429, 200])

    async def send():
        r = httpx.Response(next(codes), headers={"Retry-After": "7"})
        return r

    await lim.execute(send)
    assert ft.sleeps == [7.0]


async def test_5xx_retried_then_gives_up(ft, make_limiter):
    lim = make_limiter(max_retries=2, breaker_threshold=99)
    calls = 0

    async def send():
        nonlocal calls
        calls += 1
        return httpx.Response(503)

    with pytest.raises(ApiError):
        await lim.execute(send)
    assert calls == 3


async def test_circuit_breaker_pauses_5_minutes(ft, make_limiter):
    lim = make_limiter(breaker_threshold=3, breaker_pause=300, backoff_base=0.001, requests=1000)
    codes = iter([429, 429, 429, 200])

    async def send():
        return httpx.Response(next(codes))

    await lim.execute(send)
    assert any(s >= 299 for s in ft.sleeps)  # 3rd 429 pauses ~5 min


async def test_max_concurrency(make_limiter):
    lim = make_limiter(max_concurrent=3, requests=1000)
    # use real sleep inside send to overlap tasks
    async def send():
        await asyncio.sleep(0.01)
        return httpx.Response(200)

    await asyncio.gather(*(lim.execute(send) for _ in range(10)))
    assert lim.max_active_seen == 3
