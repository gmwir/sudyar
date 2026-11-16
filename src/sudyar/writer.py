"""The ONLY way Sudyar changes anything on Digikala (Part 6).

Safety, in order:
1. WRITE_MODE=off (default): every write raises WriteDisabled before anything happens.
   WRITE_MODE=dry_run: the write is only recorded in write_log; nothing is sent.
   WRITE_MODE=live: sent, and still recorded in write_log (status, short error).
2. Only the operations in WRITE_OPS exist. Anything that can cancel/delete an order, cancel a shipment, archive or
   delete a product is NOT in the list and cannot be called (no method, no generic path).
3. Path parameters must be positive integers; the path is built here, never taken from input.
4. Payload keys are checked against the operation's allowed keys.
5. Tokens are only in the Authorization header and are never logged.
Field names/shapes come from the official Open API document (seller.digikala.com/open-api/v1/doc/, 283 APIs).
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy.orm import Session, sessionmaker

from .config import Settings
from .models import WriteLog, utcnow
from .rate_limiter import ApiError, RateLimiter

log = logging.getLogger(__name__)


class WriteDisabled(Exception):
    """WRITE_MODE=off: Sudyar never writes to Digikala."""


class WriteRefused(Exception):
    """The write is not allowed (unknown op, bad parameter, bad payload key)."""


@dataclass(frozen=True)
class WriteOp:
    method: str
    path: str  # template with {name} parameters (positive integers only)
    scope: str
    keys: frozenset[str]  # allowed top-level body keys
    item_keys: frozenset[str] = frozenset()  # allowed keys inside list items (data[] / items[].payload)


VARIANT_FIELDS = frozenset({"seller_stock", "maximum_per_order", "selling_price", "price_limit", "lead_time",
                            "seller_lead_time", "shipping_type", "three_hour_delivery"})
WRITE_OPS: dict[str, WriteOp] = {
    # PUT /variants/{variant_id}: price/stock/lead time of ONE variant. "activation" is deliberately not allowed.
    "variant_update": WriteOp("PUT", "/open-api/v1/variants/{variant_id}", "variant", VARIANT_FIELDS),
    "batch_variant_update": WriteOp("POST", "/open-api/v1/batch/variant/update", "variant",
                                    frozenset({"deadline", "items"}), VARIANT_FIELDS),
    "batch_stock_update": WriteOp("POST", "/open-api/v1/batch/variant/seller-stock/update", "variant",
                                  frozenset({"deadline", "items"}), frozenset({"seller_stock"})),
    "batch_inquiry": WriteOp("POST", "/open-api/v1/batch/inquiry", "self_settings", frozenset({"batch_id"})),
    "smart_discount_create": WriteOp("POST", "/open-api/v1/pricing/smart-discount/variants", "promotion",
                                     frozenset({"data"}),
                                     frozenset({"variantId", "promotionPrice", "limit", "orderLimit", "startedAt",
                                                "endAt"})),
    "promotion_join": WriteOp("POST", "/open-api/v1/pricing/promotions/{promotion_id}/variants", "promotion",
                              frozenset({"data"}),
                              frozenset({"variant_id", "promotion_price", "order_limit", "price_limit"})),
    "sbs_tracking_code": WriteOp("POST", "/open-api/v1/ship-by-seller-orders/tracking-code", "sbs_orders",
                                 frozenset({"order_shipment_id", "tracking_codes", "infra_type", "service_name"}),
                                 frozenset({"id", "tracking_code"})),
    "sbs_update_status": WriteOp("PUT", "/open-api/v1/ship-by-seller-orders/update-status", "sbs_orders",
                                 frozenset({"order_shipment_id", "new_status"})),
    "sbs_batch_update_status": WriteOp("POST", "/open-api/v1/ship-by-seller-orders/batch-update-status",
                                       "sbs_orders", frozenset({"order_shipment_ids", "new_status"})),
}
# Statuses Sudyar may set on a ship-by-seller shipment. "full_delivered_to_customer" needs the customer's code and
# is left to the seller panel.
SBS_STATUSES = ("processing", "processed")
FORBIDDEN_WORDS = ("cancel", "delete", "archive", "revoke", "unsubscription")


def build_path(op: WriteOp, params: dict[str, Any]) -> str:
    path = op.path
    for name in [p.split("}")[0] for p in op.path.split("{")[1:]]:
        v = params.get(name)
        if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
            raise WriteRefused(f"{name} must be a positive integer")
        path = path.replace("{" + name + "}", str(v))
    return path


def check_payload(name: str, op: WriteOp, body: dict[str, Any]) -> None:
    extra = set(body) - op.keys
    if extra:
        raise WriteRefused(f"{name}: field(s) not allowed: {', '.join(sorted(extra))}")
    for key in ("items", "data", "tracking_codes"):
        for it in body.get(key) or []:
            if not isinstance(it, dict):
                raise WriteRefused(f"{name}: {key} items must be objects")
            inner = it.get("payload") if key == "items" else it
            if key == "items" and set(it) - {"variant_id", "payload"}:
                raise WriteRefused(f"{name}: items may only have variant_id and payload")
            bad = set(inner or {}) - op.item_keys
            if bad:
                raise WriteRefused(f"{name}: item field(s) not allowed: {', '.join(sorted(bad))}")
    if name in ("sbs_update_status", "sbs_batch_update_status") and body.get("new_status") not in SBS_STATUSES:
        raise WriteRefused("new_status must be processing or processed")


class DigikalaWriter:
    def __init__(self, settings: Settings, limiter: RateLimiter, factory: sessionmaker[Session],
                 transport: httpx.AsyncBaseTransport | None = None,
                 token_provider: Callable[[], str] | None = None):
        self.s = settings
        self.limiter = limiter
        self.factory = factory
        self._token_provider = token_provider
        headers = {"content-type": "application/json"}
        if token_provider is None:
            headers[settings.auth_header] = f"{settings.auth_prefix}{settings.digikala_self_token.get_secret_value()}"
        self._http = httpx.AsyncClient(base_url=settings.base_url, headers=headers, timeout=30, transport=transport)

    @property
    def mode(self) -> str:
        return self.s.write_mode

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "DigikalaWriter":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    def _log(self, **kw) -> int:
        with self.factory() as session:
            row = WriteLog(ts=utcnow(), **kw)
            session.add(row)
            session.commit()
            return row.id

    async def write(self, name: str, body: dict[str, Any], *, params: dict[str, Any] | None = None,
                    target: str | None = None, source: str = "manual") -> dict[str, Any]:
        """Run one allowed write. Returns the JSON response ({"dry_run": True} in dry-run)."""
        if self.mode == "off":
            raise WriteDisabled("WRITE_MODE is off: Sudyar does not change anything on Digikala.")
        op = WRITE_OPS.get(name)
        if op is None:
            raise WriteRefused(f"unknown write operation: {name}")
        path = build_path(op, params or {})
        check_payload(name, op, body)
        if self.mode == "dry_run":
            self._log(op=name, target=target, mode="dry_run", payload=body, ok=True, source=source)
            log.info("DRY-RUN %s %s", op.method, path)
            return {"dry_run": True}

        async def send() -> httpx.Response:
            headers = None
            if self._token_provider is not None:
                tok = await asyncio.to_thread(self._token_provider)
                headers = {self.s.auth_header: f"{self.s.auth_prefix}{tok}"}
            return await self._http.request(op.method, path, json=body, headers=headers)

        def on_call(status: int | None, seconds: float) -> None:
            log.info("%s %s -> %s (%.2fs)", op.method, path, status, seconds)

        try:
            resp = await self.limiter.execute(send, on_call)
        except Exception as e:
            self._log(op=name, target=target, mode="live", payload=body, ok=False, error=type(e).__name__[:300],
                      source=source)
            raise
        ok = resp.status_code < 400
        err = None
        if not ok:
            try:
                j = resp.json()
                err = str(j.get("message") or j.get("errors") or "")[:300]
            except ValueError:
                err = f"HTTP-{resp.status_code}"
        self._log(op=name, target=target, mode="live", payload=body, http_status=resp.status_code, ok=ok, error=err,
                  source=source)
        if not ok:
            raise ApiError(f"{op.method} {path} failed with status {resp.status_code}: {err or ''}"[:300])
        try:
            return resp.json()
        except ValueError:
            return {}
