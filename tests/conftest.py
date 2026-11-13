import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from sudyar.config import Settings
from sudyar.models import Base
from sudyar.rate_limiter import LimiterConfig, RateLimiter

TOKEN = "SECRET-TOKEN-abc123"


class FakeTime:
    """Fake clock: sleep() just advances time, so tests are instant."""

    def __init__(self):
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self):
        return self.now

    async def sleep(self, s):
        self.sleeps.append(s)
        self.now += s


@pytest.fixture
def ft():
    return FakeTime()


@pytest.fixture
def make_limiter(ft):
    def _make(**kw):
        return RateLimiter(LimiterConfig(**kw), clock=ft.clock, sleep=ft.sleep, jitter=lambda: 0.0)
    return _make


@pytest.fixture
def settings():
    return Settings(
        digikala_self_token=TOKEN, postgres_password="pw", variants_path="/open-api/v1/variants",
        page_size=2, base_url="https://seller.digikala.com",
    )


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(engine)() as s:
        yield s
