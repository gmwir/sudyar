import logging
import os


class RedactSecrets(logging.Filter):
    """Safety net: remove secret values from any log line."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for name in ("DIGIKALA_SELF_TOKEN", "POSTGRES_PASSWORD"):
            secret = os.environ.get(name, "")
            if len(secret) >= 4 and secret in msg:
                msg = msg.replace(secret, "***")
        record.msg, record.args = msg, ()
        return True


def setup_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    f = RedactSecrets()
    for h in logging.getLogger().handlers:
        h.addFilter(f)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx logs full URLs
