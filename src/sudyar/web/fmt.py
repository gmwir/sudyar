"""Persian formatting: digits, Jalali dates (Asia/Tehran), Toman amounts, relative times."""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TZ_NAME = "Asia/Tehran"
THOUSANDS = "٬"  # U+066C, as in the Figma design
_FA = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
UNKNOWN = "نامشخص"

JALALI_MONTHS = ("فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
                 "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند")


def fa(value) -> str:
    """Any value -> text with Persian digits."""
    return str(value).translate(_FA)


def fa_int(n: int | float | None) -> str:
    """1234567 -> ۱٬۲۳۴٬۵۶۷ (rounded to a whole number). None -> نامشخص."""
    if n is None:
        return UNKNOWN
    neg = n < 0
    s = f"{abs(round(n)):,}".replace(",", THOUSANDS)
    return ("−" if neg else "") + fa(s)


def toman_from_rial(rial: int | float | None) -> float | None:
    """Digikala prices are Rial; the UI shows Toman (Rial / 10)."""
    return None if rial is None else rial / 10


def toman_text(toman: int | float | None) -> str:
    return UNKNOWN if toman is None else f"{fa_int(toman)} تومان"


def pct_text(p: float | None) -> str:
    if p is None:
        return UNKNOWN
    s = f"{p:.1f}".rstrip("0").rstrip(".")
    return fa(s).replace(".", "٫") + "٪"  # Persian decimal separator


def gregorian_to_jalali(gy: int, gm: int, gd: int) -> tuple[int, int, int]:
    """Gregorian -> Jalali (arithmetic algorithm, valid for the years we care about)."""
    g_d_m = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)
    gy2 = gy + 1 if gm > 2 else gy
    days = (355666 + 365 * gy + (gy2 + 3) // 4 - (gy2 + 99) // 100 + (gy2 + 399) // 400 + gd + g_d_m[gm - 1])
    jy = -1595 + 33 * (days // 12053)
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        jm, jd = 1 + days // 31, 1 + days % 31
    else:
        jm, jd = 7 + (days - 186) // 30, 1 + (days - 186) % 30
    return jy, jm, jd


def _local(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)  # SQLite returns naive UTC
    return dt.astimezone(ZoneInfo(TZ_NAME))


def jalali_date(dt: datetime | None) -> str:
    """۲۳ آبان ۱۴۰۵ (Tehran time)."""
    if dt is None:
        return UNKNOWN
    d = _local(dt)
    jy, jm, jd = gregorian_to_jalali(d.year, d.month, d.day)
    return f"{fa(jd)} {JALALI_MONTHS[jm - 1]} {fa(jy)}"


def jalali_short(dt: datetime | None) -> str:
    """۲۳ آبان."""
    if dt is None:
        return UNKNOWN
    d = _local(dt)
    _, jm, jd = gregorian_to_jalali(d.year, d.month, d.day)
    return f"{fa(jd)} {JALALI_MONTHS[jm - 1]}"


def jalali_datetime(dt: datetime | None) -> str:
    if dt is None:
        return UNKNOWN
    d = _local(dt)
    return f"{jalali_date(dt)} · {fa(d.strftime('%H:%M'))}"


def time_ago(dt: datetime | None, now: datetime) -> str:
    """۲ دقیقه پیش / ۳ ساعت پیش / ۴ روز پیش. None -> هنوز خوانده نشده."""
    if dt is None:
        return "هنوز خوانده نشده"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    sec = max(0, int((now - dt).total_seconds()))
    if sec < 60:
        return "همین الان"
    if sec < 3600:
        return f"{fa(sec // 60)} دقیقه پیش"
    if sec < 86400:
        return f"{fa(sec // 3600)} ساعت پیش"
    return f"{fa(sec // 86400)} روز پیش"
