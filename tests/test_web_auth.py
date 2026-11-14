import re

import pytest

from sudyar import __main__ as cli
from sudyar.web.app import create_app
from sudyar.web.auth import LoginThrottle, PasswordGate, WebConfigError, check_bind, csrf_valid
from webfx import PASSWORD, client, make_app, make_factory, make_settings, seed

PAGES = ["/", "/radar", "/floor", "/settings", "/partials/profit", "/floor/1001"]


def token_from(html: str) -> str:
    return re.search(r'name="csrf_token" value="([^"]+)"', html).group(1)


def login(c, password=PASSWORD):
    page = c.get("/login")
    return c.post("/login", data={"password": password, "csrf_token": token_from(page.text)}, follow_redirects=False)


@pytest.fixture
def protected():
    f = make_factory()
    seed(f)
    return client(make_app(f, web_password=PASSWORD))


# ---------------- bind rule ----------------
@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.20", "::", "myserver.local"])
def test_non_local_bind_without_password_is_refused(host):
    with pytest.raises(WebConfigError, match="WEB_PASSWORD"):
        create_app(make_settings(), make_factory(), bind_host=host)
    with pytest.raises(WebConfigError):
        check_bind(host, None)
    with pytest.raises(WebConfigError):
        check_bind(host, "")                                    # an empty password is no password


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_local_bind_needs_no_password(host):
    assert create_app(make_settings(), make_factory(), bind_host=host) is not None


def test_non_local_bind_with_password_is_allowed():
    assert create_app(make_settings(), make_factory(), bind_host="0.0.0.0", web_password="x") is not None


def test_container_bind_escape_is_explicit_only():
    assert create_app(make_settings(), make_factory(), bind_host="0.0.0.0", allow_container_bind=True) is not None
    with pytest.raises(WebConfigError):
        create_app(make_settings(), make_factory(), bind_host="0.0.0.0", allow_container_bind=False)


def test_cli_web_refuses_without_password_and_never_starts_a_server(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "t")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'x.db'}")
    for k in ("WEB_PASSWORD", "WEB_ALLOW_CONTAINER_BIND"):
        monkeypatch.delenv(k, raising=False)
    import uvicorn
    monkeypatch.setattr(uvicorn, "run", lambda *a, **k: pytest.fail("server must not start"))
    assert cli.main(["web", "--host", "0.0.0.0"]) == 1
    assert "WEB_PASSWORD" in capsys.readouterr().out


def test_cli_web_starts_on_localhost_and_with_password(monkeypatch, tmp_path, capsys):
    import uvicorn
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **k: calls.append(k))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "t")
    monkeypatch.setenv("POSTGRES_PASSWORD", "p")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'x.db'}")
    monkeypatch.delenv("WEB_PASSWORD", raising=False)
    assert cli.main(["web"]) == 0
    assert calls[-1]["host"] == "127.0.0.1" and calls[-1]["port"] == 8080
    monkeypatch.setenv("WEB_PASSWORD", "s3cret-pass")
    assert cli.main(["web", "--host", "0.0.0.0", "--port", "9090"]) == 0
    out = capsys.readouterr().out
    assert calls[-1]["host"] == "0.0.0.0" and calls[-1]["port"] == 9090 and "s3cret-pass" not in out
    monkeypatch.setenv("WEB_ALLOW_CONTAINER_BIND", "1")
    monkeypatch.delenv("WEB_PASSWORD")
    assert cli.main(["web", "--host", "0.0.0.0"]) == 0                    # what docker compose does
    assert cli.main(["web", "--port", "0"]) == 2


def test_compose_publishes_web_on_host_loopback_only():
    from pathlib import Path
    t = (Path(__file__).resolve().parent.parent / "docker-compose.yml").read_text()
    web = t[t.index("  web:"):t.index("volumes:\n  pgdata:")]
    assert '"127.0.0.1:8080:8080"' in web and "WEB_ALLOW_CONTAINER_BIND" in web and "/healthz" in web
    assert "0.0.0.0:8080" not in web and '"8080:8080"' not in web


# ---------------- password gate ----------------
def test_password_is_stored_hashed_and_compared_constant_time():
    g = PasswordGate("hunter2-secret")
    assert g.enabled and g.check("hunter2-secret") and not g.check("hunter2-secreT") and not g.check("") and not g.check(None)
    dumped = repr(vars(g))
    assert "hunter2-secret" not in dumped and len(g._hash) == 32 and len(g._salt) == 16
    assert PasswordGate("hunter2-secret")._hash != g._hash                       # random salt per start
    open_gate = PasswordGate(None)
    assert not open_gate.enabled and open_gate.check("anything")


def test_login_throttle_blocks_then_expires():
    now = [0.0]
    t = LoginThrottle(clock=lambda: now[0])
    for _ in range(5):
        assert not t.blocked("ip")
        t.fail("ip")
    assert t.blocked("ip") and not t.blocked("other")
    now[0] = 301
    assert not t.blocked("ip")
    t.fail("ip"); t.reset("ip")
    assert not t.blocked("ip")


def test_csrf_compare():
    assert csrf_valid("abc", "abc") and not csrf_valid("abc", "abd") and not csrf_valid("abc", "")
    assert not csrf_valid(None, "abc") and not csrf_valid("", "") and not csrf_valid("abc", None)


# ---------------- login flow ----------------
@pytest.mark.parametrize("path", PAGES)
def test_every_page_requires_login(protected, path):
    r = protected.get(path, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"


def test_htmx_request_without_login_gets_401_and_hx_redirect(protected):
    r = protected.get("/partials/profit", headers={"HX-Request": "true"}, follow_redirects=False)
    assert r.status_code == 401 and r.headers["hx-redirect"] == "/login"


def test_public_routes_stay_public(protected):
    for path in ("/healthz", "/login", "/manifest.webmanifest", "/sw.js", "/static/app.css"):
        assert protected.get(path, follow_redirects=False).status_code == 200


def test_wrong_password_401_then_right_password_logs_in(protected):
    bad = login(protected, "wrong")
    assert bad.status_code == 401 and "رمز درست نیست" in bad.text
    assert protected.get("/", follow_redirects=False).status_code == 303
    ok = login(protected)
    assert ok.status_code == 303 and ok.headers["location"] == "/"
    for path in PAGES:
        assert protected.get(path).status_code == 200, path


def test_password_never_appears_in_any_response(protected):
    login(protected)
    for path in PAGES + ["/login"]:
        assert PASSWORD not in protected.get(path).text


def test_login_throttle_returns_429_after_five_failures(protected):
    for _ in range(5):
        assert login(protected, "nope").status_code == 401
    r = login(protected, PASSWORD)                          # even the right password is refused while blocked
    assert r.status_code == 429 and "تلاش بیش از حد" in r.text


def test_session_is_rotated_on_login(protected):
    before = token_from(protected.get("/login").text)
    login(protected)
    after = token_from(protected.get("/settings").text)
    assert before != after                                  # new CSRF token + new session after login


def test_logout_clears_the_session(protected):
    login(protected)
    tok = token_from(protected.get("/settings").text)
    r = protected.post("/logout", data={"csrf_token": tok}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert protected.get("/", follow_redirects=False).status_code == 303


def test_session_cookie_flags(protected):
    r = protected.get("/login")
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "sudyar_session" in cookie


def test_https_only_cookie_option():
    c = client(make_app(https_only_cookie=True))
    assert "secure" in c.get("/").headers["set-cookie"].lower()


def test_open_mode_login_page_redirects_home():
    c = client(make_app())                                  # no WEB_PASSWORD (localhost mode)
    assert c.get("/login", follow_redirects=False).headers["location"] == "/"
    assert c.get("/").status_code == 200


# ---------------- CSRF ----------------
def alerts_form(**kw):
    return {"report_hour": "8", "quiet_mode": "quiet", "quiet_start": "23", "quiet_end": "7", **kw}


def test_post_without_csrf_token_is_403_and_changes_nothing():
    f = make_factory()
    c = client(make_app(f))
    c.get("/settings")                                      # session + token exist
    r = c.post("/settings/alerts", data=alerts_form(report_hour="11"), follow_redirects=False)
    assert r.status_code == 403
    from sudyar.models import AppSetting
    with f() as s:
        assert s.query(AppSetting).count() == 0


@pytest.mark.parametrize("bad", ["", "wrong-token", "a" * 43])
def test_post_with_wrong_csrf_token_is_403(bad):
    c = client(make_app())
    c.get("/settings")
    assert c.post("/settings/alerts", data={**alerts_form(), "csrf_token": bad}, follow_redirects=False).status_code == 403
    assert c.post("/settings/alerts", data=alerts_form(), headers={"X-CSRF-Token": bad}, follow_redirects=False).status_code == 403


def test_post_with_a_token_from_another_session_is_403():
    other = client(make_app())
    tok = token_from(other.get("/settings").text)
    victim = client(make_app())
    victim.get("/settings")
    assert victim.post("/settings/alerts", data={**alerts_form(), "csrf_token": tok}, follow_redirects=False).status_code == 403


def test_post_without_any_session_is_403():
    assert client(make_app()).post("/settings/alerts", data=alerts_form(), follow_redirects=False).status_code == 403


def test_htmx_header_token_is_accepted_and_form_token_too():
    c = client(make_app())
    tok = token_from(c.get("/settings").text)
    assert c.post("/settings/alerts", data=alerts_form(), headers={"X-CSRF-Token": tok}, follow_redirects=False).status_code == 303
    assert c.post("/settings/alerts", data={**alerts_form(), "csrf_token": tok}, follow_redirects=False).status_code == 303


def test_body_carries_the_csrf_header_for_htmx_and_forms_carry_the_token():
    c = client(make_app())
    html = c.get("/settings").text
    tok = token_from(html)
    assert f'hx-headers=\'{{"X-CSRF-Token": "{tok}"}}\'' in html


def test_login_and_logout_also_need_csrf(protected):
    r = protected.post("/login", data={"password": PASSWORD}, follow_redirects=False)
    assert r.status_code == 403
    assert protected.get("/", follow_redirects=False).status_code == 303
    login(protected)
    assert protected.post("/logout", data={}, follow_redirects=False).status_code == 403
    assert protected.get("/", follow_redirects=False).status_code == 200


def test_get_requests_never_change_state():
    f = make_factory()
    seed(f)
    c = client(make_app(f))
    from sudyar.models import AppSetting
    for path in PAGES:
        c.get(path)
    with f() as s:
        assert s.query(AppSetting).count() == 0


def test_state_changing_methods_are_not_routed_on_pages():
    c = client(make_app())
    for path in ("/", "/radar", "/floor", "/settings"):
        assert c.post(path, follow_redirects=False).status_code in (403, 404, 405)
        assert c.put(path).status_code in (404, 405)
        assert c.delete(path).status_code in (404, 405)
