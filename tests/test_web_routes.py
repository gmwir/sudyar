import re
from datetime import timedelta

import pytest
from sqlalchemy import select

from sudyar.models import AppSetting, ApiCallLog, Variant
from sudyar.ui_settings import load_ui_settings
from webfx import NOW, TOKEN, client, make_app, make_factory, make_settings, seed, variant

PAGES = ["/", "/radar", "/floor", "/settings", "/partials/profit"]


@pytest.fixture
def seeded():
    f = make_factory()
    seed(f)
    return f, client(make_app(f))


def text(resp) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", resp.text))


# ---------------- every page, empty and seeded ----------------
@pytest.mark.parametrize("path", PAGES + ["/healthz", "/manifest.webmanifest", "/sw.js", "/static/app.css"])
def test_pages_200_on_empty_database(path):
    c = client(make_app())
    assert c.get(path).status_code == 200


@pytest.mark.parametrize("path", PAGES)
def test_pages_200_with_data(seeded, path):
    assert seeded[1].get(path).status_code == 200


def test_pages_are_rtl_persian_with_security_headers(seeded):
    r = seeded[1].get("/")
    assert 'lang="fa" dir="rtl"' in r.text and "Vazirmatn" not in r.text   # font comes from the stylesheet
    h = r.headers
    assert "default-src 'self'" in h["content-security-policy"] and "frame-ancestors 'none'" in h["content-security-policy"]
    assert h["x-content-type-options"] == "nosniff" and h["x-frame-options"] == "DENY" and h["cache-control"] == "no-store"
    assert "unsafe-inline" not in h["content-security-policy"] and "unsafe-eval" not in h["content-security-policy"]


def test_no_inline_styles_or_scripts_in_rendered_pages(seeded):
    for path in PAGES:
        html = seeded[1].get(path).text
        assert " style=" not in html and "<style" not in html, path
        assert not re.search(r"<script(?![^>]*\bsrc=)", html), path
        assert " onclick=" not in html and "javascript:" not in html


def test_tab_bar_has_the_four_screens_and_marks_the_current_one(seeded):
    html = seeded[1].get("/radar").text
    for label in ("امروز", "رادار", "کف قیمت", "تنظیمات"):
        assert f"</span>{label}</a>" in html
    assert html.count('aria-current="page"') == 1 and re.search(r'href="/radar" aria-current="page"', html)


# ---------------- Today ----------------
def test_today_shows_max_three_items_in_priority_order(seeded):
    t = text(seeded[1].get("/"))
    assert "کارهای امروز" in t
    lost = t.index("کالا باکس خرید را از دست داده‌اند")
    need = t.index("اطلاعات ناقص است")
    assert lost < need
    assert "۱ کالا باکس خرید را از دست داده‌اند" in t
    assert "بیشترین علت: قیمت ما بالاتر از قیمت باکس خرید است (۱ مورد)" in t
    assert "فیلتر روغن پژو ۲۰۶ تیپ ۲" in t


def test_today_input_item_counts_only_real_missing_inputs(seeded):
    t = text(seeded[1].get("/"))
    assert "۱ کالا قیمت خرید ندارد" in t          # v2 (cost missing)
    assert "۱ کالا کمیسیون در دسترس ندارد" in t   # v3 (category 999 has no commission row)


def test_today_never_claims_a_daily_profit_it_does_not_have(seeded):
    t = text(seeded[1].get("/"))
    assert "سود خالص دیروز (۲۲ آبان)" in t
    assert "دیجی‌کالا فروش روزانه نمی‌دهد" not in t     # Part 4c: real sales come from the Order API
    assert "سود واقعی" not in t or "تومان" in t         # a "real profit" claim must carry a number


def test_today_empty_database_is_honest():
    t = text(client(make_app()).get("/"))
    assert "هنوز هیچ کالایی از دیجی‌کالا خوانده نشده" in t and "آمار فروش هنوز خوانده نشده" in t
    assert "کمیسیون‌ها هنوز از دیجی‌کالا خوانده نشده‌اند" in t
    assert "داده‌ها به‌روز نیستند" in t


def test_today_all_clear_state():
    f = make_factory()
    with f() as s:                       # one healthy winning variant with everything known, data fresh
        from sudyar.floor import set_floor_rule
        from sudyar.models import Commission, FeeCache, VariantCost
        s.add(Commission(category_id="101", commission=0.10, fetched_at=NOW))
        s.add(FeeCache(key="commissions", data={"rows": 1, "orphan_rows": 0, "partial_categories": []}, fetched_at=NOW))
        s.add(FeeCache(key="sales:last_30_days", data={}, fetched_at=NOW))
        set_floor_rule(s, "global", margin_pct=10)
        v = variant(s, "1", "کالا", win=True, price=10_000_000, bb=10_000_000)
        s.add(VariantCost(variant_id=v.id, buy_cost=500_000, source="excel", updated_at=NOW))
        s.commit()
    t = text(client(make_app(f)).get("/"))
    assert "امروز کاری لازم نیست" in t and "داده‌ها به‌روز نیستند" not in t


def test_today_stale_data_warnings(seeded):
    f = seeded[0]
    with f() as s:
        for snap in s.query(__import__("sudyar.models", fromlist=["VariantSnapshot"]).VariantSnapshot):
            snap.taken_at = NOW - timedelta(hours=9)
        s.commit()
    t = text(client(make_app(f)).get("/"))
    assert "آخرین خواندن کالاها ۹ ساعت پیش بوده" in t and "آمار فروش هنوز خوانده نشده" in t


def test_profit_estimate_is_computed_from_db_and_states_what_was_left_out(seeded):
    t = text(seeded[1].get("/partials/profit"))
    # v1: price 1,210,000 toman, 10% commission, cost 1,000,000 -> 89,000 per unit x 10 sold
    assert "۸۹۰٬۰۰۰ تومان" in t and "بر اساس ۱ محصول و ۱۰ عدد فروش" in t
    assert "۱ محصول کنار گذاشته شد" in t and "بدون قیمت خرید یا کمیسیون" in t
    assert "این تخمین است، نه گزارش رسمی" in t


def test_profit_estimate_without_sales_data():
    t = text(client(make_app()).get("/partials/profit"))
    assert "آمار فروش هنوز خوانده نشده" in t and "تومان" not in t


# ---------------- Radar ----------------
def test_radar_groups_by_tier_with_buybox_state_reason_and_last_check(seeded):
    html = seeded[1].get("/radar").text
    assert re.findall(r'group-title"><span class="chip (\w+)"', html) == ["hot", "calm"]    # empty WARM group is not shown
    t = text(seeded[1].get("/radar"))
    assert "فیلتر روغن پژو ۲۰۶ تیپ ۲" in t and "از دست رفته" in t
    assert "علت: قیمت ما بالاتر از قیمت باکس خرید است" in t
    assert "شما ۱٬۲۱۰٬۰۰۰ تومان · بای‌باکس ۱٬۱۹۰٬۰۰۰ تومان" in t                  # Rial / 10
    assert "قیمت شما ۸۹۰٬۰۰۰ تومان · برنده بای‌باکس" in t
    assert "آخرین بررسی: ۲ دقیقه پیش" in t
    assert "نامشخص" in t                                                          # v3: Buy Box state unknown, not guessed


def test_radar_stats_come_from_the_data(seeded):
    html = seeded[1].get("/radar").text
    nums = re.findall(r'<b class="c-(danger|warning|success)">([^<]*)</b>', html)
    assert dict(nums) == {"danger": "۱", "warning": "۱", "success": "۱"}   # below floor / lost / win


def test_radar_tier_filter_and_htmx_partial(seeded):
    c = seeded[1]
    full = c.get("/radar?tier=HOT")
    assert "<html" in full.text and "فیلتر روغن" in full.text and "لنت ترمز" not in full.text
    part = c.get("/radar?tier=CALM", headers={"HX-Request": "true"})
    assert "<html" not in part.text and 'id="radar-main"' in part.text
    assert c.get("/radar?tier=BOGUS").status_code == 404


def test_radar_lost_reason_without_event_is_computed_from_current_data():
    f = make_factory()
    with f() as s:
        variant(s, "1", "کالای بدون رویداد", win=False, price=9_000_000, bb=8_000_000, stock=0)
        s.commit()
    t = text(client(make_app(f)).get("/radar"))
    assert "علت: موجودی تمام شده" in t


def test_radar_empty_state():
    t = text(client(make_app()).get("/radar"))
    assert "هنوز کالایی خوانده نشده" in t


def test_radar_caps_rows_and_says_so():
    f = make_factory()
    with f() as s:
        for i in range(105):
            variant(s, str(i), f"کالا {i}", win=True)
        s.commit()
    t = text(client(make_app(f)).get("/radar"))
    assert "۵ کالای دیگر در این گروه هست" in t


# ---------------- Floor ----------------
def test_floor_list_states_and_never_guesses(seeded):
    t = text(seeded[1].get("/floor"))
    assert "کف قیمت ۱٬۲۵۰٬۰۰۰ تومان" in t                       # 1,000,000 / (1 - 0.10 - 0.10)
    assert "قیمت خرید این کالا ثبت نشده؛ کف حدس زده نمی‌شود" in t
    assert "برای دسته‌ی این کالا ردیف کمیسیون پیدا نشد" in t
    assert "برای ۱ کالا قیمت خرید ثبت نشده؛ کف قیمت «ناقص» است و حدس زده نمی‌شود" in t
    assert "قیمت برنده (۱٬۱۹۰٬۰۰۰ تومان) از کف شما پایین‌تر است" in t


def test_floor_detail_shows_every_term_with_its_source(seeded):
    t = text(seeded[1].get("/floor/1001"))
    assert "کف قیمت: ۱٬۲۵۰٬۰۰۰ تومان" in t
    assert "قیمت خرید ۱٬۰۰۰٬۰۰۰ تومان فایل اکسل" in t
    assert "کمیسیون دیجی‌کالا ۱۰٪ نرخ دسته‌بندی از دیجی‌کالا" in t or "کمیسیون دیجی‌کالا ۱۰٪ نرخ تنها برند" in t
    assert "تنظیم نشده (صفر حساب می‌شود)" in t and "پردازش و ارسال" in t and "مالیات" in t
    assert "۱۰٪ از قیمت فروش" in t and "قانون: همه‌ی کالاها" in t
    assert "هزینه‌های تنظیم‌نشده صفر حساب شده‌اند" in t


def test_floor_detail_names_the_missing_input_instead_of_inventing_one(seeded):
    t = text(seeded[1].get("/floor/1002"))                   # no buy cost
    assert "کف قیمت: نامشخص" in t and "قیمت خرید ثبت نشده برای ساخت کف لازم است" in t
    assert "قیمت خرید این کالا ثبت نشده" in t
    t3 = text(seeded[1].get("/floor/1003"))                  # no commission for its category
    assert "کمیسیون دیجی‌کالا نامشخص" in t3 and "ردیف کمیسیون پیدا نشد" in t3


def test_floor_detail_unknown_variant_404(seeded):
    assert seeded[1].get("/floor/nope").status_code == 404


def test_floor_filter_by_status(seeded):
    c = seeded[1]
    only = text(c.get("/floor?status=needs_cost"))
    assert "لنت ترمز" in only and "فیلتر روغن" not in only
    assert c.get("/floor?status=bogus").status_code == 404
    part = c.get("/floor?status=ok", headers={"HX-Request": "true"})
    assert 'id="floor-main"' in part.text and "<html" not in part.text


def test_floor_commission_problem_is_shown_prominently(seeded):
    f = seeded[0]
    with f() as s:
        from sudyar.models import FeeCache
        s.get(FeeCache, "commissions").data = {"rows": 1, "orphan_rows": 1, "partial_categories": ["*"]}
        s.commit()
    t = text(client(make_app(f)).get("/floor"))
    assert "یک ردیف کمیسیون بدون دسته پیدا شد؛ تا اصلاح نشود هیچ کفی نمایش داده نمی‌شود" in t
    assert "کف قیمت ۱٬۲۵۰٬۰۰۰ تومان" not in t                 # fail-closed: no floor is shown at all


def test_floor_stale_commissions_warn():
    f = make_factory()
    seed(f)
    with f() as s:
        from sudyar.models import FeeCache
        s.get(FeeCache, "commissions").fetched_at = NOW - timedelta(days=10)
        s.commit()
    t = text(client(make_app(f)).get("/floor"))
    assert "کمیسیون‌ها قدیمی‌اند" in t


def test_floor_bad_variant_does_not_break_the_page(seeded, monkeypatch):
    from sudyar.floor import FloorEngine
    real = FloorEngine.evaluate

    async def flaky(self, session, variant, now, allow_fetch=True):
        if variant.digikala_variant_id == "1002":
            raise OverflowError("boom")
        return await real(self, session, variant, now, allow_fetch)

    monkeypatch.setattr(FloorEngine, "evaluate", flaky)
    r = seeded[1].get("/floor")
    assert r.status_code == 200 and "خطا در محاسبه" in text(r) and "boom" not in r.text


# ---------------- Settings ----------------
def test_settings_never_shows_secrets(seeded):
    for path in PAGES + ["/floor/1001"]:
        r = seeded[1].get(path)
        assert TOKEN not in r.text and "pw-secret-xyz" not in r.text and TOKEN[:12] not in r.text, path


def test_settings_connection_status_from_call_log(seeded):
    t = text(seeded[1].get("/settings"))
    assert "این دسترسی به توکن داده نشده" in t           # commissions -> 403
    assert "کار می‌کند" in t                              # variants -> 200
    assert "هنوز بررسی نشده" in t                         # insight: never called
    assert "بعضی دسترسی‌ها کار نمی‌کنند" in t
    for scope in ("variant", "commission", "insight", "order"):
        assert f"({scope})" in t
    assert "pricing/buybox" not in t


@pytest.mark.parametrize("statuses,expected", [
    ({"/open-api/v1/variants": 200, "/open-api/v1/commissions/": 200, "/open-api/v1/insight/sales-reports": 200, "/open-api/v1/orders/history": 200}, "متصل؛ هر چهار دسترسی کار می‌کند"),
    ({"/open-api/v1/variants": 401}, "توکن منقضی شده"),
    ({}, "توکن ثبت شده؛ هنوز هیچ خواندنی انجام نشده"),
])
def test_settings_overall_state(statuses, expected):
    f = make_factory()
    with f() as s:
        for ep, st in statuses.items():
            s.add(ApiCallLog(called_at=NOW, endpoint=ep, status=st, duration_ms=1))
        s.commit()
    assert expected in text(client(make_app(f)).get("/settings"))


def test_settings_missing_token_says_so():
    c = client(make_app(settings=make_settings(digikala_self_token="")))
    assert "توکن در فایل .env ثبت نشده" in text(c.get("/settings"))


def test_settings_defaults_are_8_23_7_and_dry_run():
    c = client(make_app())
    html = c.get("/settings").text
    assert re.search(r'<option value="8" selected>', html)
    assert re.search(r'<select id="quiet_start" name="quiet_start">.*?<option value="23" selected>', html, re.S)
    assert re.search(r'<select id="quiet_end" name="quiet_end">.*?<option value="7" selected>', html, re.S)
    t = text(c.get("/settings"))
    assert "الان آزمایشی است" in t and "پیش‌فرض ۲۳ تا ۷" in t
    assert re.search(r'name="notify" value="1"[^>]*\bdisabled', html)     # no channel credentials -> cannot be switched on


def post_alerts(c, html_or_token, **form):
    tok = re.search(r'name="csrf_token" value="([^"]+)"', html_or_token).group(1) if "<" in html_or_token else html_or_token
    return c.post("/settings/alerts", data={"csrf_token": tok, **form}, follow_redirects=False)


def test_settings_save_alerts_roundtrip_and_validation():
    f = make_factory()
    c = client(make_app(f))
    page = c.get("/settings").text
    r = post_alerts(c, page, report_hour="9", quiet_mode="quiet", quiet_start="22", quiet_end="6")
    assert r.status_code == 303 and r.headers["location"] == "/settings"
    with f() as s:
        ui = load_ui_settings(s)
        assert (ui.report_hour, ui.quiet_enabled, ui.quiet_start, ui.quiet_end) == (9, True, 22, 6)
    html = c.get("/settings").text
    assert re.search(r'<option value="9" selected>', html) and "از ۲۲:۰۰ تا ۰۶:۰۰ هشدار نمی‌آید" in text(c.get("/settings"))


def test_settings_htmx_save_returns_the_card_with_message():
    f = make_factory()
    c = client(make_app(f))
    tok = re.search(r'name="csrf_token" value="([^"]+)"', c.get("/settings").text).group(1)
    r = c.post("/settings/alerts", data={"report_hour": "10", "quiet_mode": "always", "quiet_start": "23", "quiet_end": "7"},
               headers={"HX-Request": "true", "X-CSRF-Token": tok})
    assert r.status_code == 200 and 'id="alerts-card"' in r.text and "<html" not in r.text and "ذخیره شد." in r.text
    assert "هشدار در همه‌ی ساعت‌ها می‌آید" in text(r)


@pytest.mark.parametrize("form,msg", [
    (dict(report_hour="24"), "ساعت باید بین ۰ تا ۲۳ باشد"),
    (dict(report_hour="abc"), "عدد ساعت نامعتبر است"),
    (dict(report_hour="-1"), "عدد ساعت نامعتبر است"),
    (dict(quiet_start="23", quiet_end="23"), "شروع و پایان ساعت آرام نباید یکی باشد"),
    (dict(quiet_start="99"), "ساعت باید بین ۰ تا ۲۳ باشد"),
])
def test_settings_rejects_bad_values_without_saving(form, msg):
    f = make_factory()
    c = client(make_app(f))
    tok = re.search(r'name="csrf_token" value="([^"]+)"', c.get("/settings").text).group(1)
    body = {"report_hour": "8", "quiet_mode": "quiet", "quiet_start": "23", "quiet_end": "7", **form}
    r = c.post("/settings/alerts", data=body, headers={"HX-Request": "true", "X-CSRF-Token": tok})
    assert r.status_code == 422 and msg in r.text
    with f() as s:
        assert s.scalar(select(AppSetting)) is None


def test_notify_switch_works_only_with_channel_credentials():
    f = make_factory()
    ready = make_settings(telegram_bot_token="123456:ABCDEF-secret-tg", telegram_chat_id="-1001234")
    c = client(make_app(f, ready))
    page = c.get("/settings").text
    assert not re.search(r'name="notify" value="1"[^>]*\bdisabled', page)
    assert "ABCDEF-secret-tg" not in page and "-1001234" not in page
    post_alerts(c, page, report_hour="8", quiet_mode="quiet", quiet_start="23", quiet_end="7", notify="1")
    t = text(c.get("/settings"))
    assert "الان روشن است" in t and "تلگرام" in t
    post_alerts(c, page, report_hour="8", quiet_mode="quiet", quiet_start="23", quiet_end="7")      # switch off
    assert "الان آزمایشی است" in text(c.get("/settings"))


def test_disabled_notify_switch_never_flips_a_saved_value():
    f = make_factory()
    with f() as s:
        s.add(AppSetting(key="notify_enabled", value=True))
        s.commit()
    c = client(make_app(f))                       # no credentials now: effective = dry-run, saved value untouched
    post_alerts(c, c.get("/settings").text, report_hour="8", quiet_mode="quiet", quiet_start="23", quiet_end="7")
    with f() as s:
        assert load_ui_settings(s).notify_enabled is True
    assert "الان آزمایشی است" in text(c.get("/settings"))


# ---------------- errors ----------------
def test_database_down_shows_short_persian_error_without_details():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    broken = sessionmaker(create_engine("sqlite:////nonexistent_dir_zz/x.db"))
    r = client(make_app(broken)).get("/settings")
    assert r.status_code == 503 and "پایگاه داده آماده نیست" in r.text and "nonexistent" not in r.text and "sqlite" not in r.text.lower()


def test_unknown_page_is_a_short_persian_404():
    r = client(make_app()).get("/nope")
    assert r.status_code == 404 and "پیدا نشد" in r.text


def test_unexpected_error_hides_details(monkeypatch):
    from sudyar.web import data
    monkeypatch.setattr(data, "build_radar", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret internals 42")))
    r = client(make_app(), raise_server_exceptions=False).get("/radar")
    assert r.status_code == 500 and "خطای غیرمنتظره" in r.text and "secret internals" not in r.text


# ---------------- PWA ----------------
def test_manifest_is_installable_and_icons_exist():
    c = client(make_app())
    m = c.get("/manifest.webmanifest").json()
    assert m["lang"] == "fa" and m["dir"] == "rtl" and m["display"] == "standalone" and m["start_url"] == "/"
    assert {i["sizes"] for i in m["icons"]} >= {"192x192", "512x512"} and any(i.get("purpose") == "maskable" for i in m["icons"])
    for icon in m["icons"]:
        r = c.get(icon["src"])
        assert r.status_code == 200 and r.headers["content-type"] == "image/png" and len(r.content) > 500
    assert 'rel="manifest"' in c.get("/").text and "apple-touch-icon" in c.get("/").text


def test_service_worker_caches_only_static_files():
    c = client(make_app())
    r = c.get("/sw.js")
    assert r.headers["service-worker-allowed"] == "/" and r.headers["content-type"].startswith("text/javascript")
    assert "/static/" in r.text and "caches.open" in r.text
    assert "url.pathname.startsWith(\"/static/\")" in r.text      # pages and data are never cached


def test_vendored_assets_are_served_locally():
    c = client(make_app())
    assert c.get("/static/htmx.min.js").status_code == 200 and c.get("/static/fonts/Vazirmatn-Variable.woff2").status_code == 200
    assert "Vazirmatn-Variable.woff2" in c.get("/static/app.css").text
