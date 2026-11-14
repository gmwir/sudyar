"""Digikala Service Hub OAuth 2.0 (seller consent). Source: Service Hub academy guide "راهنمای احراز هویت فروشنده".

Flow: seller is sent to the consent page -> Digikala redirects back with an RSA-encrypted authorization_code
(valid 5 minutes) -> we decrypt it with OUR private key -> POST /open-api/v1/auth/token -> access token (2 h)
+ refresh token (1 year) -> refresh with POST /open-api/v1/auth/refresh-token (max 600/hour, both tokens rotate).

Safety:
- The ONLY HTTP calls in this module are those two POSTs to the auth endpoints. Seller data is still read only
  through DigikalaClient (GET-only). Nothing here can change a price, an order or a product.
- Tokens are stored encrypted (Fernet, key SUDYAR_TOKEN_KEY); the decrypted code and tokens are never logged.
- Default scopes are read-only (".read" suffix, or scopes that only have read).
"""
from __future__ import annotations

import base64
import logging
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urlencode, urlsplit
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from sqlalchemy.orm import Session

from .models import SellerConnection, utcnow

log = logging.getLogger(__name__)

SELLER_PANEL_URL = "https://seller.digikala.com"
CONSENT_PATH = "/pwa/seller-services/consents"
TOKEN_PATH = "/open-api/v1/auth/token"
REFRESH_PATH = "/open-api/v1/auth/refresh-token"
AUTH_POST_PATHS = frozenset({TOKEN_PATH, REFRESH_PATH})
# Read-only by design. commission and insight exist only as read scopes.
# UNVERIFIED: whether "commission"/"insight" also accept a ".read" suffix; the guide lists them as read-only.
DEFAULT_SCOPES = "variant.read order.read commission insight"
WRITE_CAPABLE = {"product", "variant", "inventory", "order", "package", "shipment", "promotion", "voucher", "profile",
                 "question", "lightening_deal", "sbs_setting", "sbs_orders", "sbs_shipment", "search_ads"}
STATE_MAX_AGE = timedelta(minutes=10)
REFRESH_MARGIN = timedelta(minutes=10)
CONNECTION_ID = 1  # one seller per Sudyar install for now (multi-seller comes later)


class ServiceHubError(Exception):
    """A plain, safe message (never contains a token or code)."""


# ------------------------------------------------------------------ scopes / consent URL
def check_read_only_scopes(scopes: str) -> list[str]:
    """Scopes that could WRITE (no '.read' suffix on a write-capable scope). Empty list = all read-only."""
    return [sc for sc in scopes.split() if sc in WRITE_CAPABLE]


def build_consent_url(client_code: str, redirect_url: str, scopes: str, state: str) -> str:
    if not client_code:
        raise ServiceHubError("SERVICEHUB_CLIENT_CODE is not set (you get it when Digikala approves the app).")
    check_redirect_url(redirect_url)
    bad = check_read_only_scopes(scopes)
    if bad:
        raise ServiceHubError(f"Refusing write-capable scopes: {' '.join(bad)} (use .read)")
    q = urlencode({"client_code": client_code, "redirect_url": redirect_url, "scopes": scopes, "state": state})
    return f"{SELLER_PANEL_URL}{CONSENT_PATH}?{q}"


def check_redirect_url(url: str) -> None:
    p = urlsplit(url or "")
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.fragment:
        raise ServiceHubError("SERVICEHUB_REDIRECT_URL must be an https:// URL on your own domain.")


def new_state() -> str:
    return secrets.token_urlsafe(24)


# ------------------------------------------------------------------ RSA keys / code decryption
def generate_private_key_pem() -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


def public_key_pem(private_pem: bytes) -> str:
    """PKCS#8 SubjectPublicKeyInfo ('-----BEGIN PUBLIC KEY-----'), the format Digikala asks for at registration."""
    key = serialization.load_pem_private_key(private_pem, password=None)
    return key.public_key().public_bytes(serialization.Encoding.PEM,
                                         serialization.PublicFormat.SubjectPublicKeyInfo).decode()


def write_private_key(path: str) -> str:
    """Create the private key file (0600). Refuses to overwrite: a new key would break the registered app."""
    if os.path.exists(path):
        raise ServiceHubError(f"{path} already exists; it is never overwritten.")
    os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
    pem = generate_private_key_pem()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    return public_key_pem(pem)


def read_private_key(path: str) -> bytes:
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        raise ServiceHubError("The Service Hub private key file is missing. Run: python -m sudyar oauth-keygen") from None


def decrypt_authorization_code(encrypted: str, private_pem: bytes) -> str:
    """Guide: URL-decode -> Base64-decode -> RSA decrypt (PKCS#1 v1.5, as in the official Java sample).

    The web framework already URL-decoded the query value once; it may still hold %xx (double-encoded) and a '+'
    may have become a space. Both are handled.
    """
    value = (encrypted or "").strip()
    for _ in range(2):  # Base64 never contains '%': any '%' is leftover URL-encoding
        if "%" in value:
            value = unquote(value)
    value = value.replace(" ", "+")
    if not value or len(value) > 4096:
        raise ServiceHubError("The authorization code is missing or malformed.")
    try:
        raw = base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
    except ValueError:
        try:
            raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        except ValueError:
            raise ServiceHubError("The authorization code is not valid Base64.") from None
    key = serialization.load_pem_private_key(private_pem, password=None)
    try:
        code = key.decrypt(raw, padding.PKCS1v15())
    except ValueError:
        raise ServiceHubError("The authorization code could not be decrypted with our private key.") from None
    try:
        return code.decode("utf-8")
    except UnicodeDecodeError:
        raise ServiceHubError("The decrypted authorization code is not text.") from None


# ------------------------------------------------------------------ token encryption at rest
def make_fernet(key: str) -> Fernet:
    if not key:
        raise ServiceHubError("SUDYAR_TOKEN_KEY is not set (generate one with: python -m sudyar oauth-keygen).")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError):
        raise ServiceHubError("SUDYAR_TOKEN_KEY is invalid (it must be a Fernet key).") from None


def new_token_key() -> str:
    return Fernet.generate_key().decode()


# ------------------------------------------------------------------ HTTP: only the two auth POSTs
@dataclass(frozen=True)
class Tokens:
    access_token: str
    refresh_token: str
    access_expires_at: datetime
    refresh_expires_at: datetime | None


def parse_expiry(obj, fallback: datetime) -> datetime:
    """{"date": "2025-02-07 02:00:00.000000", "timezone": "Asia/Tehran"} -> aware UTC datetime."""
    try:
        tz = ZoneInfo(obj.get("timezone") or "Asia/Tehran")
        dt = datetime.strptime(obj["date"].split(".")[0], "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz)
        return dt.astimezone(timezone.utc)
    except Exception:  # unknown shape: be conservative
        return fallback


def parse_tokens(body: dict, now: datetime) -> Tokens:
    if not isinstance(body, dict):
        raise ServiceHubError("Unexpected token response.")
    data = body.get("data") if isinstance(body.get("data"), dict) and "access_token" in body["data"] else body
    access, refresh = data.get("access_token"), data.get("refresh_token")
    if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
        raise ServiceHubError("The token response has no access_token/refresh_token.")
    acc_exp = parse_expiry(data.get("access_token_expires_at") or {}, now + timedelta(hours=1, minutes=50))
    ref_exp = parse_expiry(data.get("refresh_token_expires_at") or {}, None) if data.get("refresh_token_expires_at") else None
    return Tokens(access, refresh, acc_exp, ref_exp)


class AuthClient:
    """Talks to exactly two endpoints: POST /open-api/v1/auth/token and POST /open-api/v1/auth/refresh-token."""

    def __init__(self, base_url: str = SELLER_PANEL_URL, transport: httpx.BaseTransport | None = None, timeout: float = 20):
        self._http = httpx.Client(base_url=base_url, timeout=timeout, transport=transport,
                                  headers={"content-type": "application/json"}, follow_redirects=False)

    def close(self) -> None:
        self._http.close()

    def _post(self, path: str, body: dict, now: datetime) -> Tokens:
        if path not in AUTH_POST_PATHS:
            raise ServiceHubError("Blocked: only the two Service Hub auth endpoints may be called here.")
        try:
            r = self._http.post(path, json=body)
        except httpx.HTTPError:
            raise ServiceHubError("Could not reach Digikala (network error).") from None
        if r.status_code != 200:
            log.warning("Service Hub auth %s -> HTTP %s", path, r.status_code)  # no body: it may echo secrets
            reason = {400: "the request or code was rejected (maybe expired: try connecting again)",
                      401: "the app is not approved/active or the token expired",
                      429: "too many refresh requests (limit 600/hour)"}.get(r.status_code, f"HTTP {r.status_code}")
            raise ServiceHubError(f"Digikala refused: {reason}.")
        try:
            return parse_tokens(r.json(), now)
        except ValueError:
            raise ServiceHubError("The token response is not JSON.") from None

    def exchange_code(self, code: str, now: datetime) -> Tokens:
        return self._post(TOKEN_PATH, {"authorization_code": code}, now)

    def refresh(self, access_token: str, refresh_token: str, now: datetime) -> Tokens:
        return self._post(REFRESH_PATH, {"access_token": access_token, "refresh_token": refresh_token}, now)


# ------------------------------------------------------------------ storage
def save_tokens(session: Session, fernet: Fernet, tokens: Tokens, scopes: str, now: datetime, *, new: bool) -> None:
    row = session.get(SellerConnection, CONNECTION_ID)
    if row is None:
        row = SellerConnection(id=CONNECTION_ID, connected_at=now)
        session.add(row)
    elif new:
        row.connected_at = now
    row.scopes = scopes
    row.access_token_enc = fernet.encrypt(tokens.access_token.encode()).decode()
    row.refresh_token_enc = fernet.encrypt(tokens.refresh_token.encode()).decode()
    row.access_expires_at = tokens.access_expires_at
    row.refresh_expires_at = tokens.refresh_expires_at
    row.updated_at = now
    row.last_error = None
    session.commit()


def disconnect(session: Session) -> bool:
    row = session.get(SellerConnection, CONNECTION_ID)
    if row is None:
        return False
    session.delete(row)
    session.commit()
    return True


@dataclass(frozen=True)
class ConnectionStatus:
    connected: bool
    scopes: str = ""
    connected_at: datetime | None = None
    access_expires_at: datetime | None = None
    refresh_expires_at: datetime | None = None
    last_error: str | None = None


def connection_status(session: Session) -> ConnectionStatus:
    row = session.get(SellerConnection, CONNECTION_ID)
    if row is None:
        return ConnectionStatus(False)
    return ConnectionStatus(True, row.scopes or "", row.connected_at, _aware(row.access_expires_at),
                            _aware(row.refresh_expires_at), row.last_error)


def _aware(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


def access_token(session: Session, fernet: Fernet, auth: AuthClient, now: datetime | None = None) -> str:
    """A valid access token, refreshing it first if it expires within 10 minutes (both tokens rotate)."""
    now = now or utcnow()
    row = session.get(SellerConnection, CONNECTION_ID)
    if row is None:
        raise ServiceHubError("No seller is connected yet. Open the web page > Settings > Connect to Digikala.")
    try:
        acc = fernet.decrypt(row.access_token_enc.encode()).decode()
        ref = fernet.decrypt(row.refresh_token_enc.encode()).decode()
    except InvalidToken:
        raise ServiceHubError("Stored tokens cannot be decrypted (SUDYAR_TOKEN_KEY changed?). Connect again.") from None
    exp = _aware(row.access_expires_at)
    if exp is not None and exp - now > REFRESH_MARGIN:
        return acc
    ref_exp = _aware(row.refresh_expires_at)
    if ref_exp is not None and ref_exp <= now:
        raise ServiceHubError("The 1-year access has expired. Connect again from the web page.")
    try:
        t = auth.refresh(acc, ref, now)
    except ServiceHubError as e:
        row.last_error = str(e)[:300]
        session.commit()
        raise
    save_tokens(session, fernet, t, row.scopes or "", now, new=False)
    return t.access_token
