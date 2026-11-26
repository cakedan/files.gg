# Milestone 7 contract (rollout)

Milestone 7 takes files.gg from "green in e2e" to running in production on `files.gg`, `cdn.files.gg` and `api.files.gg`. It's a fresh launch: a new database and new B2 buckets, with nothing carried over; the old site is retired. It covers:
- the production server and its compose stack;
- zero-downtime deploys (notsobot.api's pattern);
- monitoring: Prometheus, Grafana and alerts to Discord (notsobot.api's pattern);
- the launch gates: production smoke and security checks, a load test, the Cloudflare body-limit check, a backup restore drill;
- clean-up of what's left of the old site;
- the two scanner follow-ups from Milestone 4;
- **the launch runbook** (`docs/redesign/LAUNCH.md`): every step that's an account, a form or a setting, in order, marked for who does it.

The design is PLAN.md Phase 5 "Rollout" and §4's open questions. Everything in milestones 2–6 holds. When this file and the plan disagree, this file wins; fix the plan afterwards.

**Not in Milestone 7:** paid plans, a second region, moving Postgres to a managed service, the client-side conversion fast path.

---

## Decisions

1. **(owner, 2026-11-25) One dedicated server runs the whole stack** (§1). Not the notsobot.api host: video transcodes, LibreOffice and ClamAV never compete with NotSoBot, and one outage never takes both down. Not split yet: the compose stack is designed so the converters can move to a second box later without code changes.
2. **(owner, 2026-11-25) Zero-downtime deploys, ported from notsobot.api's `deploy-api.sh`** (§3).
3. **(owner, 2026-11-25) Old links get the plain missing page.** No "the site was rebuilt" note.
4. **(owner, 2026-11-25) Prometheus and Grafana, with alerts to a Discord channel** through `GRAFANA_ALERT_DISCORD_WEBHOOK`, as notsobot.api does (§4).
5. **Metrics are counters in Redis** (notsobot.api's `metrics.py`, `REDIS_KEY_TOTALS`): every API and worker process increments a Redis hash, and one internal endpoint renders them in Prometheus' format. Sanic's worker processes and RQ's forked horses all count without `prometheus_client`'s multiprocess mode.
6. **Migrations must work with the code before and after them** (expand, then contract in a later release): a deploy runs migrations while the old API is still serving (§3.2).
7. **Only Cloudflare reaches the origin:** nginx requires Cloudflare's Authenticated Origin Pulls client certificate, and the firewall allows 443 only from Cloudflare's published ranges (§2.2).

---

## 1. The server

- **Size (recommended, for launch):** 16 cores / 32 threads, 128 GB RAM, 2 × 2 TB NVMe in RAID 1 (for example a Hetzner AX102-class machine). Files live in B2, so the disk holds Postgres, Redis, the scan and convert scratch space and the Docker images. A video transcode uses 2–4 cores; the converter pools' `cpus` limits (milestone-5 §3.1) keep conversions from starving the API.
- **OS:** Debian 13, Docker Engine with the compose plugin from Docker's repository, `unattended-upgrades` for security updates, `chrony`, a non-root deploy user with SSH keys only (password login and root login off).
- **Firewall (`nftables`):** 22 from the owner's addresses only; 443 from Cloudflare's IPv4 and IPv6 ranges only (`ops/cloudflare-ips.sh` refreshes the set from `https://www.cloudflare.com/ips-v4` and `/ips-v6`, weekly by cron); nothing else inbound. Prometheus and Grafana are reached through an SSH tunnel, never published.
- **Docker logs:** the `json-file` driver with `max-size: 50m`, `max-file: 5` on every service (`x-logging` in compose).

## 2. The production compose stack

### 2.1 What runs

`docker-compose.yml` as built in milestones 1–6, plus the monitoring services of §4. Every service has `restart: unless-stopped` (one-offs: `migrate`, `bucket` excluded), a health check where it serves something, `cpus` / `mem_limit` from the sizes in §1, and nothing published but nginx's 443.

### 2.2 nginx

- TLS with the Cloudflare **origin certificate** for `files.gg`, `*.files.gg` (already in `nginx/certificates/`, never committed: `.gitignore` covers the key).
- **Authenticated Origin Pulls:** `ssl_client_certificate` is Cloudflare's origin-pull CA and `ssl_verify_client on`. A request that didn't come through Cloudflare is refused at TLS.
- Custom domains (Cloudflare for SaaS) reach the same origin through the fallback origin `origin.files.gg`, which needs the same certificate setup. **Change from milestone-6 §17:** the fallback origin is `origin.files.gg` (a proxied record to this server), no longer the originless `fallback.files.gg AAAA 100::`; `domains.files.gg` (`CUSTOM_DOMAIN_TARGET`) is a CNAME to `origin.files.gg`. The Worker's `*/*` route still answers every custom hostname, so the origin normally sees none of their requests (LAUNCH.md §2 checks this on staging).
- `/internal/*` stays unreachable from outside (milestone-4). The Worker's own lookups do reach it through nginx (`GET https://api.files.gg/internal/{files,albums,domains}/<id>`: a Worker's subrequest to its own route goes to the origin), so nginx can't refuse all of it: it passes exactly those three paths, and only with the Worker's `ORIGIN_SHARED_SECRET` and `X-Filesgg-Internal-Lookup: 1`; everything else under `/internal` (any spelling, `/internal/metrics` included) is a 404 at nginx. Prometheus scrapes `/internal/metrics` on the compose network.
- Request body limit `client_max_body_size` matches `PROXY_BODY_LIMIT_BYTES` plus framing.

### 2.3 Configuration

- `.env.example` lists every variable the stack reads, grouped by service, with what generates each secret. `ops/check-env.sh` refuses a deploy when a required variable is missing or still a placeholder.
- Production-only values: `PUBLIC_URL=https://files.gg`, `CDN_URL=https://cdn.files.gg`, `API_PUBLIC_URL=https://api.files.gg`, the real Turnstile site key and secret, `CSAM_MATCHER=photodna` with its key (stand-in refused: milestone-4), `WEB_RISK_API_KEY`, `POSTMARK_SERVER_TOKEN`, the Discord app, the Cloudflare API token and zone, the B2 keys (read-only for the Worker), the evidence public key.
- No `FILESGG_DEV_TOOLS`, no `SESSION_COOKIE_INSECURE`, no `FILESGG_ALLOW_LEGAL_PLACEHOLDERS` in production.

## 3. Deploys (`ops/deploy.sh`)

A port of notsobot.api's `deploy-api.sh`, extended to the whole stack.

### 3.1 Steps

1. `ops/check-env.sh`; `git pull --ff-only`; build the images.
2. **Migrate:** `docker compose run --rm migrate`. Migrations are expand-only for a deploy (decision 6); a contract step ships in the following release.
3. **API rollover:** start a second `api` container next to the running one (`--scale api=2 --no-recreate`); wait until each of its Sanic workers logs `[api] worker <n> ready` (added to `after_server_start`, as notsobot's marker); nginx resolves `api` through Docker's DNS with `resolver 127.0.0.11 valid=5s` and an upstream on the service name, so both receive requests; then stop the old one with SIGTERM and `stop_grace_period` 60 s (Sanic's `GRACEFUL_SHUTDOWN_TIMEOUT`, raised to 50 s so a 10 MiB chunk in flight finishes). If the new one never gets ready, it's removed and the old one keeps serving.
4. **Workers:** `worker`, `scanner`, `rescanner` (Postgres queue) and the three converter pools (RQ) are recreated with SIGTERM: the Postgres worker finishes its current job; RQ's warm shutdown waits for the running horse. `stop_grace_period` is each pool's longest time limit plus a minute (converters: 31 min for premium, 11 for members, 3 for previews). New jobs wait in the queue meanwhile; nothing is lost.
5. **Cloudflare Worker and web:** `npm run build:web` then `wrangler deploy` from `cf-worker/` (the production build refuses legal placeholders, milestone-5 §19.6). The Worker ships after the API, so a new route never reaches an API that lacks it.
6. A short post-deploy smoke check (§5.1, `--quick`).

### 3.2 Rules

- Never two deploys at once (a lock file); `deploy.sh --status` shows what's running and which commit.
- Rollback: `ops/deploy.sh --ref <previous commit>` rebuilds and rolls over the same way. Migrations don't roll back (they're expand-only, so the old code still works on the new schema).

## 4. Monitoring

### 4.1 Services

Added to compose, as in notsobot.api: `prometheus` (15-day retention, a named volume), `grafana` (provisioned, admin password from `.env`), `exporter-node`, `exporter-postgres`, `exporter-redis`, and `cadvisor` for per-container CPU and memory. None published (§1).

### 4.2 Metrics from files.gg (`api/utils/metrics.py`)

Counters and histogram buckets in the Redis hash `filesgg:metrics` (HINCRBYFLOAT, one pipeline per event), rendered by `GET /internal/metrics` on the API (internal only; Prometheus scrapes the `api` service directly on the compose network):
- HTTP: requests by route pattern, method and status class; duration buckets by route.
- Uploads: single and chunked, count and bytes, by signed-in / guest / key; refusals by code.
- Scans: results by state and reason; duration buckets; the pending count and oldest pending age (gauges, read from Postgres at scrape time).
- Conversions: milestone-5's `filesgg:metrics:jobs` re-exported, plus queue lengths and oldest age (gauges).
- Rate limits: refusals by scope; Redis errors on fail-open and fail-closed limits.
- Email sends by tag and outcome; Turnstile verifications by outcome; CSAM matcher calls and errors.
- The Postgres pool (in use, waiting) and Redis client errors.

Route patterns, never raw paths: no vanity, id or address ends up in a label.

### 4.3 Dashboards and alerts

- One provisioned dashboard, `files.gg`: traffic and errors, uploads, scans, conversions, rate limits, the host and containers, Postgres and Redis.
- Alerts to Discord (`GRAFANA_ALERT_DISCORD_WEBHOOK`), each with a runbook line in `LAUNCH.md`:
  - API 5xx above 2% for 5 minutes; p95 latency of the page routes above 1 s for 10 minutes;
  - scans pending over 10 minutes (uploads can't publish), and any CSAM matcher errors (uploads fail closed);
  - a conversion queue's oldest job over 10 minutes (members) or 30 (premium);
  - disk above 85%, memory above 90%, a container restarting more than 3 times in 10 minutes;
  - Postgres, Redis or ClamAV down; Redis refusing (fail-closed limits answering 503);
  - backups: the daily backup didn't report to its healthcheck in 26 hours (healthchecks.io's own alert, `DB_BACKUP_HEALTHCHECK_URL`).

## 5. Launch gates (scripts in `ops/`)

### 5.1 `ops/smoke.mjs`: production smoke and security checks

Run against a base URL with a staff upload key. Everything it uploads is deleted at the end. Read-only by default, `--uploads` to include the upload checks. Covers PLAN.md Phase 5's `cdn.files.gg` hardening list:
- the pages (home, viewer, album, legal, changelog, `security.txt`) answer with their security headers (CSP, `X-Content-Type-Options`, HSTS, `Referrer-Policy`, frame rules);
- uploads of HTML, SVG, a PDF with `/JavaScript`, a polyglot image-zip, a renamed `.exe`, an archive with an `.exe`, an encrypted archive, a macro `.docx` and a bidi-trick filename: each blocked, forced to text, flagged or sandboxed as milestones 2–4 say;
- a page on `cdn.files.gg` can't set a `__Host-` cookie for `files.gg`;
- `/internal/*` unreachable through every host;
- the body-limit check: exactly 100,000,000 bytes through `api.files.gg` succeeds, one byte more is `413`.
`--quick` (used by deploys) runs only the page and header checks.

### 5.2 `ops/loadtest.mjs`

Streaming single uploads and chunked uploads at a configurable concurrency against **two API containers** (the deploy rollover state, kept up on purpose), with the chunks of each session spread across both, and three `worker` replicas, confirming:
- every upload completes, with the right hash;
- each scheduled task ran once per period (from the scheduler's own rows);
- p95 upload throughput and error counts, written to a report.
Run on the production server before launch, against a staging hostname, with a throwaway B2 bucket.

### 5.3 `ops/restore-drill.sh`

Restores the newest restic snapshot into a throwaway Postgres container, checks row counts of the main tables and the migration history, and reports. Run before launch and monthly.

## 6. Clean-up of the old site

- Delete `frontend/` (the old Mithril app: 67 tracked files). PLAN.md Phase 5 marked it removed in Milestone 3; it wasn't.
- The deploy-time items in PLAN.md "Before the first deploy": the old zone-level Worker and its routes, `PROXY_SECRET`, `CORS_ALLOWED_ORIGINS`, the `proxy.files.gg` DNS record (in `LAUNCH.md`).
- Anything else of the old stack still in the repo (old compose services, scripts or docs that describe it), found by a sweep and removed.

## 7. Scanner follow-ups (from Milestone 4)

- **One B2 read per scan:** the scanner downloads a file once into its scan directory and every check reads that copy (it reads it up to four times today).
- **The NSFW model loads once per scanner process,** not per scan.
- **Web Risk warnings link to a page per threat type** ("learn more"), on files.gg, explaining malware, social engineering and unwanted software in plain words.

## 8. The runbook (`docs/redesign/LAUNCH.md`)

Every step that isn't code, in order, each marked **Dan** (an account, a payment, a form, a legal decision) or **Claude** (a command or a change once Dan has given the access or the value), with how to check it's done:
1. Rent the server; Debian, users, SSH, firewall, Docker (§1).
2. Cloudflare: SSL Full (strict), the origin certificate, Authenticated Origin Pulls, the CSAM Scanning Tool, Cloudflare for SaaS with the fallback origin, Email Routing for `abuse@`, `support@`, `dmca@`, `privacy@`.
3. B2: the files bucket and the Object Lock evidence bucket (US), application keys (read-only for the Worker), the restic repository.
4. Vendors: Turnstile production keys, PhotoDNA (application), Web Risk key, Postmark sender domain with DKIM, Return-Path, SPF and DMARC, the Discord application and redirect URI, healthchecks.io checks.
5. Legal: the NCMEC ESP registration, the DMCA designated agent (US Copyright Office, $6), the Terms and Privacy placeholders and the open questions with a lawyer, the changelog's launch date.
6. Search Console for `files.gg`; `security.txt` contacts live.
7. Staging run: the stack on the server under a staging hostname, `smoke.mjs --uploads`, `loadtest.mjs`, `restore-drill.sh`, the body-limit check.
8. Launch: DNS to the new origin, the Worker deployed on the production routes, the old Worker removed, a full smoke check, the first staff account (`tools.create_user` is dev-only; production staff are made with `python -m tools.staff` on a registered account).
9. The first week: watch the dashboard and the alerts, the admin queue, the scan and conversion queues.

---

## 9. Tests

- **API:** the metrics module (counters, labels never carry a vanity, id or address; rendering), `/internal/metrics` unreachable from outside, the ready marker.
- **Scanner:** one B2 read per scan (counted), the model loaded once per process.
- **Ops scripts:** `deploy.sh`, `check-env.sh`, `smoke.mjs`, `loadtest.mjs` and `restore-drill.sh` run against the local e2e stack in CI-style checks (the smoke check's upload section included; the deploy script's rollover against the e2e compose with two API containers).
- **e2e:** still 44/44 after the changes, plus a step for the Web Risk "learn more" links.

## 10. Still to verify

- Cloudflare's body limit unit (the §5.1 check on the real zone).
- Authenticated Origin Pulls with Cloudflare for SaaS custom hostnames (Cloudflare's docs describe zone-level and per-hostname certificates; confirm which applies to the fallback origin).
- Sanic's behaviour when two containers share the API's upstream during a rollover, under the load test.

## 11. Regional rules: adult content and the minimum age (decided 2026-11-25)

Dan's decisions (`LAUNCH.md` "Decisions", 2026-11-25; the lawyer confirms): **adult content is not available in the UK** (instead of the Online Safety Act's age checks), and **the minimum age is 13, or 16 in the EU and EEA** (18 for adult content everywhere, as today). Both depend on the visitor's country, which only Cloudflare knows.

### 11.1 The country and the setting

- **The country** is `request.cf.country` in the Worker (ISO 3166-1 alpha-2, upper case), and nothing else: never a request header (wrangler's test harness passes a client's `CF-IPCountry` straight through, and production must not trust one). Cloudflare's `XX` (unknown) and `T1` (Tor) count as unknown.
- **The Worker forwards it** to the API on every forwarded request, as `X-Filesgg-Client-Country: <CC>`, next to `X-Filesgg-Client-Ip` and only with the origin secret (`originRequestHeaders` in `worker/utils/security.js`). Client-sent copies are always removed, with or without a secret, like the other `X-Filesgg-*` headers. No country (absent, `XX`, `T1`): no header.
- **The API believes it** only from the trusted Worker (`client_ip.from_trusted_worker`), validated as two letters `A`–`Z`; otherwise the country is unknown (`None`). It's on `request.ctx.client_country`, set where `request.ctx.client_ip` is. It's never stored or logged.
- **`ADULT_BLOCKED_COUNTRIES`**: comma-separated country codes where adult content is unavailable; unset or empty means `GB`. One `.env` value feeds both enforcers: compose passes it to `api` (`${ADULT_BLOCKED_COUNTRIES:-GB}`), and `ops/deploy.sh` passes it to the Worker with `--var` like the S3 values; `wrangler.toml` `[vars]` (and `[env.staging.vars]`) default it to `GB`. `ops/check-env.sh` refuses a value that isn't comma-separated two-letter codes. Unknown countries are never blocked.
- **The EEA list** (API only, a constant): AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE, IS LI NO. **Minimum age:** 16 there, and 16 for an unknown country (the conservative statement); 13 elsewhere.

### 11.2 Worker: nothing adult is served to a blocked country

A request from a blocked country for adult content gets **451 Unavailable For Legal Reasons**, `Cache-Control: no-store`, and leaks nothing about the file beyond what the URL already says:

- **Viewer shells** (`decideFileShell`, `decideAlbumShell`, so files.gg and custom domains alike): a file whose lookup says `nsfw: true`, or an album that `albumIsNsfw`, gets the shell with `state: 'region'`, status 451, and boot data `{ vanity }` only (no name, size, og image or description: the default meta). The order: missing, removed and hidden first (their own states, unchanged), then **region**, then the lock, view limits and the rest. A 451 is never counted as a view, and bots get the same 451.
- **CDN** (`cdn.js`, also used by custom domains): a file's bytes, every preview kind (thumbnails, posters, waveforms, `display`, `document`) and an album's collage and ZIP, when the file's lookup has `nsfw: true` or the album `albumIsNsfw`: 451 with the CDN's usual error body for that route. Checked after the lookup and the missing/removed checks, before the signature, so a valid signed URL or a staff URL doesn't get past it (UK staff can't review adult content; noted for the lawyer).
- A new helper (`worker/utils/region.js`): `clientCountry(request)`, `adultBlocked(env, country)` from `ADULT_BLOCKED_COUNTRIES`. Unit tests for the parsing (unset, empty, spaces, lower case) and integration tests: with `ADULT_BLOCKED_COUNTRIES=US` (the harness's country) an nsfw file's shell, bytes and previews and an nsfw album's shell, collage and ZIP are 451 with nothing of the file in the body; a non-nsfw file is served as before; the default `GB` serves the harness's `US` normally; a client's `CF-IPCountry`/`X-Filesgg-Client-Country` never reaches the API, and the Worker's own does (with the secret only).

### 11.3 API: nothing adult is uploaded or marked from a blocked country

- `api/utils/regions.py`: `adult_blocked(country)` (from `ADULT_BLOCKED_COUNTRIES`, read like the other settings) and `minimum_age(country)`.
- **Refused with `451 ADULT_CONTENT_UNAVAILABLE`** ("Adult content isn't available in your region") when `adult_blocked(request.ctx.client_country)`:
  - `POST /files` and `POST /uploads` with `nsfw` true, **including when it comes from the account's or the upload key's defaults** (never silently uploaded unmarked);
  - `PATCH /users/@me/files/<id>` and `POST /users/@me/files/nsfw` with `nsfw: true`;
  - `PATCH /users/@me/albums/<id>` with `nsfw: true`;
  - saving `upload_defaults.nsfw: true` (Settings → Uploads) and creating or changing an upload key with an nsfw default.
  
  Unmarking (`nsfw: false`), the NSFW review request, reports, the scanner's own NSFW marking and staff actions are unchanged. The refusal is checked before any upload bytes are read where the endpoint allows (`POST /uploads` at session creation; `POST /files` before streaming).
- **`GET /users/@me/limits`**: `nsfw_allowed` is also false when blocked, and a new `adult_region_blocked: bool` says why.
- **`GET /auth/config`** (public): `{ discord, minimum_age, adult_content_available }`, from the request's country.
- `ADULT_CONTENT_UNAVAILABLE` in `errors.py`'s code table; the upload-refusal metric counts it by code with no change.
- Tests: the header is believed only with the secret, validated, and absent otherwise; each refusal above from `GB` with the secret, and the same requests allowed from `US` and with no country; unmarking allowed from `GB`; defaults and key defaults refused from `GB`; `/auth/config` gives 16 for `DE`, `NO` and no country, 13 for `US` and `GB`; `ADULT_BLOCKED_COUNTRIES` parsing.

### 11.4 Web

- **Viewer `state: 'region'`** (file and album pages): "This isn't available in your region." and "Adult content can't be viewed where you are." with a link to the Terms (`/legal/terms#adult-content`). No file details.
- **Where adult content is offered** (the Upload page's sensitive toggle, the upload-key dialog, Settings → Uploads defaults, a file's and an album's "Mark as sensitive", the bulk action): hidden as today when `nsfw_allowed` is false; when `adult_region_blocked` is true, one line says "Adult content isn't available in your region." instead of nothing. Signed-out visitors use `/auth/config`'s `adult_content_available`.
- **`ADULT_CONTENT_UNAVAILABLE`** has a message in `lib/errors.ts` (the same sentence).
- **Sign-up** (`TermsAgreement`): "…and confirm you're `<minimum_age>` or older", from `/auth/config`; until it loads, the age clause is left out rather than guessed.
- **Terms** (`web/src/content/legal/terms.md`): "You must be 13 or older to use files.gg, or 16 or older in the European Union, Iceland, Liechtenstein and Norway." The adult-content section (anchor `adult-content`) adds: "Adult content isn't available in the United Kingdom: it can't be viewed, uploaded or marked from there." **Privacy** (`privacy.md`): files.gg uses the country Cloudflare derives from your IP address to apply these regional rules, and doesn't store it.
- Tests for each of the above, including the region state's text and that it shows no file data.

### 11.5 Docs

`.env.example` documents `ADULT_BLOCKED_COUNTRIES`; `LAUNCH.md` §0's table lists it; `cf-worker/README.md` lists the new var and header; `api` docs list the header next to `X-Filesgg-Client-Ip`.
