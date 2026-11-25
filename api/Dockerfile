# 2026.11.24, Python 3.15 (latest), pinned by digest
FROM python:3.15-slim@sha256:63bb298d2b7b88f176f51b5189f54ce6535c997682ea70885d2132f5d473a8a5 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /api

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .


# The media tools for probe / derive (contract milestone-3 §2), from Debian: ffmpeg (with
# ffprobe) and poppler-utils (pdftoppm, pdfinfo). Only the images that run jobs get them (the
# worker and the tests), so the API image stays small and has no ffmpeg to attack.
FROM base AS media
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg poppler-utils \
    && rm -rf /var/lib/apt/lists/*


# Test image: `docker compose -f docker-compose.test.yml up --build ...` (see that file). It has
# the media tools, so probe and derive run for real in the tests.
FROM media AS test
RUN pip install --no-cache-dir -r requirements-dev.txt
CMD ["python", "-m", "pytest"]


# Background jobs: `python -m worker` with WORKER_QUEUES=default,media (docker-compose.yml).
# Runs as non-root; untrusted media is parsed only in sandboxed children (media/sandbox.py).
FROM media AS worker
RUN useradd --system --create-home --uid 10001 app
USER app
CMD ["python", "-m", "worker"]


# Default image. The same image runs two ways (the worker has its own target above):
#   API:        (default CMD) Sanic's own server, one process per worker
#   migrations: python -m migrate      (one-off release step, before new API servers start)
FROM base AS runtime
RUN useradd --system --create-home --uid 10001 app
USER app
EXPOSE 8080
CMD ["sanic", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "4"]
