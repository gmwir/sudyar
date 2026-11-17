from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .models import ApiCallLog


def make_engine(url: str) -> Engine:
    return create_engine(url, pool_pre_ping=True)


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


def make_call_logger(factory: sessionmaker[Session]):
    """Returns a function that stores one api_call_log row per API attempt."""

    def log_call(endpoint: str, status: int | None, seconds: float) -> None:
        with factory() as s:
            s.add(ApiCallLog(endpoint=endpoint, status=status, duration_ms=int(seconds * 1000)))
            s.commit()

    return log_call
