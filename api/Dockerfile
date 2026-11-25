# 2026.11.24, Python 3.15 (latest), pinned by digest
FROM python:3.15-slim@sha256:63bb298d2b7b88f176f51b5189f54ce6535c997682ea70885d2132f5d473a8a5 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /api

# libmagic1: the API sniffs every upload's first 64 KiB with python-magic (contract milestone-4 §5.1)
RUN apt-get update \
    && apt-get install -y --no-install-recommends libmagic1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt


# Default image. The same image runs two ways (the worker has its own target below):
#   API:        (default CMD) Sanic's own server, one process per worker
#   migrations: python -m migrate      (one-off release step, before new API servers start)
# The NSFW model and the test fixtures are only for the worker and the tests.
FROM base AS runtime
COPY --exclude=media/models --exclude=tests --exclude=tools/export-requirements.txt . .
RUN useradd --system --create-home --uid 10001 app
USER app
EXPOSE 8080
CMD ["sanic", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--workers", "4"]


# --- the worker (Python 3.14) ---------------------------------------------------------------------------
# 2026.11.24, Python 3.14.10, pinned by digest. The worker runs on 3.14, not 3.15, only because onnxruntime
# has no cp315 wheels yet (contract milestone-4 §4.1); every worker dependency has cp314 wheels or builds on it.
FROM python:3.14-slim@sha256:22eafb370920ad8b429e0aec3fff433e0669968519f5d60469d83729c138b28b AS worker-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /api

# The media and scanning tools, from Debian: ffmpeg (with ffprobe) and poppler-utils (pdftoppm, pdfinfo) for
# probe / derive / scan (milestone-3 §2), libmagic1 for sniffing, libarchive-tools (bsdtar and libarchive13, for
# libarchive-c) for archive listings and qpdf for PDF object streams (milestone-4 §5.3, §5.5). Only the images
# that run jobs get them (the worker and the tests), so the API image stays small and has none of them to attack.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg poppler-utils libmagic1 libarchive-tools qpdf \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-worker.txt ./
RUN pip install --no-cache-dir -r requirements-worker.txt


# pdqhash (Meta's PDQ, contract milestone-4 §3.4) has no Linux wheels, so it's built here from its sdist with
# g++; only the wheel leaves this stage.
FROM worker-base AS pdqhash-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*
COPY requirements-pdqhash-build.txt ./
RUN pip install --no-cache-dir $(grep -E '^(cython|numpy|setuptools|wheel)==' requirements-pdqhash-build.txt) \
    && pip wheel --no-cache-dir --no-deps --no-build-isolation --no-binary pdqhash -w /wheels \
       $(grep -E '^pdqhash==' requirements-pdqhash-build.txt)


FROM worker-base AS worker-deps
COPY --from=pdqhash-build /wheels /wheels
RUN pip install --no-cache-dir --no-deps /wheels/pdqhash-*.whl && rm -rf /wheels


# Test image: `docker compose -f docker-compose.test.yml up --build ...` (see that file). It's the worker's
# environment (Python 3.14, the media and scanning tools, the NSFW model), so probe, derive and scan run for real
# in the tests, plus the dev requirements.
FROM worker-deps AS test
COPY requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY --exclude=tools/export-requirements.txt . .
CMD ["python", "-m", "pytest"]


# Background jobs: `python -m worker` with WORKER_QUEUES=default,media, the `scanner` (scan) and the
# `rescanner` (rescan) (docker-compose.yml). Runs as non-root; untrusted bytes are parsed only in sandboxed
# children (media/sandbox.py).
FROM worker-deps AS worker
COPY --exclude=tests/*.py --exclude=tools/export-requirements.txt . .
RUN useradd --system --create-home --uid 10001 app
USER app
CMD ["python", "-m", "worker"]
