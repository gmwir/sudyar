"""Part 5b: Service Hub OAuth (consent -> encrypted code -> token -> refresh). No network: MockTransport only."""
import base64
import json
import os
import pathlib
import re
import stat
from datetime import timedelta
from urllib.parse import parse_qs, quote, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding
from sqlalchemy import select

from sudyar import servicehub as sh
from sudyar.digikala_client import DigikalaClient
from sudyar.models import SellerConnection
from webfx import NOW, PASSWORD, client, make_app, make_factory, make_settings

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEY = sh.new_token_key()
PRIV = sh.generate_private_key_pem()


def encrypt_for_us(code: str, priv=PRIV) -> str:
    pub = serialization.load_pem_private_key(priv, password=None).public_key()
    return base64.b64encode(pub.encrypt(code.encode(), padding.PKCS1v15())).decode()


def token_body(acc="ACC-1", ref="REF-1", acc_date="2026-11-14 17:30:00.000000"):
    return {"access_token": acc, "refresh_token": ref,
            "access_token_expires_at": {"date": acc_date, "timezone_type": 3, "timezone": "Asia/Tehran"},
            "refresh_token_expires_at": {"date": "2027-11-14 00:00:00.000000", "timezone_type": 3, "timezone": "Asia/Tehran"}}


class Recorder:
    def __init__(self, responses):
        self.calls, self.responses = [], list(responses)

    def __call__(self, request: httpx.Request):
        self.calls.append((request.method, request.url.path, json.loads(request.content or b"{}"),
                           request.headers.get("authorization")))
        status, body = self.responses.pop(0)
        return httpx.Response(status, json=body)


def auth_with(*responses):
    rec = Recorder(responses)
    return sh.AuthClient(transport=httpx.MockTransport(rec)), rec


# ------------------------------------------------------------------ pure parts
def test_consent_url_is_digikala_https_and_read_only():
    url = sh.build_consent_url("sudyar", "https://app.sudyarapp.ir/oauth/callback", sh.DEFAULT_SCOPES, "st1")
    p = urlsplit(url)
    assert (p.scheme, p.hostname, p.path) == ("https", "seller.digikala.com", "/pwa/seller-services/consents")
    q = parse_qs(p.query)
    assert q["client_code"] == ["sudyar"] and q["state"] == ["st1"] and q["scopes"] == [sh.DEFAULT_SCOPES]
    assert q["redirect_url"] == ["https://app.sudyarapp.ir/oauth/callback"]


@pytest.mark.parametrize("scopes", ["variant", "order.read order", "variant.read search_ads", "product"])
def test_write_capable_scopes_are_refused(scopes):
    with pytest.raises(sh.ServiceHubError):
        sh.build_consent_url("sudyar", "https://a.ir/cb", scopes, "s")


@pytest.mark.parametrize("url", ["http://a.ir/cb", "", "https://u:p@a.ir/cb", "https://a.ir/cb#x", "javascript:x"])
def test_redirect_url_must_be_plain_https(url):
    with pytest.raises(sh.ServiceHubError):
        sh.build_consent_url("sudyar", url, sh.DEFAULT_SCOPES, "s")


@pytest.mark.parametrize("mangle", [lambda c: c, quote, lambda c: c.replace("+", " "), lambda c: quote(quote(c))])
def test_decrypt_authorization_code_handles_url_encoding_and_plus(mangle):
    enc = encrypt_for_us("the-real-code-42")
    for _ in range(20):  # make sure a '+' appears in some ciphertext
        if "+" in enc:
            break
        enc = encrypt_for_us("the-real-code-42")
    assert sh.decrypt_authorization_code(mangle(enc), PRIV) == "the-real-code-42"


def test_decrypt_with_wrong_key_or_garbage_fails_safely():
    enc = encrypt_for_us("x", sh.generate_private_key_pem())
    with pytest.raises(sh.ServiceHubError):
        sh.decrypt_authorization_code(enc, PRIV)
    for bad in ("", "!!!", "a" * 5000):
        with pytest.raises(sh.ServiceHubError):
            sh.decrypt_authorization_code(bad, PRIV)


def test_keygen_writes_0600_never_overwrites_and_public_key_is_pkcs8(tmp_path):
    path = str(tmp_path / "secrets" / "k.pem")
    pub = sh.write_private_key(path)
    assert pub.startswith("-----BEGIN PUBLIC KEY-----")
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    before = open(path, "rb").read()
    with pytest.raises(sh.ServiceHubError):
        sh.write_private_key(path)
    assert open(path, "rb").read() == before
    assert sh.public_key_pem(before) == pub


def test_token_expiry_is_parsed_in_tehran_time():
    t = sh.parse_tokens(token_body(), NOW)
    assert t.access_expires_at == NOW + timedelta(hours=2)  # 17:30 Tehran = 14:00 UTC
    assert t.refresh_expires_at.year == 2027


# ------------------------------------------------------------------ HTTP: only the two auth POSTs
def test_auth_client_calls_only_the_two_auth_endpoints():
    auth, rec = auth_with((200, token_body()), (200, token_body("ACC-2", "REF-2")))
    auth.exchange_code("c1", NOW)
    auth.refresh("ACC-1", "REF-1", NOW)
    assert [(m, p) for m, p, *_ in rec.calls] == [("POST", sh.TOKEN_PATH), ("POST", sh.REFRESH_PATH)]
    assert rec.calls[0][2] == {"authorization_code": "c1"}
    assert rec.calls[1][2] == {"access_token": "ACC-1", "refresh_token": "REF-1"}
    with pytest.raises(sh.ServiceHubError):
        auth._post("/open-api/v1/orders/1", {}, NOW)
    assert len(rec.calls) == 2


def test_servicehub_module_has_a_single_post_call_and_no_other_writes():
    src = (ROOT / "src" / "sudyar" / "servicehub.py").read_text()
    assert len(re.findall(r"\.post\(", src)) == 1
    assert sorted(set(re.findall(r"_http\.(\w+)\(", src))) == ["close", "post"]  # HTTP: one POST, nothing else
    assert sh.AUTH_POST_PATHS == {"/open-api/v1/auth/token", "/open-api/v1/auth/refresh-token"}


def test_refused_token_request_gives_a_safe_message_without_secrets():
    auth, _ = auth_with((401, {"error": "unauthorized_client", "echo": "REF-SECRET"}))
    with pytest.raises(sh.ServiceHubError) as e:
        auth.refresh("ACC-SECRET", "REF-SECRET", NOW)
    assert "SECRET" not in str(e.value)


# ------------------------------------------------------------------ storage + refresh
def test_tokens_are_stored_encrypted_and_refreshed_near_expiry():
    factory, f = make_factory(), sh.make_fernet(KEY)
    with factory() as s:
        sh.save_tokens(s, f, sh.parse_tokens(token_body(), NOW), sh.DEFAULT_SCOPES, NOW, new=True)
        row = s.get(SellerConnection, 1)
        assert "ACC-1" not in row.access_token_enc and "REF-1" not in row.refresh_token_enc
        auth, rec = auth_with((200, token_body("ACC-2", "REF-2", "2026-11-14 19:30:00.000000")))
        assert sh.access_token(s, f, auth, NOW) == "ACC-1"                       # 2 h left: no refresh
        assert rec.calls == []
        assert sh.access_token(s, f, auth, NOW + timedelta(hours=1, minutes=55)) == "ACC-2"  # 5 min left: refresh
        assert rec.calls[0][2] == {"access_token": "ACC-1", "refresh_token": "REF-1"}
        assert sh.access_token(s, f, auth, NOW + timedelta(hours=2)) == "ACC-2"   # rotated tokens were saved


def test_refresh_failure_is_recorded_and_expired_year_requires_reconnect():
    factory, f = make_factory(), sh.make_fernet(KEY)
    with factory() as s:
        sh.save_tokens(s, f, sh.parse_tokens(token_body(), NOW), "", NOW, new=True)
        auth, _ = auth_with((401, {}))
        with pytest.raises(sh.ServiceHubError):
            sh.access_token(s, f, auth, NOW + timedelta(hours=3))
        assert s.get(SellerConnection, 1).last_error
        with pytest.raises(sh.ServiceHubError, match="1-year"):
            sh.access_token(s, f, auth, NOW + timedelta(days=400))


def test_wrong_token_key_cannot_read_tokens():
    factory = make_factory()
    with factory() as s:
        sh.save_tokens(s, sh.make_fernet(KEY), sh.parse_tokens(token_body(), NOW), "", NOW, new=True)
        with pytest.raises(sh.ServiceHubError, match="KEY"):
            sh.access_token(s, sh.make_fernet(sh.new_token_key()), sh.AuthClient(), NOW)


async def test_read_client_uses_the_oauth_token_and_stays_get_only(make_limiter):
    seen = []

    def handler(r):
        seen.append((r.method, r.headers.get("authorization")))
        return httpx.Response(200, json={"data": {"items": []}})

    st = make_settings(digikala_self_token="", servicehub_client_code="sudyar", token_key=KEY)
    c = DigikalaClient(st, make_limiter(requests=1000), transport=httpx.MockTransport(handler),
                       token_provider=lambda: "OAUTH-ACC")
    async with c:
        await c.get(st.variants_path)
    assert seen == [("GET", "Bearer OAUTH-ACC")]


def test_settings_accept_oauth_mode_without_self_token():
    st = make_settings(digikala_self_token="", servicehub_client_code="sudyar", token_key=KEY)
    assert st.oauth_mode and st.problems() == []
    assert make_settings(digikala_self_token="", servicehub_client_code="sudyar").problems()  # token key needed
    assert not make_settings().oauth_mode  # Self Token keeps working as before


# ------------------------------------------------------------------ web flow
def oauth_app(tmp_path, auth_responses=((200, token_body()),), **kw):
    key_file = tmp_path / "k.pem"
    key_file.write_bytes(PRIV)
    st = make_settings(servicehub_client_code="sudyar", servicehub_redirect_url="https://app.sudyarapp.ir/oauth/callback",
                       servicehub_private_key_file=str(key_file), token_key=KEY)
    factory = make_factory()
    made = []

    def af():
        a, rec = auth_with(*auth_responses)
        made.append(rec)
        return a

    app = make_app(factory, st, auth_client_factory=af, **kw)
    return client(app), factory, made


def start(c):
    r = c.get("/connect/start", follow_redirects=False)
    assert r.status_code == 303
    loc = urlsplit(r.headers["location"])
    assert loc.hostname == "seller.digikala.com"
    return parse_qs(loc.query)["state"][0]


def test_full_web_flow_connects_and_stores_encrypted_tokens(tmp_path):
    c, factory, made = oauth_app(tmp_path)
    state = start(c)
    c.cookies.clear()  # Digikala's redirect carries no login cookie (SameSite=Strict)
    r = c.get("/oauth/callback", params={"authorization_code": encrypt_for_us("code-9"), "state": state})
    assert r.status_code == 200 and "اتصال انجام شد" in r.text
    assert made[0].calls[0][1:3] == (sh.TOKEN_PATH, {"authorization_code": "code-9"})
    assert "ACC-1" not in r.text and "code-9" not in r.text
    with factory() as s:
        assert s.scalars(select(SellerConnection)).one().scopes == sh.DEFAULT_SCOPES
    r = c.get("/oauth/callback", params={"authorization_code": encrypt_for_us("code-9"), "state": state})
    assert r.status_code == 400 and len(made) == 1  # state is single use


def test_callback_rejects_unknown_state_and_handles_denial(tmp_path):
    c, factory, made = oauth_app(tmp_path)
    assert c.get("/oauth/callback", params={"authorization_code": "x", "state": "forged"}).status_code == 400
    state = start(c)
    r = c.get("/oauth/callback", params={"error": "access_denied", "state": state})
    assert r.status_code == 400 and "اجازه نداد" in r.text
    assert made == []
    with factory() as s:
        assert s.scalars(select(SellerConnection)).all() == []


def test_connect_start_needs_login_and_full_config(tmp_path):
    c, _, _ = oauth_app(tmp_path, web_password=PASSWORD)
    r = c.get("/connect/start", follow_redirects=False)
    assert r.status_code in (302, 303) and "login" in r.headers["location"]
    bare = client(make_app())
    r = bare.get("/connect/start", follow_redirects=False)
    assert r.status_code == 409 and "seller.digikala.com" not in r.headers.get("location", "")


def test_disconnect_needs_csrf_and_removes_tokens(tmp_path):
    c, factory, _ = oauth_app(tmp_path)
    state = start(c)
    c.get("/oauth/callback", params={"authorization_code": encrypt_for_us("c"), "state": state})
    assert c.post("/connect/disconnect", data={}).status_code == 403
    page = c.get("/connect").text
    tok = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
    assert c.post("/connect/disconnect", data={"csrf_token": tok}, follow_redirects=False).status_code == 303
    with factory() as s:
        assert s.scalars(select(SellerConnection)).all() == []
