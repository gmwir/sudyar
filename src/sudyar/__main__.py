from __future__ import annotations

import asyncio
import sys

from .config import ConfigError, load_settings
from .logging_setup import setup_logging

USAGE = "Usage: python -m sudyar [check-config | sync-variants]"


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


def run_sync() -> int:
    from .db import make_call_logger, make_engine, make_session_factory
    from .digikala_client import DigikalaClient
    from .rate_limiter import LimiterConfig, RateLimiter
    from .sync import sync_variants

    s = load_settings()
    s.require_ok()
    factory = make_session_factory(make_engine(s.database_url))
    limiter = RateLimiter(LimiterConfig(
        requests=s.rate_limit_requests, period_seconds=s.rate_limit_period_seconds,
        max_concurrent=s.max_concurrent, max_retries=s.max_retries,
        backoff_base=s.backoff_base_seconds, backoff_max=s.backoff_max_seconds,
        breaker_threshold=s.breaker_threshold, breaker_pause=s.breaker_pause_seconds,
    ))

    async def main() -> int:
        async with DigikalaClient(s, limiter, make_call_logger(factory)) as client:
            with factory() as session:
                return await sync_variants(client, session, s)

    count = asyncio.run(main())
    print(f"Sync finished. Variants read: {count}")
    return 0


def main(argv: list[str]) -> int:
    setup_logging()
    if len(argv) != 1 or argv[0] not in ("check-config", "sync-variants"):
        print(USAGE)
        return 2
    try:
        return check_config() if argv[0] == "check-config" else run_sync()
    except ConfigError as e:
        print(f"Cannot start:\n{e}")
        return 1
    except Exception as e:  # never print headers/tokens; message only
        print(f"Sync failed: {type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
