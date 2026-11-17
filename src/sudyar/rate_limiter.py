"""One limiter shared by every API call.

- token bucket (default 30 requests / 30 s)
- max concurrent requests (default 3)
- exponential backoff + jitter on 429 / 5xx, honoring Retry-After
- circuit breaker: after N consecutive 429s, pause everything (default 5 min)
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)


class ApiError(Exception):
    """Request failed even after retries."""


@dataclass
class LimiterConfig:
    requests: int = 30
    period_seconds: float = 30
    max_concurrent: int = 3
    max_retries: int = 5
    backoff_base: float = 1.0
    backoff_max: float = 60
    breaker_threshold: int = 3
    breaker_pause: float = 300


class RateLimiter:
    def __init__(
        self,
        cfg: LimiterConfig | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
    ):
        self.cfg = cfg or LimiterConfig()
        self._clock, self._sleep, self._jitter = clock, sleep, jitter
        self._tokens = float(self.cfg.requests)
        self._last = clock()
        self._bucket_lock = asyncio.Lock()
        self._sem = asyncio.Semaphore(self.cfg.max_concurrent)
        self._consecutive_429 = 0
        self._paused_until = 0.0
        self._active = 0
        self.max_active_seen = 0

    # --- token bucket ---
    async def _take_token(self) -> None:
        async with self._bucket_lock:
            while True:
                now = self._clock()
                rate = self.cfg.requests / self.cfg.period_seconds
                self._tokens = min(self.cfg.requests, self._tokens + (now - self._last) * rate)
                self._last = now
                if self._tokens >= 1:
                    self._tokens -= 1
                    return
                await self._sleep((1 - self._tokens) / rate)

    # --- circuit breaker ---
    async def _wait_if_paused(self) -> None:
        while (remaining := self._paused_until - self._clock()) > 0:
            await self._sleep(remaining)

    def _note_status(self, status: int) -> None:
        if status == 429:
            self._consecutive_429 += 1
            if self._consecutive_429 >= self.cfg.breaker_threshold:
                self._paused_until = self._clock() + self.cfg.breaker_pause
                self._consecutive_429 = 0
                log.warning("Too many 429 responses: pausing all calls for %ss", self.cfg.breaker_pause)
        else:
            self._consecutive_429 = 0

    # --- backoff ---
    def backoff_delay(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(max(float(retry_after), 0.0), self.cfg.backoff_max)
            except ValueError:
                pass  # HTTP-date form: fall back to exponential
        expo = min(self.cfg.backoff_max, self.cfg.backoff_base * (2**attempt))
        return expo / 2 + self._jitter() * expo / 2

    async def execute(
        self,
        send: Callable[[], Awaitable[httpx.Response]],
        on_call: Callable[[int | None, float], None] | None = None,
    ) -> httpx.Response:
        """Run `send` under all limits. `on_call(status, seconds)` fires per attempt."""
        for attempt in range(self.cfg.max_retries + 1):
            await self._wait_if_paused()
            await self._take_token()
            async with self._sem:
                self._active += 1
                self.max_active_seen = max(self.max_active_seen, self._active)
                start = self._clock()
                status: int | None = None
                resp: httpx.Response | None = None
                try:
                    resp = await send()
                    status = resp.status_code
                except httpx.TransportError:
                    status = None
                finally:
                    self._active -= 1
                    if on_call:
                        on_call(status, self._clock() - start)
            if status is not None:
                self._note_status(status)
            retryable = status is None or status == 429 or status >= 500
            if not retryable:
                return resp  # type: ignore[return-value]
            if attempt == self.cfg.max_retries:
                break
            retry_after = resp.headers.get("Retry-After") if resp is not None else None
            await self._sleep(self.backoff_delay(attempt, retry_after))
        raise ApiError(f"Request failed after {self.cfg.max_retries + 1} attempts (last status: {status})")
