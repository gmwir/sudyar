"""Read-only Digikala client. GET only; anything else raises."""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx

from .config import Settings
from .rate_limiter import ApiError, RateLimiter

log = logging.getLogger(__name__)

# Called for every API attempt: (endpoint, http_status_or_None, seconds)
CallLogger = Callable[[str, int | None, float], None]


class ReadOnlyViolation(Exception):
    """Something tried to use a non-GET method. This project never writes to Digikala."""


def _guard_get_only(request: httpx.Request) -> None:
    if request.method.upper() != "GET":
        raise ReadOnlyViolation(f"Blocked {request.method}: only GET is allowed.")


class DigikalaClient:
    def __init__(
        self,
        settings: Settings,
        limiter: RateLimiter,
        call_logger: CallLogger | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.settings = settings
        self.limiter = limiter
        self.call_logger = call_logger
        token = settings.digikala_self_token.get_secret_value()
        # Token lives only in this header; it is never logged.
        self._http = httpx.AsyncClient(
            base_url=settings.base_url,
            headers={settings.auth_header: f"{settings.auth_prefix}{token}"},
            timeout=30,
            transport=transport,
            event_hooks={"request": [_async_guard]},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "DigikalaClient":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def _request(self, method: str, path: str, params: dict | None = None) -> dict[str, Any]:
        if method.upper() != "GET":
            raise ReadOnlyViolation(f"Blocked {method}: only GET is allowed.")

        async def send() -> httpx.Response:
            return await self._http.request("GET", path, params=params)

        def on_call(status: int | None, seconds: float) -> None:
            log.info("GET %s -> %s (%.2fs)", path, status, seconds)
            if self.call_logger:
                self.call_logger(path, status, seconds)

        resp = await self.limiter.execute(send, on_call)
        if resp.status_code >= 400:
            raise ApiError(f"GET {path} failed with status {resp.status_code}")
        return resp.json()

    async def get(self, path: str, params: dict | None = None) -> dict[str, Any]:
        return await self._request("GET", path, params)

    async def list_variants(self, max_pages: int = 10_000) -> AsyncIterator[dict[str, Any]]:
        """Yield every variant (raw dict), page by page."""
        s = self.settings
        if not s.variants_path:
            raise ApiError("DIGIKALA_VARIANTS_PATH is not set (TODO: take it from the Swagger).")
        for page in range(1, max_pages + 1):
            data = await self.get(s.variants_path, {s.page_param: page, s.page_size_param: s.page_size})
            items = _dig(data, s.items_key)
            if not isinstance(items, list):
                raise ApiError(f"Response has no list at '{s.items_key}' (TODO: check Swagger).")
            for item in items:
                yield item
            if len(items) < s.page_size:
                return


async def _async_guard(request: httpx.Request) -> None:
    _guard_get_only(request)


def _dig(data: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
    return data
