from __future__ import annotations

import asyncio
import sys

from .config import ConfigError, load_settings
from .logging_setup import setup_logging

USAGE = "Usage: python -m sudyar [check-config | sync-variants | buybox-status | winning-price <variant_id>]"


def check_config() -> int:
    s = load_settings()
    problems = s.problems()
    if problems:
        print("Configuration problems:")
        for p in problems:
            print(f" - {p}")
        return 1
    print("Configuration OK (token and password are present; values are not shown).")
    return 0


def _build(s):
    from .db import make_call_logger, make_engine, make_session_factory
    from .digikala_client import DigikalaClient
    from .rate_limiter import LimiterConfig, RateLimiter

    factory = make_session_factory(make_engine(s.database_url))
    limiter = RateLimiter(LimiterConfig(
        requests=s.rate_limit_requests, period_seconds=s.rate_limit_period_seconds,
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
    cmds = {"check-config": 1, "sync-variants": 1, "buybox-status": 1, "winning-price": 2}
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
        return winning_price(argv[1])
    except ConfigError as e:
        print(f"Cannot start:\n{e}")
        return 1
    except Exception as e:  # never print headers/tokens; message only
        print(f"Sync failed: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
