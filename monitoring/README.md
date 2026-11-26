# Monitoring

Prometheus, Grafana and alerts to Discord, as notsobot.api has them (contract milestone-7 §4, decisions 4 and 5).
None of it is published: Grafana is reached through an SSH tunnel (ops/README.md), Prometheus only from Grafana.

```
monitoring/
  prometheus/prometheus.yml               what Prometheus scrapes, every 15 s
  grafana/provisioning/datasources/       the Prometheus datasource (uid `prometheus`)
  grafana/provisioning/dashboards/        loads grafana/dashboards/ into the "files.gg" folder
  grafana/provisioning/alerting/          the Discord contact point and every alert
  grafana/dashboards/filesgg.json         the "files.gg" dashboard
```

docker-compose.yml mounts `prometheus/` at `/etc/prometheus`, `grafana/provisioning/` at `/etc/grafana/provisioning`
and `grafana/dashboards/` at `/etc/grafana/dashboards`. A deploy restarts both when `monitoring/` changed.

## Where the numbers come from

| Job | Target | What |
| --- | --- | --- |
| `filesgg` | `api:8080/internal/metrics` | files.gg's own metrics (below) |
| `node` | `exporter-node:9100` | the host: CPU, memory, disks |
| `postgres` | `exporter-postgres:9187` | Postgres (`pg_up`, connections, transactions, size) |
| `redis` | `exporter-redis:9121` | Redis (`redis_up`, memory, commands, errors) |
| `cadvisor` | `cadvisor:8080` | each container's CPU, memory, network and restarts, by compose service |

### files.gg's metrics (`api/utils/metrics.py`)

Every API worker, the Postgres-queue workers and the converters' forked horses count into one Redis hash,
`filesgg:metrics` (HINCRBYFLOAT, one pipeline per event), and `GET /internal/metrics` on any API container renders it
in Prometheus' text format, so no process needs `prometheus_client`'s multiprocess mode. From code:

```python
from utils import metrics

metrics.incr('filesgg_uploads_total', {'kind': 'single', 'uploader': 'guest'})
metrics.incr('filesgg_upload_bytes_total', {'kind': 'single', 'uploader': 'guest'}, size)
metrics.observe('filesgg_scan_seconds', seconds)
metrics.set_gauge('filesgg_scheduled_task_last_success_timestamp_seconds', time.time(), {'task': name})
```

The calls never raise and never make a request wait: on the API's event loop the write is a task, elsewhere a quick
pipeline. While Redis is down each process keeps its counts and writes them once Redis answers again.

**Labels never carry a path, vanity, id, email or address.** Every metric is declared in `METRICS` with the values each
label may take: a fixed set, route patterns (`/files/<vanity:path>`, registered from the app's router), the declared
rate-limit scopes, or a shape (an UPPER_SNAKE error code). Anything else is recorded as `other`. A new metric or label
value is added there first; an undeclared metric is logged and dropped.

`/internal/metrics` answers only what the Worker's lookups send: the origin secret and `X-Filesgg-Internal-Lookup: 1`.
Prometheus sends both; the secret comes from the compose secret `origin_shared_secret` (ORIGIN_SHARED_SECRET), read
from `/run/secrets/origin_shared_secret`, never written in `prometheus.yml`. The Worker never forwards that header and
refuses `/internal/*` on every host, so the endpoint is unreachable from outside.

| Metric | Labels | Written by |
| --- | --- | --- |
| `filesgg_http_requests_total` | route, method, status (`2xx`...) | the API's middleware; `unmatched` when no route matched |
| `filesgg_http_request_duration_seconds` | route | the same (uploads include reading the body) |
| `filesgg_uploads_total`, `filesgg_upload_bytes_total` | kind (`single`, `chunked`), uploader (`signed_in`, `guest`, `key`) | `POST /files`; chunked uploads once finalized |
| `filesgg_upload_refusals_total` | kind, code | the upload endpoints' errors; chunked uploads failed at finalizing |
| `filesgg_scans_total` | state, reason | the scanner, per first scan |
| `filesgg_scan_seconds` | | the scanner |
| `filesgg_csam_matcher_calls_total` | matcher, outcome (`match`, `no_match`, `error`) | the matchers |
| `filesgg_ratelimit_refusals_total` | scope | the rate limiter |
| `filesgg_ratelimit_unavailable_total` | fail (`open`: let through, `closed`: 503) | the rate limiter, when Redis fails |
| `filesgg_redis_errors_total` | client (`ratelimit`, `convert_queue`, `metrics`) | Redis commands that failed |
| `filesgg_emails_total` | tag, outcome (`sent`, `failed`, `unconfigured`) | Account emails sent through Cloudflare Email Service |
| `filesgg_turnstile_verifications_total` | action, outcome (`passed`, `failed`, `mismatch`, `missing`, `error`, `unconfigured`) | Turnstile checks |
| `filesgg_scheduled_task_last_success_timestamp_seconds` | task | the scheduler (gauge) |

Rendered on top at every scrape:

| Metric | From |
| --- | --- |
| `filesgg_conversion_jobs_total` {queue, result}, `_job_errors_total` {queue, code}, `_job_failures_total` {queue, reason}, `_job_duration_seconds` and `_job_wait_seconds` {queue}, `_job_cpu_seconds_total` {queue} | the converters' `filesgg:metrics:jobs` (`convert_worker.record_job`) |
| `filesgg_conversion_queue_length`, `filesgg_conversion_queue_oldest_seconds` {queue} | RQ (`convert_queue.queue_health`) |
| `filesgg_scans_pending`, `filesgg_scans_pending_oldest_seconds`, `filesgg_scans_stuck` | Postgres: hashes waiting for their first scan |
| `filesgg_db_pool_connections_in_use`, `_connections`, `_connections_max`, `_requests_waiting`, `filesgg_db_pool_processes` | every API worker's psycopg pool, which each worker writes to `filesgg:metrics:pools` every 10 s; the scrape adds up the fresh ones |
| `filesgg_metrics_collector_up` {collector} | 0 when a part of the scrape couldn't be read; the rest still renders |

## Alerts

`grafana/provisioning/alerting/alerts.yml`, to the Discord channel whose webhook is `GRAFANA_ALERT_DISCORD_WEBHOOK`.
Each alert's summary says what it means and its description what to check; `docs/redesign/LAUNCH.md` has a runbook line
for each.

| Alert | Fires when |
| --- | --- |
| API 5xx above 2% | 5xx over 2% of requests for 5 minutes |
| Page routes slow | p95 of the routes a page view waits on (the Worker's lookups, `/files/<vanity>`, `/albums/<vanity>`) over 1 s for 10 minutes |
| files.gg metrics not scraped | the scrape or one of its parts failing for 5 minutes (every alert below on files.gg's metrics is blind meanwhile) |
| Scans pending over 10 minutes | the oldest hash waiting for its first scan; uploads can't publish |
| CSAM matcher errors | any matcher error; uploads fail closed |
| Member / premium conversions waiting | the queue's oldest job over 10 minutes (members) or 30 (premium) |
| Disk above 85%, Memory above 90% | for 5 minutes |
| A container keeps restarting | more than 3 restarts in 10 minutes |
| Postgres down, Redis down | `pg_up` / `redis_up` 0, or their exporter gone |
| Redis refusing | fail-closed limits answered 503, or Redis refused writes (OOM, MISCONF, READONLY) |
| ClamAV down | cAdvisor doesn't see a running `clamav` container (a hung clamd shows as scans pending) |

The daily database backup is watched by healthchecks.io instead: `backup-db` pings `DB_BACKUP_HEALTHCHECK_URL` after
each run, and healthchecks.io alerts when it hasn't for 26 hours (set its period and grace there, and its own Discord
integration to the same channel).

## Changing things

- **The dashboard:** edit it in Grafana (edits are allowed and kept until the file changes), then export the JSON
  (Share, Export, without "export for sharing externally") over `grafana/dashboards/filesgg.json`.
- **An alert:** edit `alerts.yml`; provisioned rules can't be edited in Grafana. Check a change with a throwaway
  Grafana (below) before deploying it.
- **Checking the configs:**

  ```sh
  docker run --rm --entrypoint promtool -v "$PWD/monitoring/prometheus:/etc/prometheus:ro" \
    prom/prometheus:v3.16.0 check config /etc/prometheus/prometheus.yml
  docker run -d --name grafana-check -e GF_SECURITY_ADMIN_PASSWORD=check \
    -e GRAFANA_ALERT_DISCORD_WEBHOOK=https://discord.com/api/webhooks/0/placeholder \
    -v "$PWD/monitoring/grafana/provisioning:/etc/grafana/provisioning:ro" \
    -v "$PWD/monitoring/grafana/dashboards:/etc/grafana/dashboards:ro" grafana/grafana:13.2.6
  docker logs grafana-check 2>&1 | grep -E 'provision|level=error'   # then: docker rm -f grafana-check
  ```
