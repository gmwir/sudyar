"""Read-only Digikala client. GET only; anything else raises."""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx

from .config import Settings
from .rate_limiter import ApiError, RateLimiter

log = logging.getLogger(__name__)

SALES_RANGES = ("last_7_days", "last_14_days", "last_30_days")

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
            headers={
                settings.auth_header: f"{settings.auth_prefix}{token}",
                "content-type": "application/json",
            },
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
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            # an absolute URL here would send the Bearer token to another host
            raise ValueError("API path must start with a single '/' (no host)")

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

    async def get_page(self, path: str, params: dict[str, Any]) -> tuple[list[dict[str, Any]], int | None]:
        """One GET -> (items at data.items, total_pages from data.pager or None)."""
        s = self.settings
        data = await self.get(path, params)
        items = _dig(data, s.items_key)
        if not isinstance(items, list):
            raise ApiError(f"Response has no list at '{s.items_key}'.")
        pager = _dig(data, s.pager_key)
        total = pager.get("total_pages") if isinstance(pager, dict) else None
        return items, total if isinstance(total, int) else None

    async def get_variants_page(self, page: int) -> tuple[list[dict[str, Any]], int | None]:
        """One page of variants -> (items, total_pages or None if the response has no pager)."""
        s = self.settings
        if not s.variants_path:
            raise ApiError("DIGIKALA_VARIANTS_PATH is not set.")
        params = {**s.variants_extra_params, s.page_param: page, s.page_size_param: s.page_size}
        return await self.get_page(s.variants_path, params)

    async def get_commissions_page(self, page: int) -> tuple[list[dict[str, Any]], int | None]:
        """GET /open-api/v1/commissions/ (scope: commission). Params: page, size, sort=id."""
        s = self.settings
        params: dict[str, Any] = {s.page_param: page, s.page_size_param: s.page_size, "sort": "id"}
        if s.fees_only_my_commissions:  # UNVERIFIED semantics: only sent when you turn it on
            params["search[my_commissions]"] = 1
        if s.fees_main_category_id:
            params["search[main_category_id]"] = s.fees_main_category_id
        return await self.get_page(s.commissions_path, params)

    async def get_sales_report_page(self, range_: str, page: int | None = None,
                                    category_id: str | None = None) -> tuple[list[dict[str, Any]], int | None]:
        """GET /open-api/v1/insight/sales-reports (scope: insight). `range` is required.

        page/size are only sent for page 2+ (the Swagger lists no paging params for this endpoint).
        """
        if range_ not in SALES_RANGES:
            raise ValueError(f"range must be one of {', '.join(SALES_RANGES)}")
        params: dict[str, Any] = {"range": range_}
        if category_id:
            params["category_id"] = category_id
        if page is not None and page > 1:
            params[self.settings.page_param] = page
            params[self.settings.page_size_param] = self.settings.page_size
        return await self.get_page(self.settings.sales_reports_path, params)

    async def list_variants(self, max_pages: int = 10_000) -> AsyncIterator[dict[str, Any]]:
        """Yield every variant (raw dict), page by page."""
        for page in range(1, max_pages + 1):
            items, total_pages = await self.get_variants_page(page)
            for item in items:
                yield item
            if total_pages is not None:
                if page >= total_pages:
                    return
            elif len(items) < self.settings.page_size:  # no pager: short-page detection
                return

    async def get_winning_price(self, product_variant_id: int | str) -> int | None:
        """GET winning-price -> data.suggested_price (integer, Rial per Swagger; may be None)."""
        data = await self.get(
            self.settings.buybox_price_path, {"product_variant_id": product_variant_id}
        )
        return _suggested_price(data)

    async def get_nth_rank_winning_price(
        self, product_variant_id: int | str, target_rank: int
    ) -> int | None:
        """GET nth-rank-winning-price -> data.suggested_price (may be None)."""
        data = await self.get(
            self.settings.nth_rank_price_path,
            {"product_variant_id": product_variant_id, "target_rank": target_rank},
        )
        return _suggested_price(data)


def _suggested_price(data: dict[str, Any]) -> int | None:
    v = _dig(data, "data.suggested_price")
    return None if v is None else int(v)


async def _async_guard(request: httpx.Request) -> None:
    _guard_get_only(request)


def _dig(data: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        if not isinstance(data, dict):
            return None
        data = data.get(part)
    return data
