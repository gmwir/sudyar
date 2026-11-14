"""FastAPI app: 4 screens (Today, Radar, Floor, Settings), server-rendered Persian pages, HTMX partials.

READ-ONLY: no route writes to Digikala or calls it. The only thing a POST changes is OUR settings table.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from fastapi import Depends, FastAPI, Form, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from ..config import Settings
from ..models import Variant, utcnow
from ..ui_settings import UiSettingsError, save_ui_settings
from . import data, fmt
from .auth import LoginThrottle, PasswordGate, WebConfigError, check_bind, csrf_valid, new_csrf_token

log = logging.getLogger(__name__)
HERE = Path(__file__).resolve().parent
ASSET_VERSION = "1"
TABS = (("today", "امروز", "/"), ("radar", "رادار", "/radar"), ("floor", "کف قیمت", "/floor"), ("settings", "تنظیمات", "/settings"))
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")


class LoginRequired(Exception):
    pass


class RowCache:
    """Tiny TTL cache for the floor rows (the slow part), so switching tabs is instant. ttl<=0 disables it."""

    def __init__(self, ttl: float, clock: Callable[[], float] = time.monotonic):
        self.ttl, self._clock, self._lock = ttl, clock, threading.Lock()
        self._at = -1e18
        self._rows = None

    def get(self, build: Callable[[], list]):
        if self.ttl <= 0:
            return build()
        with self._lock:
            if self._rows is None or self._clock() - self._at > self.ttl:
                self._rows, self._at = build(), self._clock()
            return self._rows


def create_app(settings: Settings | None = None, session_factory: sessionmaker[Session] | None = None, *,
               web_password: str | None = None, bind_host: str = "127.0.0.1", allow_container_bind: bool = False,
               now_fn: Callable[[], datetime] = utcnow, cache_seconds: float = 30.0,
               secret_key: str | None = None, https_only_cookie: bool = False) -> FastAPI:
    check_bind(bind_host, web_password, allow_container_bind)  # raises WebConfigError: refuse to start
    if settings is None:
        from ..config import load_settings
        settings = load_settings()
    if session_factory is None:
        from ..db import make_engine, make_session_factory
        session_factory = make_session_factory(make_engine(settings.database_url))

    import secrets as _secrets
    gate = PasswordGate(web_password)
    throttle = LoginThrottle()
    cache = RowCache(cache_seconds)
    app = FastAPI(title="Sudyar", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings, app.state.session_factory, app.state.gate = settings, session_factory, gate
    app.state.cache, app.state.now_fn = cache, now_fn
    app.add_middleware(SessionMiddleware, secret_key=secret_key or _secrets.token_urlsafe(48),
                       session_cookie="sudyar_session", max_age=30 * 24 * 3600, same_site="strict",
                       https_only=https_only_cookie)
    app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")

    templates = Jinja2Templates(directory=HERE / "templates")
    env = templates.env
    env.filters.update(fa=fmt.fa, toman=lambda v: fmt.toman_text(v), ago=lambda dt: fmt.time_ago(dt, now_fn()))
    env.globals.update(unknown=fmt.UNKNOWN, tiers=data.TIERS, tier_fa=data.TIER_FA, status_fa=data.STATUS_FA,
                       max_rows=data.MAX_ROWS, hour_label=lambda h: fmt.fa(f"{int(h):02d}:00"))

    # ------------------------------------------------------------------ helpers
    def get_session():
        with session_factory() as session:
            yield session

    def csrf_token(request: Request) -> str:
        tok = request.session.get("csrf")
        if not tok:
            tok = request.session["csrf"] = new_csrf_token()
        return tok

    def render(request: Request, name: str, nav: str | None = None, status_code: int = 200, **ctx) -> HTMLResponse:
        base = dict(csrf_token=csrf_token(request), nav=nav, tabs=TABS, asset_v=ASSET_VERSION,
                    auth_enabled=gate.enabled, title=ctx.pop("title", "سودیار"))
        return templates.TemplateResponse(request, name, {**base, **ctx}, status_code=status_code)

    def require_auth(request: Request) -> None:
        if gate.enabled and not request.session.get("auth"):
            raise LoginRequired()

    def verify_csrf(request: Request, form_token: str | None, header_token: str | None) -> None:
        if not csrf_valid(request.session.get("csrf"), form_token or header_token):
            raise HTTPException(status_code=403, detail="csrf")

    def is_htmx(request: Request) -> bool:
        return request.headers.get("hx-request") == "true" and request.headers.get("hx-boosted") != "true"

    def rows_for(session: Session):
        engine = data.make_engine(settings)
        return cache.get(lambda: data.floor_rows(session, engine, now_fn()))

    # ------------------------------------------------------------------ middleware / errors
    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("Content-Security-Policy", CSP)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        if not request.url.path.startswith("/static/"):
            resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    @app.exception_handler(LoginRequired)
    async def _login_required(request: Request, exc: LoginRequired):
        if request.headers.get("hx-request") == "true":
            return Response(status_code=401, headers={"HX-Redirect": "/login"})
        return RedirectResponse("/login", status_code=303)

    @app.exception_handler(SQLAlchemyError)
    async def _db_error(request: Request, exc: SQLAlchemyError):
        log.warning("database error: %s", type(exc).__name__)  # type only: never the SQL or its parameters
        return render(request, "error.html", status_code=503, heading="پایگاه داده آماده نیست",
                      message="به پایگاه داده وصل نشدم. برنامه را دوباره روشن کنید (دکمه‌ی ۱) و چند لحظه صبر کنید.")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 403:
            return render(request, "error.html", status_code=403, heading="درخواست نامعتبر",
                          message="صفحه را دوباره باز کنید و دوباره امتحان کنید.")
        if exc.status_code == 404:
            return render(request, "error.html", status_code=404, heading="پیدا نشد", message="چنین صفحه‌ای وجود ندارد.")
        if exc.status_code == 429:
            return render(request, "error.html", status_code=429, heading="تلاش بیش از حد",
                          message="چند دقیقه صبر کنید و دوباره امتحان کنید.")
        return render(request, "error.html", status_code=exc.status_code, heading="خطا", message="درخواست انجام نشد.")

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception):
        log.error("unexpected error: %s", type(exc).__name__)
        return render(request, "error.html", status_code=500, heading="خطای غیرمنتظره",
                      message="مشکلی پیش آمد. دوباره امتحان کنید؛ اگر ادامه داشت دکمه‌ی ۷ و بعد ۱ را بزنید.")

    # ------------------------------------------------------------------ public routes
    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return PlainTextResponse("ok")

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest():
        return FileResponse(HERE / "static" / "manifest.webmanifest", media_type="application/manifest+json")

    @app.get("/sw.js", include_in_schema=False)
    def service_worker():
        return FileResponse(HERE / "static" / "sw.js", media_type="text/javascript",
                            headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"})

    @app.get("/login", include_in_schema=False)
    def login_page(request: Request):
        if not gate.enabled or request.session.get("auth"):
            return RedirectResponse("/", status_code=303)
        return render(request, "login.html", title="ورود", error=None)

    @app.post("/login", include_in_schema=False)
    def login(request: Request, password: str = Form(""), csrf_token_f: str = Form("", alias="csrf_token"),
              x_csrf_token: str | None = Header(None)):
        verify_csrf(request, csrf_token_f, x_csrf_token)
        if not gate.enabled:
            return RedirectResponse("/", status_code=303)
        client = request.client.host if request.client else "?"
        if throttle.blocked(client):
            raise HTTPException(status_code=429)
        if not gate.check(password):
            throttle.fail(client)
            return render(request, "login.html", title="ورود", status_code=401, error="رمز درست نیست.")
        throttle.reset(client)
        csrf = new_csrf_token()
        request.session.clear()  # new session after login (no fixation)
        request.session.update(auth=True, csrf=csrf)
        return RedirectResponse("/", status_code=303)

    @app.post("/logout", include_in_schema=False)
    def logout(request: Request, csrf_token_f: str = Form("", alias="csrf_token"), x_csrf_token: str | None = Header(None)):
        verify_csrf(request, csrf_token_f, x_csrf_token)
        request.session.clear()
        return RedirectResponse("/login" if gate.enabled else "/", status_code=303)

    # ------------------------------------------------------------------ the 4 screens
    @app.get("/", dependencies=[Depends(require_auth)], include_in_schema=False)
    def today(request: Request, session: Session = Depends(get_session)):
        now = now_fn()
        view = data.build_today(session, settings, rows_for(session), now)
        return render(request, "today.html", "today", title="امروز", view=view, jdate=fmt.jalali_date(now))

    @app.get("/partials/profit", dependencies=[Depends(require_auth)], include_in_schema=False)
    def profit_partial(request: Request, session: Session = Depends(get_session)):
        p = data.build_profit(session, data.make_engine(settings), now_fn())
        return render(request, "_profit.html", p=p)

    @app.get("/radar", dependencies=[Depends(require_auth)], include_in_schema=False)
    def radar(request: Request, tier: str | None = None, session: Session = Depends(get_session)):
        tier = tier.upper() if tier else None
        if tier is not None and tier not in data.TIERS:
            raise HTTPException(status_code=404)
        view = data.build_radar(session, settings, rows_for(session), now_fn(), tier)
        filters = [("", "همه", "")] + [(t, data.TIER_FA[t], t.lower()) for t in reversed(data.TIERS)]
        ctx = dict(view=view, filters=filters)
        if is_htmx(request):
            return render(request, "_radar_main.html", **ctx)
        return render(request, "radar.html", "radar", title="رادار", **ctx)

    def floor_ctx(session: Session, status: str | None):
        rows = rows_for(session)
        view = data.build_floor(session, settings, rows, now_fn(), status)
        reasons = {r.variant.id: (data.reason_fa(r.result) if r.result else "محاسبه‌ی این کالا خطا داد.") for r in view.rows}
        filters = [("", "همه", "")] + [(k, data.STATUS_FA[k], "warning" if k != "ok" else "success")
                                      for k in ("needs_cost", "needs_fees", "no_rule", "ok")]
        return dict(view=view, filters=filters, reasons=reasons)

    @app.get("/floor", dependencies=[Depends(require_auth)], include_in_schema=False)
    def floor(request: Request, status: str | None = None, session: Session = Depends(get_session)):
        if status is not None and status not in data.STATUS_FA:
            raise HTTPException(status_code=404)
        ctx = floor_ctx(session, status)
        if is_htmx(request):
            return render(request, "_floor_main.html", **ctx)
        return render(request, "floor.html", "floor", title="کف قیمت", **ctx)

    @app.get("/floor/{variant_id}", dependencies=[Depends(require_auth)], include_in_schema=False)
    def floor_detail(request: Request, variant_id: str, session: Session = Depends(get_session)):
        v = session.scalar(select(Variant).where(Variant.digikala_variant_id == variant_id))
        if v is None:
            raise HTTPException(status_code=404)
        d = data.build_floor_detail(session, data.make_engine(settings), v, now_fn())
        return render(request, "_floor_detail.html", d=d)

    def settings_ctx(session: Session, **extra):
        return dict(c=data.build_connection(session, settings, now_fn()), a=data.build_alerts(session, settings), **extra)

    @app.get("/settings", dependencies=[Depends(require_auth)], include_in_schema=False)
    def settings_page(request: Request, session: Session = Depends(get_session)):
        return render(request, "settings.html", "settings", title="تنظیمات", **settings_ctx(session))

    @app.post("/settings/alerts", dependencies=[Depends(require_auth)], include_in_schema=False)
    def save_alerts(request: Request, session: Session = Depends(get_session),
                    csrf_token_f: str = Form("", alias="csrf_token"), x_csrf_token: str | None = Header(None),
                    report_hour: str = Form("8"), quiet_mode: str = Form("quiet"),
                    quiet_start: str = Form("23"), quiet_end: str = Form("7"), notify: str | None = Form(None)):
        verify_csrf(request, csrf_token_f, x_csrf_token)
        current = data.build_alerts(session, settings)
        # Without channel credentials the switch is disabled: keep whatever was saved, never flip it by accident.
        notify_value = (notify == "1") if current.can_send else bool(current.ui.notify_enabled)
        ok, message = True, "ذخیره شد."
        try:
            save_ui_settings(session, report_hour=report_hour, quiet_enabled=(quiet_mode != "always"),
                             quiet_start=quiet_start, quiet_end=quiet_end, notify_enabled=notify_value, now=now_fn())
        except UiSettingsError as e:
            session.rollback()
            ok, message = False, str(e)
        if not is_htmx(request):
            return RedirectResponse("/settings", status_code=303)
        ctx = settings_ctx(session, ok=ok, message=message)
        return render(request, "_alerts_card.html", status_code=200 if ok else 422, **ctx)

    return app
