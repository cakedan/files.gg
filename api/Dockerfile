# 2026.11.24, Python 3.15 (latest), pinned by digest
FROM python:3.15-slim@sha256:63bb298d2b7b88f176f51b5189f54ce6535c997682ea70885d2132f5d473a8a5 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /api

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .


# Test image: `docker compose -f docker-compose.test.yml up --build ...` (see that file).
FROM base AS test
RUN pip install --no-cache-dir -r requirements-dev.txt
CMD ["python", "-m", "pytest"]


# Default image. The same image runs three ways:
#   API:        (default CMD) Sanic's own server, one process per worker
#   migrations: python -m migrate      (one-off release step, before new API servers start)
#   worker:     python -m worker
FROM base AS runtime
RUN useradd --system --create-home --uid 10001 app
USER app
EXPOSE 8080
CMD ["sanic", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "4"]
