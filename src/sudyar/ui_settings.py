"""Settings edited in the web UI, stored in app_settings. Defaults mirror the app's own defaults.

Effective values = what the user saved, else the default. Saving "notify on" only takes effect if the
alert channel credentials exist in .env (otherwise the app stays in dry-run). Nothing here ever holds a secret.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import AppSetting, utcnow

log = logging.getLogger(__name__)

DEFAULT_REPORT_HOUR = 8
DEFAULT_QUIET_START = 23
DEFAULT_QUIET_END = 7


class UiSettingsError(ValueError):
    """Invalid value from the form (message is short Persian text, safe to show)."""


@dataclass(frozen=True)
class UiSettings:
    report_hour: int = DEFAULT_REPORT_HOUR
    quiet_enabled: bool = True
    quiet_start: int = DEFAULT_QUIET_START
    quiet_end: int = DEFAULT_QUIET_END
    notify_enabled: bool | None = None  # None = not saved yet: the .env value (default off = dry-run) applies
    saved: bool = False  # True if anything was ever saved


def _hour(v, name: str) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, str)) or (isinstance(v, str) and not v.strip().isdigit()):
        raise UiSettingsError(f"{name}: عدد ساعت نامعتبر است")
    h = int(v)
    if not 0 <= h <= 23:
        raise UiSettingsError(f"{name}: ساعت باید بین ۰ تا ۲۳ باشد")
    return h


def load_ui_settings(session: Session) -> UiSettings:
    """Never raises: if the table is missing (old database) the defaults are used."""
    try:
        rows = {r.key: r.value for r in session.scalars(select(AppSetting))}
    except Exception as e:
        session.rollback()
        log.warning("app_settings unreadable: %s", type(e).__name__)
        return UiSettings()
    def pick(key, default, check):
        try:
            return check(rows[key]) if key in rows else default
        except (UiSettingsError, TypeError, ValueError):
            return default  # a corrupt stored value falls back to the default
    notify = rows.get("notify_enabled")
    return UiSettings(
        report_hour=pick("report_hour", DEFAULT_REPORT_HOUR, lambda v: _hour(v, "report_hour")),
        quiet_enabled=bool(rows["quiet_enabled"]) if isinstance(rows.get("quiet_enabled"), bool) else True,
        quiet_start=pick("quiet_start", DEFAULT_QUIET_START, lambda v: _hour(v, "quiet_start")),
        quiet_end=pick("quiet_end", DEFAULT_QUIET_END, lambda v: _hour(v, "quiet_end")),
        notify_enabled=notify if isinstance(notify, bool) else None,
        saved=bool(rows),
    )


def save_ui_settings(session: Session, *, report_hour, quiet_enabled: bool, quiet_start, quiet_end,
                     notify_enabled: bool, now: datetime | None = None) -> UiSettings:
    """Validate and store. Raises UiSettingsError (short Persian message) on a bad value."""
    values = {
        "report_hour": _hour(report_hour, "ساعت گزارش"),
        "quiet_enabled": bool(quiet_enabled),
        "quiet_start": _hour(quiet_start, "شروع ساعت آرام"),
        "quiet_end": _hour(quiet_end, "پایان ساعت آرام"),
        "notify_enabled": bool(notify_enabled),
    }
    if values["quiet_enabled"] and values["quiet_start"] == values["quiet_end"]:
        raise UiSettingsError("شروع و پایان ساعت آرام نباید یکی باشد")
    now = now or utcnow()
    for k, v in values.items():
        row = session.get(AppSetting, k)
        if row is None:
            session.add(AppSetting(key=k, value=v, updated_at=now))
        else:
            row.value, row.updated_at = v, now
    session.commit()
    return load_ui_settings(session)


def effective_settings(session: Session, s: Settings) -> Settings:
    """The Settings the notifier should use: .env values overridden by what was saved in the UI.

    Safety: notifying for real needs working channel credentials in .env; without them it stays dry-run.
    """
    ui = load_ui_settings(session)
    update: dict = {}
    if ui.saved:
        update["notify_quiet_start"] = f"{ui.quiet_start:02d}:00" if ui.quiet_enabled else ""
        update["notify_quiet_end"] = f"{ui.quiet_end:02d}:00" if ui.quiet_enabled else ""
    if ui.notify_enabled is not None:
        update["notify_enabled"] = ui.notify_enabled
    eff = s.model_copy(update=update) if update else s
    if eff.notify_enabled and eff.notify_problems():
        eff = eff.model_copy(update={"notify_enabled": False})  # no credentials: stay in dry-run
    return eff
