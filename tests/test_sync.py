from sqlalchemy import func, select

from sudyar.config import Settings
from sudyar.models import Variant, VariantSnapshot
from sudyar.sync import parse_variant, sync_variants


class FakeClient:
    def __init__(self, items):
        self.items = items

    async def list_variants(self):
        for i in self.items:
            yield i


def raw(i, price=1000, stock=5, win=True, challenge=False):
    return {
        "id": i, "product_id": 100 + i, "product_variant_id": 9000 + i, "title": f"v{i}",
        "product_title": f"p{i}", "active": True, "is_archived": False,
        "price_sale": price, "cash_selling_price": price - 10, "price_limit": 500,
        "marketplace_seller_stock": stock, "warehouse_stock": 2, "buy_box_price": price - 5,
        "is_buy_box_winner": win, "is_seller_buy_box_winner": win,
        "is_in_buy_box_challenge": challenge, "is_sku_winner": False,
        "rating": 4.5, "lead_time": 1,
    }


async def test_upsert_is_idempotent(session, settings):
    items = [raw(1), raw(2)]
    assert await sync_variants(FakeClient(items), session, settings) == 2
    assert await sync_variants(FakeClient(items), session, settings) == 2
    assert session.scalar(select(func.count()).select_from(Variant)) == 2


async def test_update_changes_fields(session, settings):
    await sync_variants(FakeClient([raw(1, price=1000)]), session, settings)
    await sync_variants(FakeClient([raw(1, price=2000, stock=0)]), session, settings)
    v = session.scalar(select(Variant))
    assert (v.our_price, v.stock) == (2000, 0)
    assert v.raw_json["price_sale"] == 2000


async def test_missing_rows_marked_inactive_never_deleted(session, settings):
    await sync_variants(FakeClient([raw(1), raw(2)]), session, settings)
    await sync_variants(FakeClient([raw(1)]), session, settings)
    rows = {v.digikala_variant_id: v.active for v in session.scalars(select(Variant))}
    assert rows == {"1": True, "2": False}


async def test_failed_sync_does_not_deactivate(session, settings):
    await sync_variants(FakeClient([raw(1), raw(2)]), session, settings)

    class Broken:
        async def list_variants(self):
            yield raw(1)
            raise RuntimeError("network down")

    try:
        await sync_variants(Broken(), session, settings)
    except RuntimeError:
        session.rollback()
    assert all(v.active for v in session.scalars(select(Variant)))


def test_parse_skips_rows_without_id():
    assert parse_variant({"title": "x"}, Settings().field_map) is None


def test_parse_all_new_fields():
    d = parse_variant(raw(1), Settings().field_map)
    assert d["product_variant_id"] == "9001" and d["product_title"] == "p1"
    assert d["price_sale"] == 1000 and d["our_price"] == 1000  # no unit conversion
    assert d["cash_selling_price"] == 990 and d["price_limit"] == 500
    assert d["marketplace_seller_stock"] == 5 and d["stock"] == 5 and d["warehouse_stock"] == 2
    assert d["buy_box_price"] == 995 and d["is_seller_buy_box_winner"] is True
    assert d["is_in_buy_box_challenge"] is False and d["is_sku_winner"] is False
    assert d["is_archived"] is False and d["rating"] == 4.5 and d["lead_time"] == 1
    assert d["raw_json"]["id"] == 1


def test_parse_null_buybox_fields():
    r = raw(1)
    r["buy_box_price"] = None
    r["is_seller_buy_box_winner"] = None
    d = parse_variant(r, Settings().field_map)
    assert d["buy_box_price"] is None and d["is_seller_buy_box_winner"] is None


async def test_each_sync_adds_one_snapshot_per_variant(session, settings):
    await sync_variants(FakeClient([raw(1), raw(2)]), session, settings)
    assert session.scalar(select(func.count()).select_from(VariantSnapshot)) == 2
    await sync_variants(FakeClient([raw(1, price=2000, win=False, challenge=True), raw(2)]), session, settings)
    snaps = session.scalars(select(VariantSnapshot).order_by(VariantSnapshot.id)).all()
    assert len(snaps) == 4  # history is kept
    v1 = session.scalar(select(Variant).where(Variant.digikala_variant_id == "1"))
    mine = [s for s in snaps if s.variant_id == v1.id]
    assert [(s.price_sale, s.is_seller_buy_box_winner, s.is_in_buy_box_challenge) for s in mine] == [
        (1000, True, False), (2000, False, True)]
    assert mine[0].buy_box_price == 995 and mine[0].stock == 5
