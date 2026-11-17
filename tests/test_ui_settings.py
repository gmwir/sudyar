from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from sudyar.config import Settings
from sudyar.models import AppSetting, RadarEvent, Variant
from sudyar.notifier import Dispatcher, TelegramNotifier
from sudyar.ui_settings import (DEFAULT_QUIET_END, DEFAULT_QUIET_START, DEFAULT_REPORT_HOUR, UiSettingsError,
                                effective_settings, load_ui_settings, save_ui_settings)

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
TG = dict(telegram_bot_token="123456:ABC-secret", telegram_chat_id="-1001234")


def test_defaults_are_8_and_23_to_7_and_notify_unset(session):
    ui = load_ui_settings(session)
    assert (ui.report_hour, ui.quiet_enabled, ui.quiet_start, ui.quiet_end) == (8, True, 23, 7)
    assert ui.notify_enabled is None and ui.saved is False
    assert (DEFAULT_REPORT_HOUR, DEFAULT_QUIET_START, DEFAULT_QUIET_END) == (8, 23, 7)
    s = Settings()
    assert (s.notify_quiet_start, s.notify_quiet_end, s.notify_enabled) == ("23:00", "07:00", False)   # app default = dry-run


def test_save_and_reload_upserts_without_duplicates(session):
    save_ui_settings(session, report_hour="9", quiet_enabled=True, quiet_start="22", quiet_end="6", notify_enabled=False)
    ui = save_ui_settings(session, report_hour=10, quiet_enabled=False, quiet_start=1, quiet_end=2, notify_enabled=True, now=NOW)
    assert (ui.report_hour, ui.quiet_enabled, ui.quiet_start, ui.quiet_end, ui.notify_enabled, ui.saved) == (10, False, 1, 2, True, True)
    assert session.scalar(select(func.count()).select_from(AppSetting)) == 5


@pytest.mark.parametrize("kw,msg", [
    (dict(report_hour="24"), "بین ۰ تا ۲۳"), (dict(report_hour="-1"), "نامعتبر"), (dict(report_hour="x"), "نامعتبر"),
    (dict(report_hour=True), "نامعتبر"), (dict(report_hour=None), "نامعتبر"), (dict(report_hour=7.5), "نامعتبر"),
    (dict(quiet_start="30"), "بین ۰ تا ۲۳"), (dict(quiet_end="-3"), "نامعتبر"),
    (dict(quiet_start=5, quiet_end=5), "نباید یکی باشد"),
])
def test_invalid_values_are_rejected_and_nothing_is_saved(session, kw, msg):
    base = dict(report_hour=8, quiet_enabled=True, quiet_start=23, quiet_end=7, notify_enabled=False)
    with pytest.raises(UiSettingsError, match=msg):
        save_ui_settings(session, **{**base, **kw})
    assert session.scalar(select(func.count()).select_from(AppSetting)) == 0


def test_equal_quiet_hours_are_fine_when_quiet_is_off(session):
    ui = save_ui_settings(session, report_hour=8, quiet_enabled=False, quiet_start=5, quiet_end=5, notify_enabled=False)
    assert ui.quiet_enabled is False


def test_corrupt_stored_value_falls_back_to_default(session):
    session.add(AppSetting(key="report_hour", value="abc"))
    session.add(AppSetting(key="quiet_start", value=99))
    session.add(AppSetting(key="notify_enabled", value="yes"))
    session.commit()
    ui = load_ui_settings(session)
    assert (ui.report_hour, ui.quiet_start, ui.notify_enabled) == (8, 23, None)


def test_missing_table_gives_defaults_instead_of_crashing():
    engine = create_engine("sqlite://")
    with sessionmaker(engine)() as s:
        assert load_ui_settings(s).report_hour == 8
        assert effective_settings(s, Settings()).notify_enabled is False


def test_effective_settings_unsaved_keeps_env_values(session):
    s = Settings(notify_quiet_start="21:00", notify_quiet_end="05:00")
    eff = effective_settings(session, s)
    assert eff is s and eff.notify_quiet_start == "21:00"


def test_effective_settings_applies_saved_quiet_hours(session):
    save_ui_settings(session, report_hour=8, quiet_enabled=True, quiet_start=22, quiet_end=6, notify_enabled=False)
    eff = effective_settings(session, Settings())
    assert (eff.notify_quiet_start, eff.notify_quiet_end) == ("22:00", "06:00")
    save_ui_settings(session, report_hour=8, quiet_enabled=False, quiet_start=22, quiet_end=6, notify_enabled=False)
    eff = effective_settings(session, Settings())
    assert (eff.notify_quiet_start, eff.notify_quiet_end) == ("", "")


def test_notify_on_needs_credentials_otherwise_stays_dry_run(session):
    save_ui_settings(session, report_hour=8, quiet_enabled=True, quiet_start=23, quiet_end=7, notify_enabled=True)
    assert effective_settings(session, Settings()).notify_enabled is False                     # no credentials
    assert effective_settings(session, Settings(notify_channels="telegram", **TG)).notify_enabled is True
    assert effective_settings(session, Settings(notify_channels="bale", bale_bot_token="x", bale_chat_id="1")).notify_enabled is False


def test_env_notify_enabled_without_credentials_never_sends(session):
    assert effective_settings(session, Settings(notify_enabled=True)).notify_enabled is False


# ---------------- the notifier really uses the saved settings ----------------
def mkevent(session, vid="1", at=NOW):
    v = session.query(Variant).filter_by(digikala_variant_id=vid).first()
    if v is None:
        v = Variant(digikala_variant_id=vid, raw_json={})
        session.add(v)
        session.flush()
    ev = RadarEvent(variant_id=v.id, type="BUYBOX_LOST", old_value="True", new_value="False", created_at=at,
                    dedupe_key=f"{vid}:{at.isoformat()}", details={"title": "کالا", "our_price": 100, "buy_box_price": 90})
    session.add(ev)
    session.flush()
    return ev


NIGHT = datetime(2026, 11, 14, 21, 0, tzinfo=timezone.utc)   # 00:30 Tehran
DAY = datetime(2026, 11, 14, 9, 0, tzinfo=timezone.utc)      # 12:30 Tehran


async def test_default_quiet_hours_apply_without_any_saved_setting(session):
    d = Dispatcher(Settings(), {}, emit=lambda m: None)
    assert (await d.dispatch(session, [mkevent(session, "1", NIGHT)], NIGHT))[0][1] == "suppressed_quiet"
    assert (await d.dispatch(session, [mkevent(session, "2", DAY)], DAY))[0][1] == "dry_run"


async def test_saved_quiet_off_lets_night_alerts_through(session):
    save_ui_settings(session, report_hour=8, quiet_enabled=False, quiet_start=23, quiet_end=7, notify_enabled=False)
    d = Dispatcher(Settings(), {}, emit=lambda m: None)
    assert (await d.dispatch(session, [mkevent(session, "1", NIGHT)], NIGHT))[0][1] == "dry_run"


async def test_saved_quiet_window_changes_the_boundary(session):
    save_ui_settings(session, report_hour=8, quiet_enabled=True, quiet_start=13, quiet_end=14, notify_enabled=False)
    d = Dispatcher(Settings(), {}, emit=lambda m: None)
    assert (await d.dispatch(session, [mkevent(session, "1", DAY)], DAY))[0][1] == "dry_run"            # 12:30 is NOT in 13-14
    at = datetime(2026, 11, 14, 9, 45, tzinfo=timezone.utc)                                                 # 13:15 Tehran
    assert (await d.dispatch(session, [mkevent(session, "2", at)], at))[0][1] == "suppressed_quiet"


async def test_saved_notify_on_sends_for_real_only_with_credentials(session):
    seen = []
    transport = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={"ok": True}))
    save_ui_settings(session, report_hour=8, quiet_enabled=False, quiet_start=23, quiet_end=7, notify_enabled=True)
    s = Settings(notify_channels="telegram", **TG)
    d = Dispatcher(s, {"telegram": TelegramNotifier(TG["telegram_bot_token"], TG["telegram_chat_id"], transport)}, emit=lambda m: None)
    assert (await d.dispatch(session, [mkevent(session, "1", DAY)], DAY))[0][1] == "sent" and len(seen) == 1
    # same saved switch, but credentials missing -> dry-run and nothing is sent
    d2 = Dispatcher(Settings(), {"telegram": TelegramNotifier("t", "c", transport)}, emit=lambda m: None)
    assert (await d2.dispatch(session, [mkevent(session, "2", DAY)], DAY))[0][1] == "dry_run" and len(seen) == 1


async def test_saved_notify_off_overrides_env_on(session):
    seen = []
    transport = httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200))
    save_ui_settings(session, report_hour=8, quiet_enabled=False, quiet_start=23, quiet_end=7, notify_enabled=False)
    s = Settings(notify_enabled=True, notify_channels="telegram", **TG)
    d = Dispatcher(s, {"telegram": TelegramNotifier(TG["telegram_bot_token"], TG["telegram_chat_id"], transport)}, emit=lambda m: None)
    assert (await d.dispatch(session, [mkevent(session, "1", DAY)], DAY))[0][1] == "dry_run" and not seen
