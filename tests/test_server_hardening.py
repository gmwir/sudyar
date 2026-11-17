"""Server-phase hardening (review item 9): GET allow-list, proxy-aware login throttle key, Secure-cookie warning."""
import httpx
import pytest
from starlette.requests import Request

from sudyar.config import Settings
from sudyar.digikala_client import DigikalaClient, ReadOnlyViolation
from sudyar.web.app import client_key


def st():
    return Settings(digikala_self_token="tok-secret", postgres_password="pw")


async def test_get_refuses_paths_that_are_not_configured_read_endpoints(make_limiter):
    calls = []

    def handler(r):
        calls.append(r.url.path)
        return httpx.Response(200, json={"data": {"items": []}})

    c = DigikalaClient(st(), make_limiter(requests=1000), transport=httpx.MockTransport(handler))
    async with c:
        for bad in ("/open-api/v1/orders/123", "/open-api/v1/variants/5", "/open-api/v1/finance/x", "/open-api/v1/auth/token"):
            with pytest.raises(ReadOnlyViolation):
                await c.get(bad)
        assert calls == []  # refused before any network call
        await c.get(st().variants_path)
        assert calls == [st().variants_path]


def test_allowed_paths_are_exactly_the_configured_ones(make_limiter):
    s = st()
    c = DigikalaClient(s, make_limiter(requests=1000), transport=httpx.MockTransport(lambda r: httpx.Response(200)))
    assert c.allowed_paths() == {s.variants_path, s.commissions_path, s.sales_reports_path, s.buybox_price_path,
                                 s.nth_rank_price_path, s.orders_path}


def req(peer, xff=None):
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    return Request({"type": "http", "client": (peer, 1234), "headers": headers, "method": "POST", "path": "/login"})


def test_client_key_ignores_forwarded_header_from_untrusted_peer():
    assert client_key(req("1.2.3.4", "9.9.9.9"), ()) == "1.2.3.4"
    assert client_key(req("1.2.3.4", "9.9.9.9"), ("10.0.0.1",)) == "1.2.3.4"


def test_client_key_uses_rightmost_untrusted_hop_behind_trusted_proxy():
    trusted = ("10.0.0.1", "10.0.0.2")
    assert client_key(req("10.0.0.1", "6.6.6.6, 5.5.5.5"), trusted) == "5.5.5.5"  # left part can be forged
    assert client_key(req("10.0.0.1", "5.5.5.5, 10.0.0.2"), trusted) == "5.5.5.5"
    assert client_key(req("10.0.0.1"), trusted) == "10.0.0.1"


def test_web_cmd_warns_when_exposed_without_https_only_cookie(monkeypatch, capsys):
    import sys
    import types

    from sudyar import __main__ as m

    monkeypatch.setenv("WEB_PASSWORD", "a-long-test-password-123")
    monkeypatch.delenv("WEB_HTTPS_ONLY_COOKIE", raising=False)
    monkeypatch.setattr(m, "load_settings", st)
    monkeypatch.setattr("sudyar.web.app.create_app", lambda *a, **k: object())
    monkeypatch.setitem(sys.modules, "uvicorn", types.SimpleNamespace(run=lambda *a, **k: None))
    m.web_cmd(["--host", "0.0.0.0"])
    assert "HTTPS-only" in capsys.readouterr().out
    monkeypatch.setenv("WEB_HTTPS_ONLY_COOKIE", "1")
    m.web_cmd(["--host", "0.0.0.0"])
    assert "HTTPS-only" not in capsys.readouterr().out
