"""Part 4b: buy-cost page. Local data only; never touches Digikala."""
import io
import re

import pytest
from openpyxl import Workbook
from sqlalchemy import event, select

from sudyar.models import CostAudit, Variant, VariantCost
from sudyar.web import app as app_module, cost_page
from webfx import NOW, PASSWORD, client, make_app, make_factory, seed


BASE = {"1001": 1_000_000, "1003": 900_000}  # seeded costs; 1002 has none


def tok(html):
    return re.search(r'name="csrf_token" value="([^"]+)"', html).group(1)


@pytest.fixture
def env():
    f = make_factory()
    seed(f)  # v1001 has cost 1,000,000 (excel); v1002, v1003 have none
    c = client(make_app(f))
    return f, c, tok(c.get("/costs").text)


def costs(f):
    with f() as s:
        return {v.digikala_variant_id: c.buy_cost for v, c in
                ((s.get(Variant, c.variant_id), c) for c in s.scalars(select(VariantCost)))}


def audit(f):
    with f() as s:
        return [(a.digikala_variant_id, a.old_cost, a.new_cost, a.source) for a in s.scalars(select(CostAudit).order_by(CostAudit.id))]


def csv_file(text, name="c.csv"):
    return {"file": (name, io.BytesIO(text.encode()), "text/csv")}


def xlsx_bytes(rows):
    wb = Workbook()
    for r in rows:
        wb.active.append(r)
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


# ---------- page ----------
def test_page_lists_variants_search_and_help():
    f = make_factory()
    seed(f)
    c = client(make_app(f))
    t = c.get("/costs").text
    assert "قیمت خرید" in t and "اجباری نیست" in t and "فیلتر روغن" in t and "لنت ترمز" in t
    assert 'aria-current="page"' in t
    assert "فیلتر" in c.get("/costs", params={"q": "فیلتر"}).text and "لنت" not in c.get("/costs", params={"q": "فیلتر"}).text
    assert "لنت" in c.get("/costs", params={"q": "۱۰۰۲"}).text            # Persian digits search ids
    assert "کالایی پیدا نشد" in c.get("/costs", params={"q": "%_zzz"}).text  # LIKE wildcards are literal


def test_empty_database_ok():
    assert client(make_app()).get("/costs").status_code == 200


# ---------- manual edit ----------
def test_manual_set_converts_like_cli_and_audits(env):
    f, c, t = env
    r = c.post("/costs/1002", data={"csrf_token": t, "cost": "۱٬۲۰۰٬۰۰۰"}, follow_redirects=False)
    assert r.status_code == 303 and costs(f)["1002"] == 1_200_000          # Toman stored as-is, like import-costs
    assert audit(f) == [("1002", None, 1_200_000, "manual")]
    with f() as s:
        assert s.get(VariantCost, s.scalar(select(Variant.id).where(Variant.digikala_variant_id == "1002"))).source == "manual"
    c.post("/costs/1002", data={"csrf_token": t, "cost": "1300000"})
    assert audit(f)[-1] == ("1002", 1_200_000, 1_300_000, "manual")
    c.post("/costs/1002", data={"csrf_token": t, "cost": "1300000"})        # same value: no new audit line
    assert len(audit(f)) == 2


def test_htmx_row_swap_and_audit_trigger(env):
    f, c, t = env
    r = c.post("/costs/1002", data={"cost": "500000"}, headers={"hx-request": "true", "x-csrf-token": t})
    assert r.status_code == 200 and "<tr" in r.text and "ذخیره شد" in r.text and r.headers["hx-trigger"] == "costs-changed"
    assert "۵۰۰٬۰۰۰" in r.text or "۵۰۰,۰۰۰" in r.text or "۵۰۰" in r.text
    assert "هنوز تغییری" not in c.get("/costs/audit").text


@pytest.mark.parametrize("bad", ["", "abc", "0", "-5", "12.5", "1e3x", "9" * 20, "NaN", "inf"])
def test_invalid_numbers_rejected_and_nothing_written(env, bad):
    f, c, t = env
    before = costs(f)
    r = c.post("/costs/1002", data={"csrf_token": t, "cost": bad})
    assert r.status_code == 422
    assert costs(f) == before and audit(f) == []
    h = c.post("/costs/1002", data={"cost": bad}, headers={"hx-request": "true", "x-csrf-token": t})
    assert h.status_code == 200 and 'role="alert"' in h.text and costs(f) == before


def test_clear_removes_cost_and_audits(env):
    f, c, t = env
    c.post("/costs/1001/clear", data={"csrf_token": t})
    assert "1001" not in costs(f) and audit(f) == [("1001", 1_000_000, None, "manual")]
    c.post("/costs/1001/clear", data={"csrf_token": t})                     # already clear: nothing more
    assert len(audit(f)) == 1


def test_unknown_variant_404(env):
    _, c, t = env
    assert c.post("/costs/nope", data={"csrf_token": t, "cost": "5"}).status_code == 404
    assert c.post("/costs/nope/clear", data={"csrf_token": t}).status_code == 404


# ---------- CSRF + password ----------
@pytest.mark.parametrize("path,data", [("/costs/1002", {"cost": "5"}), ("/costs/1001/clear", {}), ("/costs/apply", {"token": "x"})])
def test_csrf_required(env, path, data):
    f, c, _ = env
    before = costs(f)
    assert c.post(path, data=data).status_code == 403
    assert c.post(path, data={**data, "csrf_token": "wrong"}).status_code == 403
    assert costs(f) == before and audit(f) == []


def test_csrf_required_for_upload(env):
    f, c, _ = env
    r = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1002,5\n"), data={"csrf_token": "bad"})
    assert r.status_code == 403 and audit(f) == []


def test_password_gate_respected():
    f = make_factory()
    seed(f)
    c = client(make_app(f, web_password=PASSWORD))
    assert c.get("/costs", follow_redirects=False).status_code == 303
    t = tok(c.get("/login").text)
    for path, kw in (("/costs/1002", {"data": {"csrf_token": t, "cost": "5"}}), ("/costs/1001/clear", {"data": {"csrf_token": t}}),
                     ("/costs/upload", {"data": {"csrf_token": t}, "files": csv_file("variant_id,buy_cost\n1002,5\n")}),
                     ("/costs/apply", {"data": {"csrf_token": t, "token": "x"}}), ("/costs/audit", None)):
        r = c.post(path, follow_redirects=False, **kw) if kw else c.get(path, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"] == "/login", path
    assert costs(f) == BASE and audit(f) == []


# ---------- upload preview / confirm ----------
GOOD = "variant_id,buy_cost\n1002,800000\n1001,1500000\n1003,1000\n9999,5\n1002,7\n1003,abc\n"


def test_preview_does_not_write_and_shows_everything(env):
    f, c, t = env
    r = c.post("/costs/upload", files=csv_file(GOOD), data={"csrf_token": t})
    assert r.status_code == 200 and "هنوز چیزی ذخیره نشده" in r.text
    assert "تأیید و ذخیره" in r.text
    assert "۱٬۰۰۰٬۰۰۰ تومان ← ۱٬۵۰۰٬۰۰۰ تومان" in r.text or ("۱٬۵۰۰٬۰۰۰" in r.text and "۱٬۰۰۰٬۰۰۰" in r.text)  # old -> new
    assert "در کالاهای خوانده‌شده نیست" in r.text and "تکراری" in r.text and "عدد نیست" in r.text   # plain Persian reasons
    assert "buy_cost" not in re.sub(r"<[^>]+>", " ", r.text.split("پیش‌نمایش فایل")[1].split("بارگذاری فایل")[0])
    assert costs(f) == BASE and audit(f) == []


def test_confirm_writes_only_after_button(env):
    f, c, t = env
    page = c.post("/costs/upload", files=csv_file(GOOD), data={"csrf_token": t}).text
    token = re.search(r'name="token" value="([^"]+)"', page).group(1)
    r = c.post("/costs/apply", data={"csrf_token": t, "token": token}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/costs?saved=3"
    assert costs(f) == {"1001": 1_500_000, "1002": 800_000, "1003": 1000}
    assert sorted(audit(f)) == sorted([("1002", None, 800_000, "file"), ("1001", 1_000_000, 1_500_000, "file"), ("1003", 900_000, 1000, "file")])
    assert c.post("/costs/apply", data={"csrf_token": t, "token": token}).status_code == 422   # single use
    assert "ذخیره شد" in c.get("/costs?saved=3").text


def test_token_is_bound_to_this_login():
    f = make_factory()
    seed(f)
    a, b = client(make_app(f)), None
    t = tok(a.get("/costs").text)
    page = a.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1002,5\n"), data={"csrf_token": t}).text
    token = re.search(r'name="token" value="([^"]+)"', page).group(1)
    other = client(a.app)                       # another browser
    t2 = tok(other.get("/costs").text)
    assert other.post("/costs/apply", data={"csrf_token": t2, "token": token}).status_code == 422
    assert audit(f) == []


def test_stale_preview_recomputes_current_cost(env):
    f, c, t = env
    page = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1002,800000\n"), data={"csrf_token": t}).text
    token = re.search(r'name="token" value="([^"]+)"', page).group(1)
    c.post("/costs/1002", data={"csrf_token": t, "cost": "800000"})        # changed meanwhile
    c.post("/costs/apply", data={"csrf_token": t, "token": token})
    assert audit(f) == [("1002", None, 800_000, "manual"), ("1002", 800_000, 800_000, "file")]  # source change is audited


def test_xlsx_upload_works_and_formulas_are_not_executed(env):
    f, c, t = env
    data = xlsx_bytes([["variant_id", "buy_cost"], ["1002", "=1+1"], ["1003", 2500]])
    page = c.post("/costs/upload", files={"file": ("c.xlsx", io.BytesIO(data), "x")}, data={"csrf_token": t}).text
    assert "قیمت خرید خالی است" in page                                      # a formula has no cached value: never evaluated
    token = re.search(r'name="token" value="([^"]+)"', page).group(1)
    c.post("/costs/apply", data={"csrf_token": t, "token": token})
    assert costs(f)["1003"] == 2500 and "1002" not in costs(f)


@pytest.mark.parametrize("name,body,msg", [
    ("c.xls", b"x", "فقط فایل"), ("c.txt", b"variant_id,buy_cost\n", "فقط فایل"), ("c.xlsm", b"PK", "فقط فایل"),
    ("c.csv", b"", "خالی"), ("c.csv", b"a,b\n1,2\n", "ستون‌ها کم است"), ("c.csv", b"\xff\xfe\x00bad", "نیست"),
    ("c.xlsx", b"not a zip", "خوانده نشد"), ("c.csv", b"x" * 2_000_001, "حجم"),
])
def test_bad_files_rejected(env, name, body, msg):
    f, c, t = env
    r = c.post("/costs/upload", files={"file": (name, io.BytesIO(body), "x")}, data={"csrf_token": t})
    assert r.status_code == 422 and msg in r.text and audit(f) == [] and costs(f) == BASE


def test_row_limit_and_macro_workbook(env, monkeypatch):
    f, c, t = env
    monkeypatch.setattr(cost_page, "MAX_UPLOAD_ROWS", 3)
    r = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n" + "1002,5\n" * 4), data={"csrf_token": t})
    assert r.status_code == 422 and "ردیف‌ها بیشتر از سقف" in r.text
    import zipfile
    b = io.BytesIO(xlsx_bytes([["variant_id", "buy_cost"], ["1002", 5]]))
    out = io.BytesIO()
    with zipfile.ZipFile(b) as zi, zipfile.ZipFile(out, "w") as zo:
        for n in zi.namelist():
            zo.writestr(n, zi.read(n))
        zo.writestr("xl/vbaProject.bin", b"x")
    r = c.post("/costs/upload", files={"file": ("m.xlsx", io.BytesIO(out.getvalue()), "x")}, data={"csrf_token": t})
    assert r.status_code == 422 and "ماکرو" in r.text


def test_cost_stays_optional_manual_floor_still_works():
    """A variant with no cost keeps its manual-floor behaviour; saving/clearing costs never forces anything."""
    f = make_factory()
    seed(f)
    c = client(make_app(f))
    t = tok(c.get("/costs").text)
    before = c.get("/floor").text
    c.post("/costs/1001/clear", data={"csrf_token": t})
    after = c.get("/floor").text
    assert c.get("/floor").status_code == 200 and "قیمت خرید ثبت نشده" in after and before != after


# ---------- what the web may write ----------
def test_web_writes_only_cost_tables_and_app_settings():
    f = make_factory()
    seed(f)
    writes = set()

    @event.listens_for(f.kw["bind"], "before_cursor_execute")
    def spy(conn, cursor, statement, params, context, executemany):
        m = re.match(r"\s*(INSERT INTO|UPDATE|DELETE FROM)\s+\"?(\w+)", statement, re.I)
        if m:
            writes.add(m.group(2))

    c = client(make_app(f))
    t = tok(c.get("/costs").text)
    c.post("/costs/1002", data={"csrf_token": t, "cost": "5000"})
    c.post("/costs/1001/clear", data={"csrf_token": t})
    page = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1003,9000\n"), data={"csrf_token": t}).text
    c.post("/costs/apply", data={"csrf_token": t, "token": re.search(r'name="token" value="([^"]+)"', page).group(1)})
    c.post("/settings/alerts", data={"csrf_token": t, "report_hour": "9", "quiet_mode": "quiet", "quiet_start": "23", "quiet_end": "7"})
    for p in ("/", "/radar", "/floor", "/settings", "/costs", "/partials/profit", "/costs/audit"):
        c.get(p)
    assert writes <= {"variant_costs", "cost_audit", "app_settings"} and {"variant_costs", "cost_audit", "app_settings"} <= writes


def test_no_digikala_client_reachable_from_cost_routes():
    import inspect
    for mod in (app_module, cost_page):
        src = inspect.getsource(mod)
        assert "DigikalaClient" not in src and "digikala_client" not in src and "httpx" not in src
    app = make_app()
    assert not hasattr(app.state, "client")


def test_cli_import_shares_parser_and_audits(tmp_path):
    from sudyar.config import Settings
    from sudyar.cost_import import import_costs
    f = make_factory()
    seed(f)
    p = tmp_path / "c.csv"
    p.write_text("variant_id,buy_cost\n1002,777\n1001,1000000\n")
    with f() as s:
        r = import_costs(s, p, Settings(), dry_run=True)
        assert (r.created, r.updated, r.unchanged) == (1, 0, 1) and s.scalar(select(CostAudit.id)) is None
        import_costs(s, p, Settings())
    assert audit(f) == [("1002", None, 777, "file")]


# ---------- Part 4b fix: "به تومان" label + 3x sanity warning (warn, never block) ----------
def test_toman_label_on_every_input_and_upload_help(env):
    _, c, _ = env
    t = c.get("/costs").text
    assert t.count('class="unit"') == t.count('name="cost"') >= 3 and "به تومان" in t
    assert "<b>به تومان</b> بنویسید" in t


def test_inline_high_cost_needs_one_extra_confirm(env):
    f, c, t = env
    # v1002 sells at 8,900,000 Rial = 890,000 Toman; 3x = 2,670,000
    ok = c.post("/costs/1002", data={"csrf_token": t, "cost": "2670000"}, follow_redirects=False)
    assert ok.status_code == 303 and costs(f)["1002"] == 2_670_000          # exactly 3x: no warning
    c.post("/costs/1002/clear", data={"csrf_token": t})
    h = {"hx-request": "true", "x-csrf-token": t}
    r = c.post("/costs/1002", data={"cost": "8900000"}, headers=h)
    assert "این عدد خیلی بالاست؛ مطمئنید تومان است؟" in r.text and 'name="confirm_high"' in r.text
    assert "1002" not in costs(f)                                           # warned, not saved
    r2 = c.post("/costs/1002", data={"cost": "8900000", "confirm_high": "1"}, headers=h)
    assert "ذخیره شد" in r2.text and costs(f)["1002"] == 8_900_000
    assert audit(f)[-1] == ("1002", None, 8_900_000, "manual")


def test_inline_warning_without_htmx_does_not_save(env):
    f, c, t = env
    r = c.post("/costs/1002", data={"csrf_token": t, "cost": "99999999"})
    assert r.status_code == 422 and "این عدد خیلی بالاست" in r.text and "1002" not in costs(f)


def test_no_warning_when_price_unknown():
    f = make_factory()
    seed(f)
    with f() as s:
        s.get(Variant, s.scalar(select(Variant.id).where(Variant.digikala_variant_id == "1002"))).price_sale = None
        s.commit()
    c = client(make_app(f))
    t = tok(c.get("/costs").text)
    assert c.post("/costs/1002", data={"csrf_token": t, "cost": "999999999"}, follow_redirects=False).status_code == 303


def test_file_preview_warns_and_apply_needs_extra_confirm(env):
    f, c, t = env
    page = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1002,8900000\n1001,500000\n"), data={"csrf_token": t}).text
    assert "این عددها خیلی بالاست؛ مطمئنید تومان است؟" in page and 'name="confirm_high"' in page and "required" in page
    token = re.search(r'name="token" value="([^"]+)"', page).group(1)
    r = c.post("/costs/apply", data={"csrf_token": t, "token": token})        # no extra confirm
    assert r.status_code == 422 and costs(f) == BASE and audit(f) == []
    r = c.post("/costs/apply", data={"csrf_token": t, "token": token, "confirm_high": "1"}, follow_redirects=False)
    assert r.status_code == 303 and costs(f)["1002"] == 8_900_000 and costs(f)["1001"] == 500_000


def test_file_preview_without_high_values_has_no_extra_confirm(env):
    f, c, t = env
    page = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1002,100000\n"), data={"csrf_token": t}).text
    assert "خیلی بالاست" not in page and 'name="confirm_high"' not in page
    token = re.search(r'name="token" value="([^"]+)"', page).group(1)
    assert c.post("/costs/apply", data={"csrf_token": t, "token": token}, follow_redirects=False).status_code == 303


# ================= review fixes (Part 4b/4c) =================
from datetime import date

from sudyar.config import Settings
from sudyar.cost_import import parse_cost
from sudyar.models import DailySales, FeeCache
from sudyar.orders import sync_orders
from sudyar.web import data as web_data


# ---- 1) decimal separators never vanish
@pytest.mark.parametrize("raw", ["12٫5", "12/5", "۱۲٫۵", "1٫500٫000", "1/200/000", "0٫5"])
def test_parse_cost_never_turns_decimal_into_bigger_number(raw):
    with pytest.raises(ValueError):
        parse_cost(raw)


def test_parse_cost_still_accepts_normal_values():
    assert parse_cost("12٫0") == 12 and parse_cost("۱٬۲۰۰٬۰۰۰") == 1_200_000 and parse_cost("1,200,000") == 1_200_000


def test_web_rejects_decimal_separator_with_persian_reason(env):
    f, c, t = env
    r = c.post("/costs/1002", data={"cost": "12٫5"}, headers={"hx-request": "true", "x-csrf-token": t})
    assert "عدد صحیح" in r.text and "1002" not in costs(f)
    page = c.post("/costs/upload", files=csv_file("variant_id,buy_cost\n1002,12٫5\n"), data={"csrf_token": t}).text
    assert "عدد صحیح" in page and audit(f) == []


# ---- 2) ambiguous variant match is never costed
def _day_with(f, pvid, qty=1, price=15_000_000):
    day = date(2026, 11, 13)
    with f() as s:
        s.add(DailySales(day=day, product_variant_id=pvid, unit_sale_price=price, quantity=qty, synced_at=NOW))
        s.add(FeeCache(key=f"orders:{day}", data={}, fetched_at=NOW))
        s.commit()


def _yesterday(f):
    with f() as s:
        return web_data.build_yesterday(s, web_data.make_engine(make_settings()), make_settings(), NOW)


def make_settings(**kw):
    from webfx import make_settings as ms
    return ms(**kw)


def test_order_line_matched_only_through_fallback_id_is_unknown():
    f = make_factory()
    seed(f)
    _day_with(f, "1001")                   # "1001" is a digikala_variant_id, NOT a product_variant_id ("pv1001")
    y = _yesterday(f)
    assert y.state == "nothing_usable" and y.unknown == 1 and y.total_toman is None


def test_order_line_matching_two_variants_is_unknown():
    f = make_factory()
    seed(f)
    with f() as s:
        v = s.scalar(select(Variant).where(Variant.digikala_variant_id == "1002"))
        v.product_variant_id = "pv1001"    # now two variants share the id
        s.commit()
    _day_with(f, "pv1001")
    y = _yesterday(f)
    assert y.unknown == 1 and y.total_toman is None


def test_exact_single_match_is_still_costed():
    f = make_factory()
    seed(f)
    _day_with(f, "pv1001")
    y = _yesterday(f)
    assert y.state == "ok" and y.unknown == 0 and y.total_toman == pytest.approx(1_500_000 * 0.9 - 1_000_000)


# ---- 3) rejected lines mark the day incomplete, and Today says so
async def test_rejected_lines_mark_day_incomplete_and_show_on_today(session, make_limiter):
    import httpx
    from sudyar.digikala_client import DigikalaClient
    from test_orders import line, mk, page, st

    good, bad = line(oid=1, sid=1), line(oid=2, sid=2, qty="x")
    def h(r):
        return httpx.Response(200, json=page([good, bad] if r.url.params["order_type"] == "processed" else []))
    async with mk(h, st(), make_limiter) as c:
        await sync_orders(c, session, st(), [date(2026, 11, 13)], NOW)
    q = session.get(FeeCache, "orders:2026-11-13").data
    assert q["rejected"] == 1
    # same data in the web database: the card must warn
    f = make_factory()
    seed(f)
    _day_with(f, "pv1001")
    with f() as s:
        s.get(FeeCache, "orders:2026-11-13").data = {"rejected": 3}
        s.commit()
    r = client(make_app(f)).get("/partials/profit")
    assert "۳ خط نامعتبر؛ سود دیروز ممکن است دقیق نباشد" in r.text


# ---- 4) duplicates: item id => exact dedupe; no id => keep + warn
async def test_item_id_dedupes_exactly_and_no_id_keeps_lines(session, make_limiter):
    import httpx
    from test_orders import line, mk, page, st

    def run(items):
        def h(r):
            return httpx.Response(200, json=page(items if r.url.params["order_type"] == "processed" else []))
        return h
    a = line(oid=1, sid=1, order_item_id=11)
    async with mk(run([a, dict(a), line(oid=1, sid=1, order_item_id=12)]), st(), make_limiter) as c:
        r = await sync_orders(c, session, st(), [date(2026, 11, 13)], NOW, force=True)
    assert r.days[0].duplicates_dropped == 1 and r.days[0].suspect_duplicates == 0
    assert sum(x.quantity for x in session.scalars(select(DailySales))) == 2
    async with mk(run([line(), line()]), st(), make_limiter) as c:                  # no item id at all
        r = await sync_orders(c, session, st(), [date(2026, 11, 13)], NOW, force=True)
    assert r.days[0].suspect_duplicates == 1 and r.days[0].duplicates_dropped == 0
    assert sum(x.quantity for x in session.scalars(select(DailySales))) == 2        # kept, not merged away
    assert session.get(FeeCache, "orders:2026-11-13").data["suspect_duplicates"] == 1


# ---- 5) csv.Error and wide xlsx rows
def test_huge_csv_field_is_a_persian_rejection_not_500(env):
    f, c, t = env
    big = "variant_id,buy_cost\n1002," + "9" * 200_000 + "\n"
    r = c.post("/costs/upload", files=csv_file(big), data={"csrf_token": t})
    assert r.status_code == 422 and "فایل CSV خوانده نشد" in r.text and audit(f) == []


def test_wide_xlsx_rows_are_bounded(tmp_path):
    from sudyar.cost_import import MAX_COLUMNS, read_table
    wb = Workbook()
    ws = wb.active
    ws.append(["variant_id", "buy_cost"] + [f"x{i}" for i in range(5000)])
    ws.append(["1002", 5] + [1] * 5000)
    p = tmp_path / "w.xlsx"
    wb.save(p)
    rows = read_table(p, max_rows=10)
    assert len(rows) == 1 and len(rows[0][1]) <= MAX_COLUMNS and rows[0][1]["buy_cost"] == 5


# ---- 6) oversized body refused before parsing
def test_content_length_over_limit_rejected_before_parsing(env, monkeypatch):
    f, c, t = env
    called = []
    monkeypatch.setattr(cost_page, "make_preview", lambda *a, **k: called.append(1))
    r = c.post("/costs/upload", content=b"x", headers={"content-length": "5000000", "content-type": "multipart/form-data; boundary=b"})
    assert r.status_code in (413, 400) or r.status_code == 413
    assert called == [] and audit(f) == []


def test_streamed_body_over_limit_is_cut_off():
    import asyncio
    from sudyar.web.app import UploadBodyLimit
    sent, reads = [], []

    async def inner(scope, receive, send):
        while True:
            m = await receive()
            reads.append(len(m.get("body", b"")))
            if not m.get("more_body"):
                break

    async def run():
        chunks = [{"type": "http.request", "body": b"x" * 400, "more_body": True} for _ in range(100)]

        async def receive():
            return chunks.pop(0)

        async def send(m):
            sent.append(m)

        scope = {"type": "http", "method": "POST", "path": "/costs/upload", "headers": []}
        await UploadBodyLimit(inner, "/costs/upload", 1000)(scope, receive, send)

    asyncio.run(run())
    assert sent[0]["status"] == 413 and len(reads) <= 3          # stopped reading right after the limit
