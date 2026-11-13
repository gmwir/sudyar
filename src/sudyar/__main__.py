from __future__ import annotations

import asyncio
import sys

from .config import ConfigError, load_settings
from .logging_setup import error_code, setup_logging, short_error

USAGE = ("Usage: python -m sudyar [check-config | sync-variants | buybox-status | "
         "winning-price <variant_id> | radar-once | radar-run | import-costs FILE [--dry-run] | "
         "floor-report [--top N] [--range R] | sync-fees [--force] | sales-sync --range last_30_days [--category-id N] "
         "[--force] | set-floor ... | set-brand --variant ID --brand-id N | list-brands CATEGORY_ID | healthcheck]")


READ_ONLY_SCOPES = (
    ("variants", "GET /open-api/v1/variants"),
    ("pricing/buybox", "GET /open-api/v1/pricing/buybox/price-suggestion/winning-price (and nth-rank-winning-price)"),
    ("commissions", "GET /open-api/v1/commissions/"),
    ("insight", "GET /open-api/v1/insight/sales-reports"),
)


def env_file_warning(path: str = ".env", os_name: str | None = None) -> str | None:
    """One line about .env permissions, or None if all is fine.

    Linux/Mac: warn if other users can read the file. Windows: the check cannot be done, so say that.
    """
    import os
    import stat

    if (os_name or os.name) == "nt":
        return "Note: the .env permission check is skipped on Windows (keep .env in a folder only you can open)."
    if not os.path.isfile(path):
        return None
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        return f"WARNING: .env is readable by other users (mode {mode:03o}). Run: chmod 600 .env"
    return None


def check_config() -> int:
    s = load_settings()
    problems = s.problems() + s.notify_problems()
    warn = env_file_warning()
    if warn:
        print(warn)
    if problems:
        print("Configuration problems:")
        for p in problems:
            print(f" - {p}")
        return 1
    print("Configuration OK (token and password are present; values are not shown).")
    if s.price_unit not in ("rial", "toman"):
        print("Note: DIGIKALA_PRICE_UNIT is not set (rial or toman). Profit floors cannot be compared with prices until it is.")
    print("Token scopes needed (create the Self Token with READ-ONLY access to exactly these; no write scope is needed):")
    for scope, what in READ_ONLY_SCOPES:
        print(f"  - {scope}: {what}")
    print("Notifications: " + ("ENABLED" if s.notify_enabled else "DRY-RUN (messages are only printed, never sent)"))
    return 0


def _build(s, radar: bool = False):
    from .db import make_call_logger, make_engine, make_session_factory
    from .digikala_client import DigikalaClient
    from .rate_limiter import LimiterConfig, RateLimiter

    factory = make_session_factory(make_engine(s.database_url))
    # The radar only gets a share of the read limit (default 60%) so other calls always have room.
    requests = max(1, int(s.rate_limit_requests * s.radar_budget_fraction)) if radar else s.rate_limit_requests
    limiter = RateLimiter(LimiterConfig(
        requests=requests, period_seconds=s.rate_limit_period_seconds,
        max_concurrent=s.max_concurrent, max_retries=s.max_retries,
        backoff_base=s.backoff_base_seconds, backoff_max=s.backoff_max_seconds,
        breaker_threshold=s.breaker_threshold, breaker_pause=s.breaker_pause_seconds,
    ))
    return factory, DigikalaClient(s, limiter, make_call_logger(factory))


def buybox_status() -> int:
    """Counts from the last sync (reads our own database only, no API calls)."""
    from sqlalchemy import func, select

    from .db import make_engine, make_session_factory
    from .models import Variant

    s = load_settings()
    s.require_ok()
    with make_session_factory(make_engine(s.database_url))() as session:
        def count(*conds) -> int:
            return session.scalar(select(func.count()).select_from(Variant).where(Variant.active.is_(True), *conds))
        print(f"Variants total (active): {count()}")
        print(f"We win Buy Box:          {count(Variant.is_seller_buy_box_winner.is_(True))}")
        print(f"We lose Buy Box:         {count(Variant.is_seller_buy_box_winner.is_(False))}")
        print(f"In Buy Box challenge:    {count(Variant.is_in_buy_box_challenge.is_(True))}")
    return 0


def winning_price(variant_id: str) -> int:
    s = load_settings()
    s.require_ok()
    _, client = _build(s)

    async def main():
        async with client:
            return await client.get_winning_price(variant_id)

    price = asyncio.run(main())
    print(f"Suggested winning price (unit as returned, Rial per Swagger): {price}")
    return 0


def _print_cycle(res) -> None:
    print(f"Tiers: " + ", ".join(f"{k}={v}" for k, v in res.tier_counts.items()))
    print(f"Due this cycle: " + ", ".join(f"{k}={v}" for k, v in res.due_counts.items()))
    print(f"Pages read: {len(res.pages_read)}")
    for tier, (lo, hi) in res.estimates.items():
        print(f"  estimated requests/min {tier}: {lo:.1f} - {hi:.1f}")
    print(f"Events: {len(res.events)}")
    for ev in res.events:
        d = ev.details or {}
        extra = f" cause={d['cause']}" if "cause" in d else ""
        print(f"  {ev.type} variant={ev.variant_id} {ev.old_value}->{ev.new_value}{extra}")


def _radar(s):
    from .floor import FeeProvider, FloorEngine
    from .notifier import Dispatcher
    from .radar import Radar

    factory, client = _build(s, radar=True)
    engine = FloorEngine(s, FeeProvider(client, s))
    return client, Radar(client, factory, s, Dispatcher(s), engine)


def radar_once() -> int:
    s = load_settings()
    s.require_ok()
    client, radar = _radar(s)

    async def main():
        async with client:
            return await radar.run_cycle()

    _print_cycle(asyncio.run(main()))
    return 0


def radar_run() -> int:
    import time as _time

    s = load_settings()
    s.require_ok()
    client, radar = _radar(s)

    async def main():
        async with client:
            while True:
                started = _time.monotonic()
                try:
                    res = await radar.run_cycle()
                    print(f"[radar] pages={len(res.pages_read)} events={len(res.events)} tiers={res.tier_counts}", flush=True)
                except Exception as e:  # keep the loop alive; message only, never headers/tokens
                    print(f"[radar] cycle failed: {short_error(e)}", flush=True)
                await asyncio.sleep(max(1.0, s.radar_hot_interval_seconds - (_time.monotonic() - started)))

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Radar stopped.")
    return 0


def healthcheck() -> int:
    """Used by Docker HEALTHCHECK: database reachable? (No Digikala call, no secrets printed.)"""
    from sqlalchemy import text

    from .db import make_engine

    try:
        s = load_settings()
        with make_engine(s.database_url).connect() as c:
            c.execute(text("SELECT 1"))
    except Exception as e:
        print(f"unhealthy: {type(e).__name__}")
        return 1
    print("healthy")
    return 0


def import_costs_cmd(args: list[str]) -> int:
    from .cost_import import CostImportError, import_costs
    from .db import make_engine, make_session_factory

    dry = "--dry-run" in args
    files = [a for a in args if a != "--dry-run"]
    if len(files) != 1:
        print("Usage: python -m sudyar import-costs FILE.xlsx|FILE.csv [--dry-run]")
        return 2
    s = load_settings()
    s.require_ok()
    try:
        with make_session_factory(make_engine(s.database_url))() as session:
            res = import_costs(session, files[0], s, dry_run=dry)
    except CostImportError as e:
        print(f"Import failed: {e}")
        return 1
    print(("DRY-RUN (nothing saved). " if dry else "") +
          f"New: {res.created}, updated: {res.updated}, unchanged: {res.unchanged}, rejected: {len(res.rejected)}")
    for rownum, why in res.rejected[:50]:
        print(f"  rejected row {rownum}: {why}")
    if len(res.rejected) > 50:
        print(f"  ... and {len(res.rejected) - 50} more rejected rows")
    return 0


def _api_hint(e: Exception) -> str:
    from .fees import FeeSyncRefused

    if isinstance(e, FeeSyncRefused):  # our own message: no external data in it
        return f"{e}"
    msg = short_error(e)
    if error_code(e) in ("HTTP-401", "HTTP-403"):
        msg += "  (check the Self Token scopes: sync-fees needs 'commissions', sales-sync needs 'insight')"
    return msg


def _opt(args: list[str], name: str, cast=str, default=None):
    return cast(args[args.index(name) + 1]) if name in args else default


def sync_fees_cmd(args: list[str]) -> int:
    from .fees import sync_commissions
    from .models import utcnow

    s = load_settings()
    s.require_ok()
    factory, client = _build(s)

    async def main():
        async with client:
            with factory() as session:
                return await sync_commissions(client, session, s, utcnow(), force="--force" in args)

    try:
        r = asyncio.run(main())
    except Exception as e:
        print(f"sync-fees failed: {_api_hint(e)}")
        return 1
    print(f"Commissions saved: {r.rows} rows ({r.pages} pages), rejected: {len(r.rejected or [])}")
    if r.partial_categories:
        print(f"WARNING: {r.partial_categories} categories had invalid rows; no floor is computed for them until fixed.")
    for line in (r.rejected or [])[:20]:
        print(f"  rejected {line}")
    return 0


def sales_sync_cmd(args: list[str]) -> int:
    from .models import utcnow
    from .sales import sync_sales

    range_ = _opt(args, "--range", str, "last_30_days")
    s = load_settings()
    s.require_ok()
    factory, client = _build(s)

    async def main():
        async with client:
            with factory() as session:
                return await sync_sales(client, session, s, range_, utcnow(),
                                        _opt(args, "--category-id"), "--force" in args)

    try:
        r = asyncio.run(main())
    except ValueError as e:
        print(f"Invalid options: {e}")
        return 2
    except Exception as e:
        print(f"sales-sync failed: {_api_hint(e)}")
        return 1
    if r.cached:
        print(f"Sales for {range_} were read less than 24 h ago: using the saved data (use --force to re-read).")
        return 0
    print(f"Sales saved for {range_}: {r.rows} products ({r.pages} pages)" + ("; STOPPED at SALES_MAX_PAGES" if r.truncated else ""))
    return 0


def floor_report_cmd(args: list[str]) -> int:
    from .floor import FloorEngine
    from .fees import FeeProvider
    from .floor_report import build_report, format_report
    from .models import utcnow

    top = _opt(args, "--top", int, 20)
    if not 1 <= top <= 1000:
        print("Invalid options: --top must be between 1 and 1000")
        return 2
    s = load_settings()
    s.require_ok()
    factory, _ = _build(s)
    engine = FloorEngine(s, FeeProvider(None, s))  # no client: the report never calls Digikala

    async def main():
        with factory() as session:
            return await build_report(session, engine, utcnow(), top,
                                      _opt(args, "--range", str, "last_30_days"))

    print(format_report(asyncio.run(main())))
    return 0


def set_floor_cmd(args: list[str]) -> int:
    """set-floor --scope global|brand|category|variant [--key K] [--margin-pct N] [--min-profit N]
    [--manual-toman N] [--manual-pct N] and cost components, each --<name>-pct N / --<name>-toman N for
    fulfillment, tax, ad-share, return-reserve, packaging.  (writes only our own database)"""
    from .db import make_engine, make_session_factory
    from .floor import COMPONENTS, set_floor_rule

    try:
        scope = _opt(args, "--scope", str, "global")
        key = _opt(args, "--key", str, "")
        vals: dict = {
            "margin_pct": _opt(args, "--margin-pct", float), "min_profit_toman": _opt(args, "--min-profit", int),
            "floor_manual_toman": _opt(args, "--manual-toman", int), "floor_manual_pct": _opt(args, "--manual-pct", float),
        }
        for c in COMPONENTS:
            flag = c.replace("_", "-")
            vals[f"{c}_pct"] = _opt(args, f"--{flag}-pct", float)
            vals[f"{c}_toman"] = _opt(args, f"--{flag}-toman", int)
        s = load_settings()
        s.require_ok()
        with make_session_factory(make_engine(s.database_url))() as session:
            row = set_floor_rule(session, scope, key, **vals)
    except (ValueError, IndexError) as e:
        print(f"Invalid options: {e}")
        return 2
    shown = {k: getattr(row, k) for k in vals if getattr(row, k) is not None}
    print(f"Saved rule {row.scope}/{row.scope_key or '-'}: {shown}")
    return 0


def set_brand_cmd(args: list[str]) -> int:
    from .db import make_engine, make_session_factory
    from .floor import set_variant_brand

    try:
        vid, brand = _opt(args, "--variant"), _opt(args, "--brand-id")
        if not vid or not brand:
            raise ValueError("need --variant ID and --brand-id N")
        s = load_settings()
        s.require_ok()
        with make_session_factory(make_engine(s.database_url))() as session:
            set_variant_brand(session, vid, brand)
    except (ValueError, IndexError) as e:
        print(f"Invalid options: {e}")
        return 2
    print(f"Variant {vid} linked to brand_id {brand}.")
    return 0


def list_brands_cmd(args: list[str]) -> int:
    from .db import make_engine, make_session_factory
    from .fees import list_brands

    if len(args) != 1:
        print("Usage: python -m sudyar list-brands CATEGORY_ID")
        return 2
    s = load_settings()
    s.require_ok()
    with make_session_factory(make_engine(s.database_url))() as session:
        rows = list_brands(session, args[0])
    if not rows:
        print("No commission rows for this category (run sync-fees, or check the category_id).")
    for brand_id, title, pct in rows:
        print(f"  brand_id={brand_id or '-'}  {title or ''}  commission={pct}%")
    return 0


def run_sync() -> int:
    from .sync import sync_variants

    s = load_settings()
    s.require_ok()
    factory, client = _build(s)

    async def main() -> int:
        async with client:
            with factory() as session:
                return await sync_variants(client, session, s)

    count = asyncio.run(main())
    print(f"Sync finished. Variants read: {count}")
    return 0


def main(argv: list[str]) -> int:
    setup_logging()
    cmds = {"check-config": 1, "sync-variants": 1, "buybox-status": 1, "winning-price": 2, "radar-once": 1,
            "radar-run": 1, "healthcheck": 1}
    free = ("sync-fees", "import-costs", "floor-report", "set-floor", "sales-sync", "set-brand", "list-brands")  # take options
    if not argv or (argv[0] not in free and cmds.get(argv[0]) != len(argv)):
        print(USAGE)
        return 2
    try:
        if argv[0] == "import-costs":
            return import_costs_cmd(argv[1:])
        if argv[0] == "floor-report":
            return floor_report_cmd(argv[1:])
        if argv[0] == "set-floor":
            return set_floor_cmd(argv[1:])
        if argv[0] == "sales-sync":
            return sales_sync_cmd(argv[1:])
        if argv[0] == "set-brand":
            return set_brand_cmd(argv[1:])
        if argv[0] == "list-brands":
            return list_brands_cmd(argv[1:])
        if argv[0] == "sync-fees":
            return sync_fees_cmd(argv[1:])
        if argv[0] == "healthcheck":
            return healthcheck()
        if argv[0] == "check-config":
            return check_config()
        if argv[0] == "sync-variants":
            return run_sync()
        if argv[0] == "buybox-status":
            return buybox_status()
        if argv[0] == "radar-once":
            return radar_once()
        if argv[0] == "radar-run":
            return radar_run()
        return winning_price(argv[1])
    except ConfigError as e:
        print(f"Cannot start:\n{e}")
        return 1
    except Exception as e:  # never print headers/tokens; message only
        print(f"Command failed: {short_error(e)}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
