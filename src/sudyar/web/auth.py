"""Web auth: optional password (hashed, constant-time compare), session cookie, CSRF, login throttle."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
ITERATIONS = 200_000
MAX_FAILS = 5
FAIL_WINDOW_SECONDS = 300


class WebConfigError(Exception):
    """The web server refuses to start with this configuration (message is safe to print)."""


def check_bind(host: str, password: str | None, allow_container_bind: bool = False) -> None:
    """A non-localhost bind needs WEB_PASSWORD. (Compose sets allow_container_bind because it publishes the
    port on the host's 127.0.0.1 only; the process inside the container must listen on 0.0.0.0.)"""
    if host in LOCAL_HOSTS:
        return
    if password:
        return
    if allow_container_bind:
        return
    raise WebConfigError(
        f"Refusing to start: --host {host} is reachable from other computers but WEB_PASSWORD is not set. "
        "Set WEB_PASSWORD in .env, or use --host 127.0.0.1.")


class PasswordGate:
    """Holds only a salted hash of the password (never the plain text) and compares in constant time."""

    def __init__(self, password: str | None):
        self.enabled = bool(password)
        self._salt = os.urandom(16)
        self._hash = self._derive(password) if password else b""

    def _derive(self, pw: str) -> bytes:
        return hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), self._salt, ITERATIONS)

    def check(self, candidate: str) -> bool:
        if not self.enabled:
            return True
        return hmac.compare_digest(self._derive(candidate or ""), self._hash)


class LoginThrottle:
    """At most MAX_FAILS wrong passwords per client per 5 minutes."""

    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._fails: dict[str, deque[float]] = defaultdict(deque)

    def _prune(self, key: str) -> deque[float]:
        q = self._fails[key]
        while q and self._clock() - q[0] > FAIL_WINDOW_SECONDS:
            q.popleft()
        return q

    def blocked(self, key: str) -> bool:
        return len(self._prune(key)) >= MAX_FAILS

    def fail(self, key: str) -> None:
        self._prune(key).append(self._clock())

    def reset(self, key: str) -> None:
        self._fails.pop(key, None)


def new_csrf_token() -> str:
    return secrets.token_urlsafe(32)


def csrf_valid(expected: str | None, given: str | None) -> bool:
    return bool(expected) and bool(given) and hmac.compare_digest(expected, given)
