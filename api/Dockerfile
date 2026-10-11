# syntax=docker/dockerfile:1.7
# Gouvra API / worker image (same code, different commands).
FROM python:3.13-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

FROM base AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.22 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev
COPY pyproject.toml uv.lock README.md alembic.ini ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-editable

FROM base AS runtime
RUN groupadd --system --gid 10001 gouvra \
 && useradd --system --uid 10001 --gid gouvra --home-dir /app --shell /usr/sbin/nologin gouvra
WORKDIR /app
COPY --from=build --chown=gouvra:gouvra /app/.venv /app/.venv
COPY --chown=gouvra:gouvra alembic.ini ./
ENV PATH="/app/.venv/bin:$PATH" \
    WORKER_HEARTBEAT_FILE=/tmp/gouvra-worker.alive
USER gouvra
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"
CMD ["uvicorn", "gouvra.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", \
     "--no-proxy-headers", "--no-server-header", "--timeout-graceful-shutdown", "20"]
