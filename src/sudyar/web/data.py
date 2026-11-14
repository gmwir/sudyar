"""Everything the pages show, built from the database and the floor engine. Nothing here calls Digikala.

Rules: a number is shown only if it comes from the DB / engine; a missing input is named, never guessed.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import Settings
from ..fees import LIMIT_MESSAGE_FA, ORPHAN_MESSAGE_FA, FeeProvider
from ..floor import (COMPONENTS, OK, FloorEngine, FloorResult, resolve_components, resolve_setting, to_toman)
from ..models import (ApiCallLog, ProductSales, RadarEvent, Variant, VariantCost, VariantSnapshot)
from ..notifier import CAUSE_FA
from ..radar import BUYBOX_LOST, determine_cause
from ..sales import sales_synced_at
from ..tiers import CALM, HOT, TIERS, WARM, aware, classify_tiers, last_snapshot_times
from ..ui_settings import UiSettings, effective_settings, load_ui_settings
from . import fmt

log = logging.getLogger(__name__)

TIER_FA = {HOT: "داغ", WARM: "گرم", CALM: "آرام"}
MAX_ROWS = 100  # per list: keeps pages light; the page says how many more exist

STATUS_FA = {
    "ok": "آماده", "needs_cost": "قیمت خرید ثبت نشده", "needs_fees": "کمیسیون در دسترس نیست",
    "needs_unit": "واحد قیمت نامشخص", "no_rule": "قانون کف تعریف نشده", "no_floor": "کف دستی قابل استفاده نیست",
    "impossible": "قابل محاسبه نیست", "error": "خطا در محاسبه",
}
COMPONENT_FA = {"fulfillment": "پردازش و ارسال", "tax": "مالیات", "ad_share": "سهم تبلیغات",
                "return_reserve": "ذخیره مرجوعی", "packaging": "بسته‌بندی"}
RULE_SCOPE_FA = {"global": "همه‌ی کالاها", "category": "دسته‌بندی", "brand": "برند", "variant": "همین کالا"}
FEE_SOURCE_FA = {
    "fee_category_row": "نرخ دسته‌بندی از دیجی‌کالا",
    "fee_brand_row": "نرخ برند انتخاب‌شده از دیجی‌کالا",
    "fee_assumed_max_brand": "بیشترین نرخ برندهای دسته (برند مشخص نیست)",
    "fee_assumed_single_brand": "نرخ تنها برند ثبت‌شده‌ی دسته (نرخ کل دسته نیست)",
}


def fees_reason_fa(reason: str) -> str:
    """Short Persian text for why commission data is missing (English engine reason in, Persian out)."""
    r = reason or ""
    if "no category" in r:
        return ORPHAN_MESSAGE_FA
    if "too many invalid" in r:
        return LIMIT_MESSAGE_FA
    if "never synced" in r or "no sync record" in r:
        return "کمیسیون‌ها هنوز از دیجی‌کالا خوانده نشده‌اند."
    if "older than" in r:
        return "کمیسیون‌ها قدیمی‌اند؛ همگام‌سازی کمیسیون دوباره لازم است."
    if "no category_id" in r:
        return "این کالا دسته‌بندی (category_id) ندارد."
    if "invalid" in r:
        return "بعضی ردیف‌های کمیسیون این دسته نامعتبر بودند؛ بیشترین نرخ معلوم نیست."
    return "برای دسته‌ی این کالا ردیف کمیسیون پیدا نشد."


def reason_fa(result: FloorResult) -> str:
    """One honest Persian line explaining a floor result's state."""
    if result.status == "needs_fees":
        return fees_reason_fa(result.reason)
    if result.status == "needs_cost":
        return "قیمت خرید این کالا ثبت نشده؛ کف حدس زده نمی‌شود."
    if result.status == "no_rule":
        return "هنوز درصد سود یا کف دستی تعریف نشده (دستور set-floor)."
    if result.status == "needs_unit":
        return "واحد قیمت‌ها (ریال یا تومان) در تنظیمات برنامه مشخص نیست."
    if result.status == "no_floor":
        return "کف دستی صفر یا نامعتبر است."
    if result.status == "impossible":
        return "با این هزینه‌ها و درصد سود، کف قابل محاسبه نیست."
    return ""


# ---------------------------------------------------------------- floor rows (shared by Today / Radar / Floor)
@dataclass
class FloorRow:
    variant: Variant
    result: FloorResult | None  # None only if evaluating this variant failed
    floor_toman: int | None
    price_toman: float | None
    win_toman: float | None  # current Buy Box price (Toman), None if unknown
    below_floor: bool

    @property
    def status(self) -> str:
        return self.result.status if self.result else "error"


def make_engine(s: Settings) -> FloorEngine:
    return FloorEngine(s, FeeProvider(None, s))  # no client: the UI can never call Digikala


def floor_rows(session: Session, engine: FloorEngine, now: datetime) -> list[FloorRow]:
    """Evaluate every active variant (fees from the database only). One bad variant never breaks the list."""
    s = engine.s
    engine.fees.preload(session)
    async def run() -> list[FloorRow]:
        out = []
        for v in session.scalars(select(Variant).where(Variant.active.is_(True)).order_by(Variant.id)):
            price = to_toman(v.price_sale, s.price_unit)
            win = to_toman(v.buy_box_price, s.price_unit)
            try:
                res = await engine.evaluate(session, v, now, allow_fetch=False)
            except Exception as e:
                log.warning("floor row skipped for variant %s: %s", v.digikala_variant_id, type(e).__name__)
                out.append(FloorRow(v, None, None, price, win, False))
                continue
            floor = res.floor_toman if res.status == OK else None
            below = bool(floor is not None and win is not None and v.is_seller_buy_box_winner is False and win < floor)
            out.append(FloorRow(v, res, floor, price, win, below))
        return out

    return _run_async(run())


def _run_async(coro):
    """The engine is async (it can fetch fees); here it never does, so a private loop is enough."""
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# ---------------------------------------------------------------- Radar
@dataclass
class RadarRow:
    variant: Variant
    tier: str
    state: str  # win | lost | unknown
    price_toman: float | None
    buybox_toman: float | None
    last_check: datetime | None
    reason: str | None  # Persian, only for lost


@dataclass
class RadarView:
    groups: dict[str, list[RadarRow]]
    totals: dict[str, int]
    hidden: dict[str, int]  # rows beyond MAX_ROWS per tier
    win: int = 0
    lost: int = 0
    below_floor: int | None = None
    last_update: datetime | None = None
    tier_filter: str | None = None
    empty: bool = True


def build_radar(session: Session, s: Settings, rows: list[FloorRow] | None, now: datetime,
                tier: str | None = None) -> RadarView:
    tiers = classify_tiers(session, now, s)
    last = last_snapshot_times(session)
    variants = list(session.scalars(select(Variant).where(Variant.active.is_(True)).order_by(Variant.id)))
    lost_ids = [v.id for v in variants if v.is_seller_buy_box_winner is False]
    causes: dict[int, str] = {}
    if lost_ids:
        events = session.scalars(select(RadarEvent).where(RadarEvent.type == BUYBOX_LOST,
                                                          RadarEvent.variant_id.in_(lost_ids))
                                 .order_by(RadarEvent.created_at.asc(), RadarEvent.id.asc()))
        for ev in events:  # the newest loss per variant wins
            c = (ev.details or {}).get("cause")
            if c:
                causes[ev.variant_id] = c
    groups: dict[str, list[RadarRow]] = {t: [] for t in TIERS}
    win = lost = 0
    for v in variants:
        state = "win" if v.is_seller_buy_box_winner is True else "lost" if v.is_seller_buy_box_winner is False else "unknown"
        win += state == "win"
        lost += state == "lost"
        reason = None
        if state == "lost":
            cause = causes.get(v.id) or determine_cause({
                "price_sale": v.price_sale, "buy_box_price": v.buy_box_price, "stock": v.stock, "active": v.active})["cause"]
            reason = CAUSE_FA.get(cause, fmt.UNKNOWN)
        groups[tiers.get(v.id, CALM)].append(RadarRow(
            v, tiers.get(v.id, CALM), state, to_toman(v.price_sale, s.price_unit), to_toman(v.buy_box_price, s.price_unit),
            last.get(v.id), reason))
    order = {"lost": 0, "unknown": 1, "win": 2}
    for t in TIERS:
        groups[t].sort(key=lambda r: (order[r.state], r.variant.id))
    totals = {t: len(groups[t]) for t in TIERS}
    shown = {t: groups[t][:MAX_ROWS] for t in TIERS}
    if tier in TIERS:
        shown = {t: (shown[t] if t == tier else []) for t in TIERS}
    return RadarView(
        shown, totals, {t: max(0, totals[t] - MAX_ROWS) for t in TIERS}, win, lost,
        None if rows is None else sum(1 for r in rows if r.below_floor),
        max(last.values()) if last else None, tier if tier in TIERS else None, empty=not variants)


# ---------------------------------------------------------------- Floor
@dataclass
class FloorView:
    rows: list[FloorRow]
    counts: dict[str, int]
    total: int
    hidden: int
    status_filter: str | None
    missing_cost: int
    commission_notice: str | None


def build_floor(session: Session, s: Settings, rows: list[FloorRow], now: datetime, status: str | None = None) -> FloorView:
    counts: dict[str, int] = {}
    for r in rows:
        counts[r.status] = counts.get(r.status, 0) + 1
    shown = [r for r in rows if status is None or r.status == status]
    order = {"ok": 5, "error": 4}
    shown.sort(key=lambda r: (order.get(r.status, 0), r.variant.id))  # things that need input first
    return FloorView(shown[:MAX_ROWS], counts, len(rows), max(0, len(shown) - MAX_ROWS),
                     status if status in STATUS_FA else None, counts.get("needs_cost", 0),
                     commission_notice(session, FeeProvider(None, s), now))


def commission_notice(session: Session, provider: FeeProvider, now: datetime) -> str | None:
    """Persian warning when commission data is missing / stale / fail-closed (None when fine)."""
    msg = provider.incomplete_message_fa(session)
    if msg:
        return msg
    if provider.synced_at(session) is None:
        return "کمیسیون‌ها هنوز از دیجی‌کالا خوانده نشده‌اند؛ تا آن موقع کف قیمت ساخته نمی‌شود."
    if provider.is_stale(session, now):
        return "کمیسیون‌ها قدیمی‌اند؛ تا همگام‌سازی دوباره، کف قیمت ساخته نمی‌شود."
    return None


@dataclass
class Term:
    label: str
    value: str  # Persian text, or the missing-input message
    source: str = ""  # where the number comes from
    missing: bool = False


@dataclass
class FloorDetail:
    variant: Variant
    status: str
    status_fa: str
    floor_text: str
    terms: list[Term] = field(default_factory=list)
    note: str = ""


def build_floor_detail(session: Session, engine: FloorEngine, variant: Variant, now: datetime) -> FloorDetail:
    """Every term of one floor with its source. A missing term says what is missing; it is never guessed."""
    s = engine.s
    engine.fees.preload(session)
    try:
        res = _run_async(engine.evaluate(session, variant, now, allow_fetch=False))
    except Exception as e:
        log.warning("floor detail failed: %s", type(e).__name__)
        return FloorDetail(variant, "error", STATUS_FA["error"], fmt.UNKNOWN,
                           note="محاسبه‌ی این کالا با خطا روبه‌رو شد.")
    terms: list[Term] = []
    cost_row = session.get(VariantCost, variant.id)
    if cost_row is not None and cost_row.buy_cost is not None and cost_row.buy_cost > 0:
        src = "فایل اکسل" if cost_row.source == "excel" else "ورود دستی"
        terms.append(Term("قیمت خرید", fmt.toman_text(cost_row.buy_cost),
                          f"{src} · {fmt.jalali_date(cost_row.updated_at)}"))
    else:
        terms.append(Term("قیمت خرید", "ثبت نشده", "برای ساخت کف لازم است", missing=True))
    if res.commission_pct is not None:
        terms.append(Term("کمیسیون دیجی‌کالا", fmt.pct_text(res.commission_pct),
                          FEE_SOURCE_FA.get(res.fee_reason or "", "دیجی‌کالا")))
    else:
        terms.append(Term("کمیسیون دیجی‌کالا", "نامشخص",
                          fees_reason_fa(res.reason) if res.status == "needs_fees" else "تا وقتی قیمت خرید و قانون کف نباشد خوانده نمی‌شود",
                          missing=True))
    comps = resolve_components(session, variant, s)
    for c in COMPONENTS:
        parts = []
        if comps.pct.get(c) is not None:
            parts.append(fmt.pct_text(comps.pct[c]))
        if comps.toman.get(c) is not None:
            parts.append(fmt.toman_text(comps.toman[c]))
        if parts:
            terms.append(Term(COMPONENT_FA[c], " + ".join(parts), "تنظیم دستی شما"))
        else:
            terms.append(Term(COMPONENT_FA[c], "تنظیم نشده (صفر حساب می‌شود)", "هیچ منبعی در دیجی‌کالا ندارد", missing=True))
    rule = resolve_setting(session, variant, s)
    if rule is None:
        terms.append(Term("حداقل سود", "تعریف نشده", "با دستور set-floor تعریف کنید", missing=True))
    else:
        bits = []
        if rule.margin_pct is not None:
            bits.append(f"{fmt.pct_text(rule.margin_pct)} از قیمت فروش")
        if rule.min_profit_toman is not None:
            bits.append(f"حداقل {fmt.toman_text(rule.min_profit_toman)}")
        if rule.floor_manual_toman is not None:
            bits.append(f"کف دستی {fmt.toman_text(rule.floor_manual_toman)}")
        if rule.floor_manual_pct is not None:
            bits.append(f"کف دستی {fmt.pct_text(rule.floor_manual_pct)} قیمت فعلی")
        terms.append(Term("حداقل سود / کف دستی", "؛ ".join(bits) or fmt.UNKNOWN,
                          f"قانون: {RULE_SCOPE_FA.get(rule.scope, rule.scope)}"))
    note = reason_fa(res)
    if res.status == OK and res.computed_floor_toman is not None and res.floor_toman != res.computed_floor_toman:
        note = "کف دستی از کف محاسبه‌شده بیشتر بود و همان استفاده شد."
    elif res.status == OK and res.computed_floor_toman is None:
        note = "کف دستی؛ بدون قیمت خرید محاسبه‌ای انجام نشده."
    if res.status == OK and res.unset_components:
        note = (note + " " if note else "") + "هزینه‌های تنظیم‌نشده صفر حساب شده‌اند؛ کف واقعی ممکن است بالاتر باشد."
    return FloorDetail(variant, res.status, STATUS_FA.get(res.status, res.status),
                       fmt.toman_text(res.floor_toman) if res.status == OK else fmt.UNKNOWN, terms, note.strip())


# ---------------------------------------------------------------- Today
@dataclass
class TodayItem:
    kind: str  # lost | input | stale
    title: str
    lines: list[str]
    href: str


@dataclass
class TodayView:
    items: list[TodayItem]
    yesterday: str  # Jalali date of "yesterday"
    nothing_to_do: bool


def build_today(session: Session, s: Settings, rows: list[FloorRow], now: datetime) -> TodayView:
    items: list[TodayItem] = []
    # 1) lost Buy Box (last 24 h, still not winning), with the reason
    since = now - timedelta(hours=24)
    events = list(session.scalars(select(RadarEvent).where(RadarEvent.type == BUYBOX_LOST, RadarEvent.created_at >= since)
                                  .order_by(RadarEvent.created_at.desc())))
    still_lost: dict[int, RadarEvent] = {}
    for ev in events:
        v = session.get(Variant, ev.variant_id)
        if v is not None and v.active and v.is_seller_buy_box_winner is False and ev.variant_id not in still_lost:
            still_lost[ev.variant_id] = ev
    if still_lost:
        causes: dict[str, int] = {}
        for ev in still_lost.values():
            c = (ev.details or {}).get("cause", "unknown")
            causes[c] = causes.get(c, 0) + 1
        top, n = max(causes.items(), key=lambda kv: kv[1])
        lines = [f"بیشترین علت: {CAUSE_FA.get(top, fmt.UNKNOWN)} ({fmt.fa(n)} مورد)"]
        for ev in list(still_lost.values())[:2]:
            lines.append(((ev.details or {}).get("title") or fmt.UNKNOWN))
        items.append(TodayItem("lost", f"{fmt.fa(len(still_lost))} کالا باکس خرید را از دست داده‌اند", lines, "/radar"))
    # 2) variants that need cost / fee / rule input
    need = {k: sum(1 for r in rows if r.status == k) for k in ("needs_cost", "needs_fees", "no_rule")}
    if any(need.values()):
        lines = []
        if need["needs_cost"]:
            lines.append(f"{fmt.fa(need['needs_cost'])} کالا قیمت خرید ندارد؛ کف برایشان ساخته نمی‌شود.")
        if need["needs_fees"]:
            lines.append(f"{fmt.fa(need['needs_fees'])} کالا کمیسیون در دسترس ندارد.")
        if need["no_rule"]:
            lines.append(f"{fmt.fa(need['no_rule'])} کالا قانون کف (درصد سود) ندارد.")
        items.append(TodayItem("input", "اطلاعات ناقص است", lines, "/floor"))
    # 3) stale data warnings
    stale = stale_warnings(session, s, now)
    if stale:
        items.append(TodayItem("stale", "داده‌ها به‌روز نیستند", stale[:3], "/settings"))
    items = items[:3]
    yesterday = fmt.jalali_short(now - timedelta(days=1))
    return TodayView(items, yesterday, not items)


def stale_warnings(session: Session, s: Settings, now: datetime) -> list[str]:
    out: list[str] = []
    provider = FeeProvider(None, s)
    notice = commission_notice(session, provider, now)
    if notice:
        out.append(notice)
    sales_at = sales_synced_at(session, "last_30_days")
    if sales_at is None:
        out.append("آمار فروش هنوز خوانده نشده.")
    elif (now - sales_at) > timedelta(days=7):
        out.append(f"آمار فروش {fmt.time_ago(sales_at, now)} خوانده شده.")
    latest = session.scalar(select(func.max(VariantSnapshot.taken_at)))
    if latest is None:
        out.append("هنوز هیچ کالایی از دیجی‌کالا خوانده نشده.")
    elif (now - aware(latest)) > timedelta(hours=3):
        out.append(f"آخرین خواندن کالاها {fmt.time_ago(latest, now)} بوده؛ رادار شاید خاموش است.")
    return out


# ---------------------------------------------------------------- profit card
@dataclass
class ProfitView:
    state: str  # ok | no_sales | nothing_usable
    total_toman: float | None = None
    products_used: int = 0
    excluded_multi: int = 0
    excluded_missing: int = 0
    units: int = 0
    range_fa: str = "۷ روز اخیر"
    synced_at: datetime | None = None


def build_profit(session: Session, engine: FloorEngine, now: datetime, range_: str = "last_7_days") -> ProfitView:
    """Estimate (NOT yesterday's actual profit: Digikala gives no daily sales): units sold in the range x profit per
    unit at today's price, only for single-variant products whose cost, commission and rules are all known."""
    sales = list(session.scalars(select(ProductSales).where(ProductSales.range == range_, ProductSales.net_item_sold > 0)))
    synced = sales_synced_at(session, range_)
    if not sales:
        return ProfitView("no_sales", synced_at=synced)
    engine.fees.preload(session)
    total, used, multi, missing, units = 0.0, 0, 0, 0, 0
    for sale in sales:
        variants = list(session.scalars(select(Variant).where(Variant.product_id == sale.product_id, Variant.active.is_(True))))
        if len(variants) != 1:
            multi += 1
            continue
        try:
            profit = _run_async(engine.profit_now(session, variants[0], now, allow_fetch=False))
        except Exception:
            profit = None
        if profit is None:
            missing += 1
            continue
        total += profit * sale.net_item_sold
        units += sale.net_item_sold
        used += 1
    if not used:
        return ProfitView("nothing_usable", excluded_multi=multi, excluded_missing=missing, synced_at=synced)
    return ProfitView("ok", total, used, multi, missing, units, synced_at=synced)


# ---------------------------------------------------------------- Settings
SCOPE_ENDPOINTS = {
    "variant": ("/open-api/v1/variants", "/open-api/v1/pricing/"),
    "commission": ("/open-api/v1/commissions",),
    "insight": ("/open-api/v1/insight/",),
}
SCOPE_FA = {"variant": "کالاها و قیمت پیشنهادی (variant)", "commission": "کمیسیون‌ها (commission)",
            "insight": "آمار فروش (insight)"}


@dataclass
class ScopeStatus:
    scope: str
    label: str
    state: str  # ok | denied | expired | error | unknown
    text: str
    when: datetime | None


@dataclass
class ConnectionView:
    token_present: bool
    overall: str  # missing | expired | ok | partial | unknown
    overall_text: str
    scopes: list[ScopeStatus]


def build_connection(session: Session, s: Settings, now: datetime) -> ConnectionView:
    """Connection state from the saved call log only (no live call). The token itself is never shown."""
    present = bool(s.digikala_self_token.get_secret_value().strip())
    scopes: list[ScopeStatus] = []
    for scope, prefixes in SCOPE_ENDPOINTS.items():
        row = None
        for pre in prefixes:
            r = session.scalar(select(ApiCallLog).where(ApiCallLog.endpoint.like(pre + "%"))
                               .order_by(ApiCallLog.called_at.desc(), ApiCallLog.id.desc()).limit(1))
            if r is not None and (row is None or aware(r.called_at) > aware(row.called_at)):
                row = r
        if row is None:
            state, text = "unknown", "هنوز بررسی نشده"
        elif row.status == 200:
            state, text = "ok", "کار می‌کند"
        elif row.status == 401:
            state, text = "expired", "توکن منقضی یا نامعتبر است"
        elif row.status == 403:
            state, text = "denied", "این دسترسی به توکن داده نشده"
        else:
            state, text = "error", f"آخرین تلاش با خطا روبه‌رو شد ({fmt.fa(row.status) if row.status else 'شبکه'})"
        scopes.append(ScopeStatus(scope, SCOPE_FA[scope], state, text, row.called_at if row else None))
    states = [x.state for x in scopes]
    if not present:
        overall, text = "missing", "توکن در فایل .env ثبت نشده"
    elif "expired" in states:
        overall, text = "expired", "توکن منقضی شده؛ توکن تازه بسازید"
    elif all(x == "ok" for x in states):
        overall, text = "ok", "متصل؛ هر سه دسترسی کار می‌کند"
    elif all(x == "unknown" for x in states):
        overall, text = "unknown", "توکن ثبت شده؛ هنوز هیچ خواندنی انجام نشده"
    else:
        overall, text = "partial", "بعضی دسترسی‌ها کار نمی‌کنند"
    return ConnectionView(present, overall, text, scopes)


@dataclass
class AlertsView:
    ui: UiSettings
    notify_on: bool  # effective: really sending
    dry_run: bool
    telegram_ready: bool
    bale_ready: bool
    can_send: bool
    channels_text: str


def build_alerts(session: Session, s: Settings) -> AlertsView:
    ui = load_ui_settings(session)
    eff = effective_settings(session, s)
    tg = bool(s.telegram_bot_token.get_secret_value() and s.telegram_chat_id.get_secret_value())
    bale = bool(s.bale_bot_token.get_secret_value() and s.bale_chat_id.get_secret_value() and s.bale_api_base)
    wants = ui.notify_enabled if ui.notify_enabled is not None else s.notify_enabled
    return AlertsView(ui, eff.notify_enabled, not eff.notify_enabled, tg, bale, tg or bale,
                      ("تلگرام" if tg else "") + (" و " if tg and bale else "") + ("بله" if bale else ""))
