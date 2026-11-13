from __future__ import annotations

import asyncio
import sys

from .config import ConfigError, load_settings
from .logging_setup import setup_logging

USAGE = ("Usage: python -m sudyar [check-config | sync-variants | buybox-status | "
         "winning-price <variant_id> | radar-once | radar-run]")


def check_config() -> int:
    s = load_settings()
    problems = s.problems() + s.notify_problems()
    if problems:
        print("Configuration problems:")
        for p in problems:
            print(f" - {p}")
        return 1
    print("Configuration OK (token and password are present; values are not shown).")
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
    from .notifier import Dispatcher
    from .radar import Radar

    factory, client = _build(s, radar=True)
    return client, Radar(client, factory, s, Dispatcher(s))


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
    cmds = {"check-config": 1, "sync-variants": 1, "buybox-status": 1, "winning-price": 2, "radar-once": 1, "radar-run": 1}
    if not argv or cmds.get(argv[0]) != len(argv):
        print(USAGE)
        return 2
    try:
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
