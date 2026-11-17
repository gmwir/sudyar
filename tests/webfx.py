"""Fake database + app factory for the web tests (in-memory SQLite, no network)."""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, pool
from sqlalchemy.orm import sessionmaker

from sudyar.config import Settings
from sudyar.floor import set_floor_rule
from sudyar.models import (ApiCallLog, Base, Commission, FeeCache, ProductSales, RadarEvent, Variant, VariantCost,
                           VariantSnapshot)
from sudyar.web.app import create_app

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)  # 15:30 Tehran, 23 Aban 1405
TOKEN = "TOKEN-SECRET-should-never-appear-9f3a"
PASSWORD = "correct horse battery"


def make_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=pool.StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


def make_settings(**kw):
    return Settings(**{"digikala_self_token": TOKEN, "postgres_password": "pw-secret-xyz", **kw})


def make_app(factory=None, settings=None, **kw):
    kw.setdefault("cache_seconds", 0)
    kw.setdefault("now_fn", lambda: NOW)
    return create_app(settings or make_settings(), factory or make_factory(), **kw)


def client(app, **kw):
    return TestClient(app, **kw)


def variant(s, vid, title, *, product="p1", category="101", price=12_100_000, bb=11_900_000, win=False, stock=5,
            challenge=False, active=True, cause_event=None):
    v = Variant(digikala_variant_id=vid, product_variant_id=f"pv{vid}", product_id=product, title=title, price_sale=price,
                buy_box_price=bb, is_seller_buy_box_winner=win, is_in_buy_box_challenge=challenge, stock=stock,
                marketplace_seller_stock=stock, active=active, raw_json={"category_id": category})
    s.add(v)
    s.flush()
    s.add(VariantSnapshot(variant_id=v.id, taken_at=NOW - timedelta(minutes=2), price_sale=price, buy_box_price=bb,
                          is_seller_buy_box_winner=win, is_in_buy_box_challenge=challenge, stock=stock, active=active))
    return v


def seed(factory):
    """v1 lost the Buy Box (HOT, has cost), v2 wins (no cost), v3 has a cost but its category has no commission row."""
    with factory() as s:
        s.add(Commission(category_id="101", commission=0.10, fetched_at=NOW))
        s.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=NOW))
        set_floor_rule(s, "global", margin_pct=10)
        v1 = variant(s, "1001", "فیلتر روغن پژو ۲۰۶ تیپ ۲", product="p1", win=False)
        v2 = variant(s, "1002", "لنت ترمز جلو پراید ۱۳۱", product="p2", price=8_900_000, bb=8_900_000, win=True)
        v3 = variant(s, "1003", "تسمه تایم رنو تندر", product="p3", category="999", price=17_500_000, bb=None, win=None)
        s.add(VariantCost(variant_id=v1.id, buy_cost=1_000_000, source="excel", updated_at=NOW))
        s.add(VariantCost(variant_id=v3.id, buy_cost=900_000, source="manual", updated_at=NOW))   # cost known, commission is not
        s.add(RadarEvent(variant_id=v1.id, type="BUYBOX_LOST", old_value="True", new_value="False", dedupe_key="e1",
                         created_at=NOW - timedelta(minutes=30),
                         details={"title": v1.title, "cause": "price_above", "gap_pct": 1.7}))
        s.add(ApiCallLog(called_at=NOW - timedelta(minutes=5), endpoint="/open-api/v1/variants", status=200, duration_ms=20))
        s.add(ApiCallLog(called_at=NOW - timedelta(minutes=4), endpoint="/open-api/v1/commissions/", status=403, duration_ms=20))
        s.add(ProductSales(product_id="p1", range="last_7_days", net_item_sold=10, net_sales_amount=1, fetched_at=NOW))
        s.add(ProductSales(product_id="p2", range="last_7_days", net_item_sold=5, net_sales_amount=1, fetched_at=NOW))
        s.add(FeeCache(key="sales:last_7_days", data={}, fetched_at=NOW))
        s.commit()
