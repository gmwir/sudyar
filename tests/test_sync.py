from sqlalchemy import func, select

from sudyar.config import Settings
from sudyar.models import Variant
from sudyar.sync import parse_variant, sync_variants


class FakeClient:
    def __init__(self, items):
        self.items = items

    async def list_variants(self):
        for i in self.items:
            yield i


def raw(i, price=1000, stock=5):
    return {"id": i, "product_id": 100 + i, "title": f"v{i}", "price": price, "stock": stock, "is_active": True}


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
    assert v.raw_json["price"] == 2000


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
