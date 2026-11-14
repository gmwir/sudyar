"""Settings > "Connect to Digikala" (Service Hub OAuth). The HTTP part lives in sudyar.servicehub (two auth POSTs only)."""
from __future__ import annotations

import os
import secrets
import threading
import time
from dataclasses import dataclass

from .. import servicehub as sh

STATE_TTL = 10 * 60


class OAuthStates:
    """Server-side, single-use consent states (10 minutes).

    Kept here and not in the login cookie: the cookie is SameSite=Strict, so the browser does not send it when
    Digikala redirects back to /oauth/callback. Only a logged-in owner can create a state (GET /connect/start).
    """

    def __init__(self, clock=time.monotonic, max_items: int = 20):
        self._clock, self._max = clock, max_items
        self._items: dict[str, float] = {}
        self._lock = threading.Lock()

    def issue(self) -> str:
        st = sh.new_state()
        with self._lock:
            self._purge()
            while len(self._items) >= self._max:
                self._items.pop(next(iter(self._items)))
            self._items[st] = self._clock() + STATE_TTL
        return st

    def consume(self, state: str) -> bool:
        if not state or len(state) > 200:
            return False
        with self._lock:
            self._purge()
            for k in list(self._items):
                if secrets.compare_digest(k, state):
                    del self._items[k]  # single use
                    return True
        return False

    def _purge(self) -> None:
        now = self._clock()
        for k in [k for k, exp in self._items.items() if exp <= now]:
            del self._items[k]


@dataclass(frozen=True)
class Readiness:
    client_code: bool
    redirect_url: str
    redirect_ok: bool
    private_key: bool
    token_key: bool
    scopes: str
    scopes_ok: bool

    @property
    def ready(self) -> bool:
        return self.client_code and self.redirect_ok and self.private_key and self.token_key and self.scopes_ok


def readiness(settings) -> Readiness:
    url = settings.redirect_url
    try:
        sh.check_redirect_url(url)
        ok = True
    except sh.ServiceHubError:
        ok = False
    return Readiness(bool(settings.servicehub_client_code.strip()), url, ok,
                     os.path.isfile(settings.servicehub_private_key_file),
                     bool(settings.token_key.get_secret_value().strip()),
                     settings.servicehub_scopes, not sh.check_read_only_scopes(settings.servicehub_scopes))


SCOPE_FA = {"variant.read": "دیدن تنوع‌ها و قیمت‌ها (فقط خواندن)", "order.read": "دیدن سفارش‌ها (فقط خواندن)",
            "commission": "دیدن کمیسیون‌ها", "insight": "دیدن گزارش فروش"}
