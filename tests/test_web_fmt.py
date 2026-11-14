from datetime import datetime, timedelta, timezone

import pytest

from sudyar.web import fmt

UTC = timezone.utc


@pytest.mark.parametrize("g,j", [
    ((2024, 3, 20), (1403, 1, 1)), ((2025, 3, 21), (1404, 1, 1)), ((2026, 3, 21), (1405, 1, 1)),
    ((2026, 11, 14), (1405, 8, 23)), ((2026, 9, 23), (1405, 7, 1)), ((2026, 3, 20), (1404, 12, 29)),
    ((2023, 3, 21), (1402, 1, 1)), ((2026, 12, 21), (1405, 9, 30)), ((2027, 1, 1), (1405, 10, 11)),
])
def test_gregorian_to_jalali(g, j):
    assert fmt.gregorian_to_jalali(*g) == j


def test_jalali_uses_tehran_time_not_utc():
    late = datetime(2026, 11, 14, 21, 0, tzinfo=UTC)            # 00:30 on 15 Nov in Tehran
    assert fmt.jalali_date(late) == "۲۴ آبان ۱۴۰۵" and fmt.jalali_short(late) == "۲۴ آبان"
    assert fmt.jalali_datetime(datetime(2026, 11, 14, 12, 0, tzinfo=UTC)) == "۲۳ آبان ۱۴۰۵ · ۱۵:۳۰"
    assert fmt.jalali_date(datetime(2026, 11, 14, 12, 0)) == "۲۳ آبان ۱۴۰۵"      # naive = UTC (SQLite)


def test_persian_digits_and_money():
    assert fmt.fa("0123456789") == "۰۱۲۳۴۵۶۷۸۹" and fmt.fa(1405) == "۱۴۰۵"
    assert fmt.fa_int(1210000) == "۱٬۲۱۰٬۰۰۰" and fmt.fa_int(0) == "۰" and fmt.fa_int(-5000) == "−۵٬۰۰۰"
    assert fmt.fa_int(None) == fmt.UNKNOWN and fmt.toman_text(None) == "نامشخص"
    assert fmt.toman_text(1210000) == "۱٬۲۱۰٬۰۰۰ تومان"
    assert fmt.toman_from_rial(12_100_000) == 1_210_000 and fmt.toman_from_rial(None) is None   # Rial / 10
    assert fmt.pct_text(10.0) == "۱۰٪" and fmt.pct_text(8.5) == "۸٫۵٪" and fmt.pct_text(0.0) == "۰٪"
    assert fmt.pct_text(None) == "نامشخص"


def test_time_ago():
    now = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    assert fmt.time_ago(now - timedelta(seconds=20), now) == "همین الان"
    assert fmt.time_ago(now - timedelta(minutes=2), now) == "۲ دقیقه پیش"
    assert fmt.time_ago(now - timedelta(hours=3, minutes=5), now) == "۳ ساعت پیش"
    assert fmt.time_ago(now - timedelta(days=4), now) == "۴ روز پیش"
    assert fmt.time_ago(None, now) == "هنوز خوانده نشده"
    assert fmt.time_ago(datetime(2026, 11, 14, 11, 58), now) == "۲ دقیقه پیش"          # naive
    assert fmt.time_ago(now + timedelta(minutes=5), now) == "همین الان"                  # clock skew never goes negative
