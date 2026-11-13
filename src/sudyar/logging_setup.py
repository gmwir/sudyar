import logging
import os
import re

SECRET_ENV_NAMES = ("DIGIKALA_SELF_TOKEN", "POSTGRES_PASSWORD", "TELEGRAM_BOT_TOKEN",
                    "TELEGRAM_CHAT_ID", "BALE_BOT_TOKEN", "BALE_CHAT_ID")
log = logging.getLogger(__name__)


def redact(text: str) -> str:
    """Remove secret values (from the environment) and URL credentials from any text."""
    for name in SECRET_ENV_NAMES:
        secret = os.environ.get(name, "")
        if len(secret) >= 4:
            text = text.replace(secret, "***")
    return re.sub(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s@]+@", r"\1***@", text)


def error_code(e: BaseException) -> str:
    """Short, safe code for an exception (what to tell the user instead of the raw message)."""
    from sqlalchemy.exc import SQLAlchemyError

    import httpx

    from .config import ConfigError
    from .rate_limiter import ApiError

    if isinstance(e, ApiError):
        m = re.search(r"status (\d{3})", str(e))
        return f"HTTP-{m.group(1)}" if m else "API"
    if isinstance(e, SQLAlchemyError):
        return "DB"
    if isinstance(e, httpx.HTTPError):
        return "NET"
    if isinstance(e, ConfigError):
        return "CONFIG"
    if isinstance(e, (ValueError, TypeError, KeyError, IndexError)):
        return "VALUE"
    return "ERR"


def short_error(e: BaseException) -> str:
    """'ExceptionType (code XYZ)'. The full message is only logged at DEBUG level (SUDYAR_DEBUG=1), redacted."""
    log.debug("error details: %s", redact(f"{type(e).__name__}: {e}"))
    return f"{type(e).__name__} (code {error_code(e)}; set SUDYAR_DEBUG=1 for details)"


class RedactSecrets(logging.Filter):
    """Safety net: remove secret values from any log line."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg, record.args = redact(record.getMessage()), ()
        return True


def setup_logging() -> None:
    debug = os.environ.get("SUDYAR_DEBUG", "").strip().lower() in ("1", "true", "yes")
    logging.basicConfig(level=logging.DEBUG if debug else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    f = RedactSecrets()
    for h in logging.getLogger().handlers:
        h.addFilter(f)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx logs full URLs
