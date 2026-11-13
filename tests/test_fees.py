from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import func, select

from shapes import commission_item as ci, commissions_page
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import (FEE_ASSUMED_MAX_BRAND, FEE_BRAND_ROW, FEE_CATEGORY_ROW, FeeProvider, list_brands,
                         parse_commission_row, sync_commissions)
from sudyar.models import Commission, FeeCache
from sudyar.rate_limiter import ApiError

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def settings(**kw):
    return Settings(digikala_self_token="tok-fee-secret", postgres_password="pw", page_size=2, **kw)


def client_for(handler, s, make_limiter):
    return DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(handler))


def test_parse_row_fields_and_fraction():
    row, why = parse_commission_row(ci(category_id=101, brand_id=5, commission=0.03, extra=0.01, return_free=0.02))
    assert why == "" and row["commission"] == 0.03 and row["extra_commission"] == 0.01
    assert row["return_free_commission"] == 0.02 and row["current_lead_time"] == 2
    assert row["category_id"] == "101" and row["brand_id"] == "5" and row["main_category_id"] == "10"


@pytest.mark.parametrize("item,why", [
    (ci(category_id=None), "category_id missing"),
    (ci(commission=3), "not a fraction"),              # 3 would be "3%", not a fraction: refuse, don't reinterpret
    (ci(commission=None), "not a fraction"),
    (ci(commission="abc"), "not a fraction"),
    (ci(extra=1.5), "extra_commission"),
    (ci(return_free=-0.1), "return_free_commission"),
])
def test_parse_row_rejects_non_fractions(item, why):
    row, reason = parse_commission_row(item)
    assert row is None and why in reason


def test_parse_row_optional_fields():
    row, _ = parse_commission_row(ci(brand_id=None, extra=None, return_free=None))
    assert row["brand_id"] is None and row["extra_commission"] is None and row["return_free_commission"] is None


async def test_sync_paginates_and_replaces(session, make_limiter):
    s = settings()
    seen = []
    pages = {1: [ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.05)], 2: [ci(102, 7, "C", 0.04)]}

    def handler(request):
        seen.append(request)
        p = int(request.url.params["page"])
        return httpx.Response(200, json=commissions_page(pages[p], p, 2))

    async with client_for(handler, s, make_limiter) as c:
        r = await sync_commissions(c, session, s, NOW)
        assert (r.rows, r.pages, r.rejected) == (3, 2, [])
        await sync_commissions(c, session, s, NOW + timedelta(days=2))        # idempotent: replaced, not duplicated
    assert session.scalar(select(func.count()).select_from(Commission)) == 3
    first = seen[0]
    assert first.method == "GET" and first.url.path == "/open-api/v1/commissions/"
    assert first.url.params["sort"] == "id" and first.url.params["page"] == "1" and first.url.params["size"] == "2"
    assert "search[my_commissions]" not in first.url.params and "search[main_category_id]" not in first.url.params
    assert first.headers["authorization"] == "Bearer tok-fee-secret"
    assert session.get(FeeCache, "commissions").data["rows"] == 3


async def test_sync_optional_search_params(session, make_limiter):
    s = settings(fees_only_my_commissions=True, fees_main_category_id="10")
    seen = []
    t = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json=commissions_page([ci()])))
    async with DigikalaClient(s, make_limiter(requests=100), transport=t) as c:
        await sync_commissions(c, session, s, NOW)
    assert seen[0].url.params["search[my_commissions]"] == "1" and seen[0].url.params["search[main_category_id]"] == "10"


async def test_sync_reports_rejected_rows(session, make_limiter):
    s = settings()
    t = httpx.MockTransport(lambda r: httpx.Response(200, json=commissions_page([ci(), ci(commission=3)])))
    async with DigikalaClient(s, make_limiter(requests=100), transport=t) as c:
        r = await sync_commissions(c, session, s, NOW)
    assert r.rows == 1 and len(r.rejected) == 1 and "page 1 item 2" in r.rejected[0]


async def test_failed_sync_keeps_old_rows(session, make_limiter):
    s = settings()
    async with client_for(lambda r: httpx.Response(200, json=commissions_page([ci()])), s, make_limiter) as c:
        await sync_commissions(c, session, s, NOW)
    lim = make_limiter(requests=100)
    lim.cfg.max_retries = 0
    async with DigikalaClient(s, lim, transport=httpx.MockTransport(lambda r: httpx.Response(403))) as c:
        with pytest.raises(ApiError):
            await sync_commissions(c, session, s, NOW + timedelta(days=2))
    async with client_for(lambda r: httpx.Response(200, json=commissions_page([ci(commission=3)])), s, make_limiter) as c:
        with pytest.raises(RuntimeError):
            await sync_commissions(c, session, s, NOW + timedelta(days=2))        # nothing usable -> keep old
    assert session.scalar(select(func.count()).select_from(Commission)) == 1


def seed(session, *rows):
    for r in rows:
        row, _ = parse_commission_row(r)
        session.add(Commission(fetched_at=NOW, **row))
    session.flush()


def test_lookup_single_row_is_category_row(session):
    seed(session, ci(101, 5, "A", 0.03))
    f = FeeProvider(None, settings()).lookup(session, "101", None)
    assert f.commission_pct == 3.0 and f.reason == FEE_CATEGORY_ROW


def test_lookup_several_brands_uses_highest_and_records_reason(session):
    seed(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08), ci(101, 7, "C", 0.05), ci(102, 9, "Z", 0.20))
    f = FeeProvider(None, settings()).lookup(session, "101", None)
    assert f.commission_pct == 8.0 and f.reason == FEE_ASSUMED_MAX_BRAND and f.brand_title == "B"


def test_lookup_known_brand_uses_that_row_even_if_lower(session):
    seed(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    f = FeeProvider(None, settings()).lookup(session, "101", "5")
    assert f.commission_pct == 3.0 and f.reason == FEE_BRAND_ROW


def test_lookup_unknown_brand_id_falls_back_to_max(session):
    seed(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    assert FeeProvider(None, settings()).lookup(session, "101", "999").reason == FEE_ASSUMED_MAX_BRAND


def test_lookup_missing_category_or_rows(session):
    seed(session, ci(101))
    p = FeeProvider(None, settings())
    assert p.lookup(session, None, None) is None and p.lookup(session, "555", None) is None


def test_extra_and_return_free_flags(session):
    seed(session, ci(101, 5, "A", 0.03, extra=0.01, return_free=0.02))
    assert FeeProvider(None, settings()).lookup(session, "101", None).commission_pct == 3.0        # default: commission only
    both = settings(floor_include_extra_commission=True, floor_include_return_free_commission=True)
    f = FeeProvider(None, both).lookup(session, "101", None)
    assert f.commission_pct == pytest.approx(6.0) and f.base_pct == 3.0 and f.extra_pct == 1.0 and f.return_free_pct == 2.0
    only_extra = settings(floor_include_extra_commission=True)
    assert FeeProvider(None, only_extra).lookup(session, "101", None).commission_pct == pytest.approx(4.0)


def test_max_brand_respects_flags(session):
    seed(session, ci(101, 5, "A", 0.05, extra=0.0), ci(101, 6, "B", 0.03, extra=0.04))
    assert FeeProvider(None, settings()).lookup(session, "101", None).brand_title == "A"
    assert FeeProvider(None, settings(floor_include_extra_commission=True)).lookup(session, "101", None).brand_title == "B"


def test_preload_matches_query(session):
    seed(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08))
    p = FeeProvider(None, settings())
    direct = p.lookup(session, "101", None)
    p.preload(session)
    assert p.lookup(session, "101", None) == direct


async def test_ensure_fresh_24h_cache_and_retry_throttle(session, make_limiter):
    s = settings()
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=commissions_page([ci()]))

    async with client_for(handler, s, make_limiter) as c:
        p = FeeProvider(c, s)
        await p.get(session, "101", None, NOW)
        await p.get(session, "101", None, NOW + timedelta(hours=23))
        assert len(calls) == 1                                           # fresh for 24 h
        await p.get(session, "101", None, NOW + timedelta(hours=25))
        assert len(calls) == 2
        await p.get(session, "101", None, NOW + timedelta(hours=30), allow_fetch=False)
        assert len(calls) == 2                                           # report mode never calls Digikala


async def test_failed_refresh_does_not_raise_and_is_throttled(session, make_limiter):
    s = settings()
    calls = []
    lim = make_limiter(requests=1000)
    lim.cfg.max_retries = 0

    def handler(request):
        calls.append(request)
        return httpx.Response(500)

    async with DigikalaClient(s, lim, transport=httpx.MockTransport(handler)) as c:
        p = FeeProvider(c, s)
        assert await p.get(session, "101", None, NOW) is None
        n = len(calls)
        await p.get(session, "101", None, NOW + timedelta(minutes=10))
        assert len(calls) == n                                           # not retried within an hour


def test_list_brands(session):
    seed(session, ci(101, 5, "A", 0.03), ci(101, 6, "B", 0.08), ci(102, 7, "C", 0.5))
    assert list_brands(session, "101") == [("6", "B", 8.0), ("5", "A", 3.0)]
