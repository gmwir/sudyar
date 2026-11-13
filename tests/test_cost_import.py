import pytest
from openpyxl import Workbook
from sqlalchemy import func, select

from sudyar.config import Settings
from sudyar.cost_import import CostImportError, import_costs, parse_cost
from sudyar.models import Variant, VariantCost


@pytest.mark.parametrize("raw,expected", [
    (1200000, 1200000), (1200000.0, 1200000), ("1,200,000", 1200000), ("۱۲۰۰۰۰۰", 1200000),
    ("١٢٣", 123), (" 5000 ", 5000), ("1٬500٬000", 1500000),
])
def test_parse_cost_ok(raw, expected):
    assert parse_cost(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "  ", "abc", 0, -5, "-1", 12.5, True, float("nan"), "inf"])
def test_parse_cost_rejects(raw):
    with pytest.raises(ValueError):
        parse_cost(raw)


def seed(session, ids=("1", "2", "3"), sku_field=None):
    for i in ids:
        session.add(Variant(digikala_variant_id=i, raw_json={"sku": f"SKU-{i}"}, active=True))
    session.flush()


def write_csv(tmp_path, text, name="c.csv"):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def write_xlsx(tmp_path, rows, name="c.xlsx"):
    wb = Workbook()
    for r in rows:
        wb.active.append(r)
    p = tmp_path / name
    wb.save(p)
    return p


def count(session):
    return session.scalar(select(func.count()).select_from(VariantCost))


def test_csv_import_and_idempotent(session, tmp_path):
    seed(session)
    p = write_csv(tmp_path, "variant_id,buy_cost\n1,1000\n2,\"2,000\"\n")
    r1 = import_costs(session, p, Settings())
    assert (r1.created, r1.updated, r1.unchanged, r1.rejected) == (2, 0, 0, [])
    r2 = import_costs(session, p, Settings())
    assert (r2.created, r2.updated, r2.unchanged) == (0, 0, 2) and count(session) == 2
    p2 = write_csv(tmp_path, "variant_id,buy_cost\n1,1500\n", "d.csv")
    r3 = import_costs(session, p2, Settings())
    assert r3.updated == 1
    cost = session.scalar(select(VariantCost).join(Variant, Variant.id == VariantCost.variant_id).where(Variant.digikala_variant_id == "1"))
    assert cost.buy_cost == 1500 and cost.source == "excel"


def test_xlsx_import_with_persian_digits_and_numbers(session, tmp_path):
    seed(session)
    p = write_xlsx(tmp_path, [["Variant ID", "Buy Cost"], ["1", 1000], [2, "۲۰۰۰"], [None, None]])
    r = import_costs(session, p, Settings())
    assert r.created == 2 and r.rejected == []


def test_rejected_rows_are_reported_with_row_numbers(session, tmp_path):
    seed(session)
    p = write_csv(tmp_path, "variant_id,buy_cost\n1,1000\n99,500\n2,abc\n3,-4\n1,2000\n,100\n")
    r = import_costs(session, p, Settings())
    reasons = dict(r.rejected)
    assert r.created == 1 and sorted(reasons) == [3, 4, 5, 6, 7]
    assert "not found" in reasons[3] and "not a number" in reasons[4] and "greater than 0" in reasons[5]
    assert "duplicate of row 2" in reasons[6] and "empty" in reasons[7]


def test_dry_run_saves_nothing(session, tmp_path):
    seed(session)
    p = write_csv(tmp_path, "variant_id,buy_cost\n1,1000\n")
    r = import_costs(session, p, Settings(), dry_run=True)
    assert r.created == 1 and r.dry_run and count(session) == 0


def test_sku_requires_config(session, tmp_path):
    seed(session)
    p = write_csv(tmp_path, "sku,buy_cost\nSKU-1,1000\nNOPE,5\n")
    r = import_costs(session, p, Settings())
    assert r.created == 0 and "not configured" in r.rejected[0][1]
    r = import_costs(session, p, Settings(cost_sku_field="sku"))
    assert r.created == 1 and "not found" in r.rejected[0][1]


def test_variant_id_wins_over_sku(session, tmp_path):
    seed(session)
    p = write_csv(tmp_path, "variant_id,sku,buy_cost\n1,SKU-2,1000\n")
    assert import_costs(session, p, Settings(cost_sku_field="sku")).created == 1
    v1 = session.scalar(select(Variant).where(Variant.digikala_variant_id == "1"))
    assert session.get(VariantCost, v1.id).buy_cost == 1000


def test_file_level_errors(session, tmp_path):
    with pytest.raises(CostImportError, match="not found"):
        import_costs(session, tmp_path / "nope.csv", Settings())
    with pytest.raises(CostImportError, match="Unsupported"):
        import_costs(session, write_csv(tmp_path, "x", "a.txt"), Settings())
    with pytest.raises(CostImportError, match="Columns missing"):
        import_costs(session, write_csv(tmp_path, "a,b\n1,2\n"), Settings())
    with pytest.raises(CostImportError, match="empty"):
        import_costs(session, write_csv(tmp_path, "", "e.csv"), Settings())


def test_semicolon_csv(session, tmp_path):
    seed(session)
    p = write_csv(tmp_path, "variant_id;buy_cost\n1;1000\n2;2000\n")
    assert import_costs(session, p, Settings()).created == 2


def test_app_works_without_any_costs(session):
    assert count(session) == 0   # optional feature: nothing requires rows
