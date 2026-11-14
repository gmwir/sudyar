"""Part 3g: an auto-refresh that brings in an orphan commission row must fail closed in the SAME call."""
from datetime import datetime, timedelta, timezone

import httpx

from shapes import commission_item as ci, commissions_page
from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient
from sudyar.fees import FeeProvider, parse_commission_row
from sudyar.floor import FloorEngine, set_floor_rule
from sudyar.models import Commission, FeeCache, Variant

NOW = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)


def mkvar(session):
    v = Variant(digikala_variant_id="1", product_variant_id="pv1", product_id="p1", price_sale=10_000_000,
                stock=5, active=True, raw_json={"category_id": "101"})
    session.add(v)
    session.flush()
    return v


def seed_old_good_data(session):
    row, _ = parse_commission_row(ci(101, None, None, 0.10))
    session.add(Commission(fetched_at=NOW, **row))
    session.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=NOW))
    session.flush()


def provider(make_limiter, items):
    s = Settings(digikala_self_token="t", postgres_password="p", page_size=1000)
    client = DigikalaClient(s, make_limiter(requests=100_000),
                            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=commissions_page(items))))
    return s, FeeProvider(client, s)


async def test_manual_floor_no_cost_refresh_brings_orphan_is_needs_fees_same_call(session, make_limiter):
    v = mkvar(session)
    seed_old_good_data(session)                                   # 2 days old: stale for refresh (>24h), still usable
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    s, fp = provider(make_limiter, [ci(101, None, None, 0.10), ci(None, 5, "X", 0.30)])
    async with fp.client:
        r = await FloorEngine(s, fp).evaluate(session, v, NOW + timedelta(days=2), allow_fetch=True)
    assert r.status == "needs_fees" and r.floor_toman is None


async def test_manual_floor_no_cost_refresh_clean_still_ok(session, make_limiter):
    v = mkvar(session)
    seed_old_good_data(session)
    set_floor_rule(session, "global", floor_manual_toman=800_000)
    s, fp = provider(make_limiter, [ci(101, None, None, 0.10)])
    async with fp.client:
        r = await FloorEngine(s, fp).evaluate(session, v, NOW + timedelta(days=2), allow_fetch=True)
    assert r.status == "ok" and r.floor_toman == 800_000


async def test_ensure_fresh_clears_partial_cache(session, make_limiter):
    seed_old_good_data(session)
    s, fp = provider(make_limiter, [ci(101, None, None, 0.10), ci(None, 5, "X", 0.30)])
    fp._partial_cache = set()                                     # stale in-memory "all clear"
    async with fp.client:
        await fp.ensure_fresh(session, NOW + timedelta(days=2))
    assert fp.all_incomplete(session) is True
