FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml alembic.ini ./
COPY src ./src
COPY migrations ./migrations
RUN pip install --no-cache-dir .
CMD ["sh", "-c", "alembic upgrade head && python -m sudyar check-config; tail -f /dev/null"]
