# syntax=docker/dockerfile:1
# Pinned by digest (looked up 2026-11-13). To update: docker buildx imagetools inspect python:3.12-slim
ARG PYTHON_IMAGE=python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

# ---- build stage: dependencies only; nothing from here except /opt/venv reaches the final image
FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
WORKDIR /src
COPY pyproject.toml ./
COPY src ./src
# Optional: behind a company proxy that re-signs HTTPS, pass its CA (TLS checking stays ON):
#   docker build --secret id=pipca,src=ca.pem .
RUN --mount=type=secret,id=pipca,required=false \
    if [ -f /run/secrets/pipca ]; then export PIP_CERT=/run/secrets/pipca; fi; \
    /opt/venv/bin/pip install --no-cache-dir .

# ---- runtime stage
FROM ${PYTHON_IMAGE}
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp
# non-root user (uid/gid 10001), no home, no shell
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app \
 && mkdir /data && chown 10001:10001 /data
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY alembic.ini ./
COPY migrations ./migrations
# The only writable place is /data (a mounted volume); everything else can be a read-only filesystem.
VOLUME ["/data"]
USER 10001:10001
# Secrets are NEVER baked in: they arrive at run time from .env via docker compose (env_file).
HEALTHCHECK --interval=60s --timeout=15s --start-period=60s --retries=3 \
  CMD ["python", "-m", "sudyar", "healthcheck"]
CMD ["sh", "-c", "alembic upgrade head && python -m sudyar check-config; tail -f /dev/null"]
