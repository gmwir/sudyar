from __future__ import annotations

import asyncio
import sys

from .config import ConfigError, load_settings
from .logging_setup import setup_logging

USAGE = ("Usage: python -m sudyar [check-config | sync-variants | buybox-status | "
         "winning-price <variant_id> | radar-once | radar-run | import-costs FILE [--dry-run] | "
         "floor-report [--top N] [--fetch-fees N] | set-floor ... | healthcheck]")


def check_config() -> int:
    s = load_settings()
    problems = s.problems() + s.notify_problems()
    if problems:
        print("Configuration problems:")
        for p in problems:
            print(f" - {p}")
        return 1
    print("Configuration OK (token and password are present; values are not shown).")
    if s.price_unit not in ("rial", "toman"):
        print("Note: DIGIKALA_PRICE_UNIT is not set (rial or toman). Profit floors cannot be compared with prices until it is.")
    if not s.fees_field_map or not (s.fees_commission_path or s.fees_calculator_path):
        print("Note: fee endpoints (FEES_*) are not configured, so floors will show 'needs_fees'.")
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
                    print(f"[radar] cycle failed: {type(e).__name__}: {e}", flush=True)
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


def floor_report_cmd(args: list[str]) -> int:
    from .floor import FeeProvider, FloorEngine
    from .floor_report import build_report, format_report
    from .models import Variant, utcnow

    def opt(name: str, default: int) -> int:
        return int(args[args.index(name) + 1]) if name in args else default

    top, fetch = opt("--top", 20), opt("--fetch-fees", 0)
    s = load_settings()
    s.require_ok()
    factory, client = _build(s)
    engine = FloorEngine(s, FeeProvider(client if fetch else None, s))

    async def main():
        now = utcnow()
        with factory() as session:
            if fetch:  # explicit, bounded, rate-limited GETs; off by default
                from sqlalchemy import select
                async with client:
                    n = 0
                    for v in session.scalars(select(Variant).where(Variant.active.is_(True))):
                        if n >= fetch:
                            break
                        if await engine.fees.get(session, v, now, allow_fetch=False) is None:
                            await engine.fees.get(session, v, now, allow_fetch=True)
                            n += 1
                    session.commit()
            return await build_report(session, engine, now, top)

    print(format_report(asyncio.run(main())))
    return 0


def set_floor_cmd(args: list[str]) -> int:
    """set-floor --scope global|brand|category|variant [--key K] [--margin-pct N] [--min-profit N]
    [--manual-toman N] [--manual-pct N]   (writes only our own database)"""
    from .db import make_engine, make_session_factory
    from .floor import set_floor_rule

    def val(name: str, cast=float):
        return cast(args[args.index(name) + 1]) if name in args else None

    try:
        scope = val("--scope", str) or "global"
        key = val("--key", str) or ""
        s = load_settings()
        s.require_ok()
        with make_session_factory(make_engine(s.database_url))() as session:
            row = set_floor_rule(session, scope, key, margin_pct=val("--margin-pct"),
                                 min_profit_toman=val("--min-profit", int),
                                 floor_manual_toman=val("--manual-toman", int),
                                 floor_manual_pct=val("--manual-pct"))
    except (ValueError, IndexError) as e:
        print(f"Invalid options: {e}")
        return 2
    print(f"Saved rule {row.scope}/{row.scope_key or '-'}: margin%={row.margin_pct}, min_profit={row.min_profit_toman}, "
          f"manual_toman={row.floor_manual_toman}, manual%={row.floor_manual_pct}")
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
    free = ("import-costs", "floor-report", "set-floor")  # take options
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
        print(f"Sync failed: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
