"""The web UI is read-only and offline: no sockets, no Digikala client, no CDN, no external URLs."""
import re
import socket
from pathlib import Path

import pytest

from webfx import PASSWORD, client, make_app, make_factory, seed

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "src" / "sudyar" / "web"
PAGES = ["/", "/radar", "/radar?tier=HOT", "/floor", "/floor?status=needs_cost", "/floor/1001", "/floor/1002", "/floor/1003",
         "/settings", "/partials/profit", "/healthz", "/manifest.webmanifest", "/sw.js"]


@pytest.fixture
def offline(monkeypatch):
    def blocked(*a, **k):
        raise AssertionError("the web UI tried to open a network connection")
    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket.socket, "connect_ex", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)
    import sudyar.digikala_client as dc
    monkeypatch.setattr(dc.DigikalaClient, "__init__", lambda *a, **k: (_ for _ in ()).throw(AssertionError("Digikala client created")))
    import httpx
    monkeypatch.setattr(httpx.AsyncClient, "request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("HTTP request")))


@pytest.mark.parametrize("protected", [False, True])
def test_all_pages_work_with_the_network_blocked(offline, protected):
    f = make_factory()
    seed(f)
    c = client(make_app(f, web_password=PASSWORD if protected else None))
    if protected:
        tok = re.search(r'name="csrf_token" value="([^"]+)"', c.get("/login").text).group(1)
        assert c.post("/login", data={"password": PASSWORD, "csrf_token": tok}, follow_redirects=False).status_code == 303
    for path in PAGES:
        r = c.get(path, follow_redirects=False)
        assert r.status_code == 200, (path, r.status_code)


def test_saving_settings_touches_only_our_database_never_the_network(offline):
    f = make_factory()
    c = client(make_app(f))
    tok = re.search(r'name="csrf_token" value="([^"]+)"', c.get("/settings").text).group(1)
    r = c.post("/settings/alerts", data={"csrf_token": tok, "report_hour": "9", "quiet_mode": "always",
                                         "quiet_start": "23", "quiet_end": "7"}, follow_redirects=False)
    assert r.status_code == 303


def test_rendered_pages_load_nothing_from_other_hosts():
    f = make_factory()
    seed(f)
    c = client(make_app(f))
    allowed = {"/static/", "/manifest.webmanifest"}
    for path in PAGES[:10]:
        html = c.get(path).text
        for url in re.findall(r'(?:src|href|action|hx-get|hx-post)="([^"]+)"', html):
            assert not re.match(r"^(https?:)?//", url), (path, url)
        assert not re.search(r"https?://", re.sub(r'xmlns="[^"]*"', "", html)), path


def test_static_files_and_templates_have_no_external_urls():
    allowed_substrings = ("www.w3.org/2000/svg",)       # SVG namespace, not a request
    for f in list((WEB / "templates").glob("*.html")) + [WEB / "static" / n for n in ("app.css", "app.js", "sw.js", "manifest.webmanifest")] \
            + list((WEB / "static" / "icons").glob("*.svg")) + [WEB / "static" / "sudyar-logo.svg"]:
        body = f.read_text(encoding="utf-8")
        for m in re.finditer(r"(https?:)?//[A-Za-z0-9.-]+\.[a-z]{2,}[^\s\"')]*", body):
            assert any(a in m.group(0) for a in allowed_substrings), (f.name, m.group(0))
        assert "cdn." not in body.lower() and "googleapis" not in body.lower() and "unpkg" not in body.lower()


def test_web_package_cannot_reach_digikala_or_write_anything_outside_our_db():
    for f in WEB.glob("*.py"):
        src = f.read_text()
        assert "digikala_client" not in src and "DigikalaClient" not in src, f.name
        assert not re.search(r"(?<!@app)\.(post|put|patch|delete)\(", src), f.name       # route decorators are fine; HTTP calls are not
        assert "httpx" not in src and "requests" not in src and "urllib" not in src, f.name
        assert "get_commissions_page" not in src and "get_sales_report_page" not in src and "get_winning_price" not in src


ALLOWED_WRITE_ROUTES = {("/login", ("POST",)), ("/logout", ("POST",)), ("/settings/alerts", ("POST",)),
                        ("/costs/upload", ("POST",)), ("/costs/apply", ("POST",)),
                        ("/costs/{variant_id}", ("POST",)), ("/costs/{variant_id}/clear", ("POST",)),
                        ("/connect/disconnect", ("POST",))}


def test_every_route_handler_that_writes_is_known():
    """Writers: login/logout (session only), alerts form (app_settings), buy-cost page (variant_costs + cost_audit),
    Service Hub disconnect (seller_connections). GET /oauth/callback also writes seller_connections, but only after a
    single-use server-side state matches (tests/test_servicehub.py)."""
    app = make_app()
    writes = {(r.path, tuple(sorted(r.methods))) for r in app.routes if hasattr(r, "methods") and r.methods & {"POST", "PUT", "PATCH", "DELETE"}}
    assert writes == ALLOWED_WRITE_ROUTES


def test_vendored_assets_documented_and_licensed():
    assert (WEB / "static" / "fonts" / "OFL.txt").is_file() and (WEB / "static" / "VENDORED.txt").is_file()
    assert "SIL OPEN FONT LICENSE" in (WEB / "static" / "fonts" / "OFL.txt").read_text().upper()
