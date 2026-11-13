"""Notifications: Telegram + Bale (Bot API shape), Persian templates, cooldown, quiet hours.

DRY-RUN by default: messages are only printed unless NOTIFY_ENABLED=true.
Tokens and chat ids come from the environment and are never logged or put in error text.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, time
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import Settings, check_bale_base
from .models import RadarEvent
from .tiers import aware

log = logging.getLogger(__name__)

TELEGRAM_BASE = "https://api.telegram.org"
UNKNOWN_FA = "نامشخص"

CAUSE_FA = {
    "stock_out": "موجودی تمام شده",
    "inactive": "کالا غیرفعال است",
    "price_above": "قیمت ما بالاتر از قیمت باکس خرید است",
    "unknown": UNKNOWN_FA,
}


class NotifyError(Exception):
    """Sanitized: never contains the URL (it holds the bot token) or the chat id."""


# ---------- message templates ----------
def _n(v) -> str:
    return UNKNOWN_FA if v is None else f"{v:,}" if isinstance(v, int) else str(v)


def _pct(v) -> str:
    return UNKNOWN_FA if v is None else f"{v:.1f}٪"


FLOOR_LABEL_FA = {
    "can_win_above_floor": "می‌توان بالاتر از کف قیمت برنده شد",
    "would_need_below_floor": "برای برنده شدن باید پایین‌تر از کف قیمت رفت",
    "needs_cost": "قیمت خرید ثبت نشده",
    "needs_fees": "کارمزدها از دیجی‌کالا در دسترس نیست",
    "needs_unit": "واحد قیمت (ریال/تومان) تنظیم نشده",
    "no_rule": "قانون کف قیمت تنظیم نشده",
    "no_floor": "کف دستی قابل استفاده نیست",
    "impossible": "با این حاشیه سود کف قیمت قابل محاسبه نیست",
    "unknown": UNKNOWN_FA,
}


COMP_FA = {"fulfillment": "پردازش/ارسال", "tax": "مالیات", "ad_share": "تبلیغات",
           "return_reserve": "مرجوعی", "packaging": "بسته‌بندی"}


def _toman(v, unit: str | None):
    """Price in the API unit -> Toman (Rial / 10). None if the unit is not known."""
    if v is None or unit not in ("rial", "toman"):
        return None
    return round(v / 10) if unit == "rial" else round(v)


def _floor_lines(d: dict) -> str:
    f = d.get("floor")
    if not f:
        return ""
    floor = f.get("floor_toman")
    win = f.get("win_price_toman")
    out = (f"\nکف قیمت: {_n(floor)} تومان"
           f"\nقیمت لازم برای برد: {_n(None if win is None else int(win))} تومان"
           f"\nارزیابی: {FLOOR_LABEL_FA.get(f.get('label'), UNKNOWN_FA)}")
    if f.get("fee_reason") == "fee_assumed_max_brand":
        out += "\nکمیسیون: بیشترین مقدار برندهای این دسته (برند مشخص نیست)"
    unset = [COMP_FA[c] for c in f.get("unset_components") or [] if c in COMP_FA]
    if unset and f.get("floor_toman") is not None:
        out += "\nهزینه‌های تنظیم‌نشده (صفر حساب شده): " + "، ".join(unset)
    return out + "\nفقط پیشنهاد است؛ هیچ قیمتی تغییر نمی‌کند."


def render_message(ev: RadarEvent) -> str:
    d = ev.details or {}
    pu = d.get("price_unit")
    known = pu in ("rial", "toman")  # unit known -> every price is shown in TOMAN
    title = d.get("title") or UNKNOWN_FA
    head = f"کالا: {title}"
    if known:
        our, bb = _toman(d.get("our_price"), pu), _toman(d.get("buy_box_price"), pu)
        prices = f"قیمت ما: {_n(our)} تومان\nقیمت باکس خرید: {_n(bb)} تومان"
        gap = f"{_n(_toman(d.get('gap_abs'), pu))} تومان"
        sug = _toman(d.get("suggested_price"), d.get("suggested_price_unit", "rial"))
        sug_txt = f"{_n(sug)} تومان"
        unit = ""
    else:  # old events without a known unit
        prices = f"قیمت ما: {_n(d.get('our_price'))}\nقیمت باکس خرید: {_n(d.get('buy_box_price'))}"
        gap = _n(d.get("gap_abs"))
        sug_txt = _n(d.get("suggested_price"))
        unit = "\n(واحد قیمت‌ها هنوز تأیید نشده)"
    t = ev.type
    if t == "BUYBOX_LOST":
        return (f"🔴 باکس خرید را از دست دادید\n{head}\n{prices}\n"
                f"فاصله: {_pct(d.get('gap_pct'))} ({gap})\n"
                f"قیمت پیشنهادی: {sug_txt}\n"
                f"علت: {CAUSE_FA.get(d.get('cause', 'unknown'), UNKNOWN_FA)}{_floor_lines(d)}{unit}")
    if t == "BUYBOX_REGAINED":
        return f"🟢 باکس خرید را پس گرفتید\n{head}\n{prices}{unit}"
    if t == "ENTERED_CHALLENGE":
        return f"🟠 کالا وارد رقابت باکس خرید شد\n{head}\n{prices}{unit}"
    if t == "LEFT_CHALLENGE":
        return f"⚪ کالا از رقابت باکس خرید خارج شد\n{head}\n{prices}{unit}"
    if t == "PRICE_CHANGED":
        old, new = int(ev.old_value), int(ev.new_value)
        if known:
            return f"💲 قیمت ما تغییر کرد\n{head}\nقبلی: {_n(_toman(old, pu))} ← جدید: {_n(_toman(new, pu))} تومان"
        return f"💲 قیمت ما تغییر کرد\n{head}\nقبلی: {_n(old)} ← جدید: {_n(new)}{unit}"
    if t == "STOCK_OUT":
        return f"📦 موجودی تمام شد\n{head}"
    if t == "STOCK_BACK":
        return f"📦 موجودی برگشت\n{head}\nموجودی: {ev.new_value}"
    if t == "DEACTIVATED":
        return f"⛔ کالا غیرفعال شد\n{head}"
    return f"{t}\n{head}"


# ---------- adapters ----------
class BotApiNotifier:
    """Telegram-style Bot API: POST {base}/bot<TOKEN>/sendMessage {chat_id, text}."""

    name = "bot"

    def __init__(self, base_url: str, token: str, chat_id: str, transport: httpx.AsyncBaseTransport | None = None):
        self._base, self._token, self._chat_id, self._transport = base_url.rstrip("/"), token, chat_id, transport

    async def send(self, text: str) -> None:
        url = f"{self._base}/bot{self._token}/sendMessage"  # never logged
        try:
            async with httpx.AsyncClient(timeout=15, transport=self._transport) as c:
                r = await c.post(url, json={"chat_id": self._chat_id, "text": text})
        except httpx.HTTPError as e:
            raise NotifyError(f"{self.name}: network error ({type(e).__name__})") from None
        if r.status_code >= 400:
            raise NotifyError(f"{self.name}: server answered status {r.status_code}")


class TelegramNotifier(BotApiNotifier):
    name = "telegram"

    def __init__(self, token: str, chat_id: str, transport=None):
        super().__init__(TELEGRAM_BASE, token, chat_id, transport)


class BaleNotifier(BotApiNotifier):
    """UNVERIFIED: assumes Bale offers the same Bot API shape; base URL comes from BALE_API_BASE."""

    name = "bale"


def build_notifiers(s: Settings, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, BotApiNotifier]:
    out: dict[str, BotApiNotifier] = {}
    for ch in [c.strip() for c in s.notify_channels.split(",") if c.strip()]:
        if ch == "telegram" and s.telegram_bot_token.get_secret_value():
            out[ch] = TelegramNotifier(s.telegram_bot_token.get_secret_value(),
                                       s.telegram_chat_id.get_secret_value(), transport)
        elif (ch == "bale" and s.bale_bot_token.get_secret_value() and s.bale_api_base
              and check_bale_base(s.bale_api_base, s.bale_allowed_hosts) is None):  # never send to other hosts
            out[ch] = BaleNotifier(s.bale_api_base, s.bale_bot_token.get_secret_value(),
                                   s.bale_chat_id.get_secret_value(), transport)
    return out


# ---------- rules ----------
def in_quiet_hours(now: datetime, start: str, end: str, tz: str) -> bool:
    """True if local time is within [start, end). Handles ranges that cross midnight."""
    if not start or not end:
        return False
    local = aware(now).astimezone(ZoneInfo(tz)).time()
    s, e = time.fromisoformat(start), time.fromisoformat(end)
    return s <= local < e if s <= e else (local >= s or local < e)


class Dispatcher:
    def __init__(self, settings: Settings, notifiers: dict[str, BotApiNotifier] | None = None,
                 emit: Callable[[str], None] = print):
        self.s = settings
        self.notifiers = notifiers if notifiers is not None else build_notifiers(settings)
        self.emit = emit
        self.allowed = {t.strip() for t in settings.notify_event_types.split(",") if t.strip()}

    def _cooldown_active(self, session: Session, ev: RadarEvent, now: datetime) -> bool:
        last = aware(session.scalar(select(func.max(RadarEvent.notified_at)).where(
            RadarEvent.variant_id == ev.variant_id, RadarEvent.id != ev.id,
            RadarEvent.notify_status.in_(("sent", "dry_run")))))
        return last is not None and (now - last).total_seconds() < self.s.notify_cooldown_seconds

    async def _deliver(self, ev: RadarEvent) -> str:
        text = render_message(ev)
        if not self.s.notify_enabled:
            self.emit(f"[DRY-RUN] (not sent)\n{text}\n")
            return "dry_run"
        ok = False
        for name, n in self.notifiers.items():
            try:
                await n.send(text)
                ok = True
            except NotifyError as e:
                log.warning("notification failed: %s", e)
        return "sent" if ok else "failed"

    async def dispatch(self, session: Session, events: list[RadarEvent], now: datetime) -> list[tuple[int, str]]:
        results = []
        for ev in events:
            if ev.type not in self.allowed:
                continue
            if in_quiet_hours(now, self.s.notify_quiet_start, self.s.notify_quiet_end, self.s.notify_timezone):
                status = "suppressed_quiet"
            elif self._cooldown_active(session, ev, now):
                status = "suppressed_cooldown"
            else:
                status = await self._deliver(ev)
            ev.notify_status = status
            if status in ("sent", "dry_run"):
                ev.notified_at = now
            session.flush()
            results.append((ev.id, status))
        session.commit()
        return results
