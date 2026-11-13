import logging
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from sudyar.config import Settings
from sudyar.models import RadarEvent, Variant
from sudyar.notifier import (BaleNotifier, Dispatcher, NotifyError, TelegramNotifier, in_quiet_hours,
                             render_message)

T0 = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
TG_TOKEN, TG_CHAT = "123456:SECRET-TG-TOKEN", "-1009988776655"


def mk(session, vid=1, etype="BUYBOX_LOST", at=T0, **details):
    v = session.query(Variant).filter_by(digikala_variant_id=str(vid)).first()
    if v is None:
        v = Variant(digikala_variant_id=str(vid), raw_json={})
        session.add(v)
        session.flush()
    d = {"title": "روغن موتور", "our_price": 1100, "buy_box_price": 1000, "gap_pct": 10.0, "gap_abs": 100,
         "suggested_price": 950, "cause": "price_above", **details}
    ev = RadarEvent(variant_id=v.id, type=etype, old_value="True", new_value="False", details=d,
                    created_at=at, dedupe_key=f"{vid}:{etype}:{at.isoformat()}")
    session.add(ev)
    session.flush()
    return ev


def settings(**kw):
    return Settings(telegram_bot_token=TG_TOKEN, telegram_chat_id=TG_CHAT, **kw)


class Rec:
    def __init__(self):
        self.sent = []

    async def send(self, text):
        self.sent.append(text)


def test_persian_template_has_all_fields(session):
    msg = render_message(mk(session))
    for part in ("روغن موتور", "1,100", "1,000", "10.0٪", "950", "قیمت ما بالاتر از قیمت باکس خرید است"):
        assert part in msg


def test_template_unknown_values(session):
    msg = render_message(mk(session, buy_box_price=None, gap_pct=None, gap_abs=None, suggested_price=None, cause="unknown"))
    assert msg.count("نامشخص") >= 4


async def test_dry_run_prints_and_never_sends(session):
    printed, rec = [], Rec()
    d = Dispatcher(settings(), {"telegram": rec}, emit=printed.append)   # NOTIFY_ENABLED defaults to false
    res = await d.dispatch(session, [mk(session)], T0)
    assert res[0][1] == "dry_run" and rec.sent == []
    assert "[DRY-RUN]" in printed[0] and "روغن موتور" in printed[0]


async def test_enabled_sends_via_telegram_url(session):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    n = TelegramNotifier(TG_TOKEN, TG_CHAT, httpx.MockTransport(handler))
    d = Dispatcher(settings(notify_enabled=True), {"telegram": n})
    res = await d.dispatch(session, [mk(session)], T0)
    assert res[0][1] == "sent"
    assert str(seen[0].url) == f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    import json
    body = json.loads(seen[0].content)
    assert body["chat_id"] == TG_CHAT and "روغن موتور" in body["text"]


async def test_bale_uses_configured_base(session):
    seen = []
    n = BaleNotifier("https://bale.example.test/", "BT", "42", httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200)))
    await n.send("hi")
    assert str(seen[0].url) == "https://bale.example.test/botBT/sendMessage"


async def test_cooldown_per_variant(session):
    d = Dispatcher(settings(), {}, emit=lambda m: None)
    a = mk(session, 1, "BUYBOX_LOST", T0)
    assert (await d.dispatch(session, [a], T0))[0][1] == "dry_run"
    b = mk(session, 1, "STOCK_OUT", T0 + timedelta(minutes=10))
    assert (await d.dispatch(session, [b], T0 + timedelta(minutes=10)))[0][1] == "suppressed_cooldown"
    other = mk(session, 2, "BUYBOX_LOST", T0 + timedelta(minutes=10))              # other variant not affected
    assert (await d.dispatch(session, [other], T0 + timedelta(minutes=10)))[0][1] == "dry_run"
    c = mk(session, 1, "DEACTIVATED", T0 + timedelta(minutes=31))
    assert (await d.dispatch(session, [c], T0 + timedelta(minutes=31)))[0][1] == "dry_run"


async def test_quiet_hours_suppress(session):
    s = settings(notify_quiet_start="23:00", notify_quiet_end="08:00", notify_timezone="Asia/Tehran")
    d = Dispatcher(s, {}, emit=lambda m: None)
    night = datetime(2026, 1, 1, 21, 0, tzinfo=timezone.utc)      # 00:30 Tehran
    assert (await d.dispatch(session, [mk(session, 1, at=night)], night))[0][1] == "suppressed_quiet"
    day = datetime(2026, 1, 1, 9, 0, tzinfo=timezone.utc)         # 12:30 Tehran
    assert (await d.dispatch(session, [mk(session, 2, at=day)], day))[0][1] == "dry_run"


def test_quiet_hours_logic():
    assert not in_quiet_hours(T0, "", "", "Asia/Tehran")
    assert in_quiet_hours(datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc), "10:00", "18:00", "UTC")
    assert not in_quiet_hours(datetime(2026, 1, 1, 19, 0, tzinfo=timezone.utc), "10:00", "18:00", "UTC")


async def test_only_configured_event_types_alert(session):
    d = Dispatcher(settings(), {}, emit=lambda m: None)
    assert await d.dispatch(session, [mk(session, 1, "PRICE_CHANGED")], T0) == []


async def test_secrets_never_logged_or_in_errors(session, caplog, capsys):
    caplog.set_level(logging.DEBUG)

    def boom(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")     # httpx puts the URL in messages

    n = TelegramNotifier(TG_TOKEN, TG_CHAT, httpx.MockTransport(boom))
    with pytest.raises(NotifyError) as e:
        await n.send("x")
    assert TG_TOKEN not in str(e.value) and TG_CHAT not in str(e.value)
    assert e.value.__cause__ is None and e.value.__suppress_context__

    bad = TelegramNotifier(TG_TOKEN, TG_CHAT, httpx.MockTransport(lambda r: httpx.Response(401)))
    d = Dispatcher(settings(notify_enabled=True), {"telegram": bad}, emit=print)
    res = await d.dispatch(session, [mk(session)], T0)
    assert res[0][1] == "failed"
    out = caplog.text + capsys.readouterr().out
    assert TG_TOKEN not in out and TG_CHAT not in out
    assert TG_TOKEN not in repr(settings()) and TG_CHAT not in settings().model_dump_json()


def test_redaction_filter_covers_notifier_secrets(monkeypatch):
    from sudyar.logging_setup import RedactSecrets
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", TG_TOKEN)
    monkeypatch.setenv("BALE_CHAT_ID", "55555555")
    rec = logging.LogRecord("x", logging.INFO, "f", 1, f"url bot{TG_TOKEN} chat 55555555", None, None)
    RedactSecrets().filter(rec)
    assert TG_TOKEN not in rec.msg and "55555555" not in rec.msg


def test_notify_config_validation():
    assert settings(notify_enabled=True).notify_problems() == []
    assert Settings(notify_enabled=True).notify_problems()        # token missing
    assert Settings(notify_enabled=True, notify_channels="bale", bale_bot_token="a", bale_chat_id="b").notify_problems()
    assert Settings().notify_problems() == []                     # dry-run needs nothing
