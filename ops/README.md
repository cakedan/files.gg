# ops/

Scripts for running files.gg in production (docs/redesign/contracts/milestone-7.md). The step-by-step launch, with
the accounts, forms and settings around these scripts, is [`docs/redesign/LAUNCH.md`](../docs/redesign/LAUNCH.md).

| Script | What it does |
| --- | --- |
| `check-env.sh` | Refuses a configuration that isn't ready for production. `deploy.sh` runs it first. |
| `deploy.sh` | Zero-downtime deploys of the whole stack, rollbacks, `--status`. |
| `cloudflare-ips.sh` | Writes Cloudflare's IP ranges as nftables sets, for the firewall. |
| `nftables.conf.example` | The server's firewall: SSH from the admin addresses, 443 from Cloudflare, nothing else. |
| `smoke.mjs`, `loadtest.mjs`, `restore-drill.sh` | The launch gates (§5); see their headers. |

Everything runs on the server, from the checkout, as the deploy user (in the `docker` group). `ENV_FILE` picks the
configuration (default `.env`; the staging run uses `.env.staging`).

## Configuration: `.env` and `check-env.sh`

Copy [`.env.example`](../.env.example) to `.env`, replace every `CHANGE_ME` (the comments say where each value comes
from; generated secrets are `openssl rand -hex 32`), then:

```sh
ops/check-env.sh
```

It lists every problem and exits 1 when there's one: a required variable missing, empty or still a placeholder; a
development flag (`FILESGG_DEV_TOOLS`, `SESSION_COOKIE_INSECURE`, `FILESGG_ALLOW_LEGAL_PLACEHOLDERS`, the stand-ins,
`DEBUG`, `VITE_API_URL`) set in `.env` or the shell; `CSAM_MATCHER` other than `photodna`; a short or malformed secret;
a non-https public URL; nginx's `client_max_body_size` not matching `PROXY_BODY_LIMIT_BYTES` + 1 MiB; and the origin
certificate (`nginx/certificates/certificate.cert` and `.key`) missing, not a pair, or expiring within 30 days. It
never prints a value.

The origin certificate and key come from Cloudflare (SSL/TLS > Origin Server, for `files.gg` and `*.files.gg`) and are
put in `nginx/certificates/` by hand; `.gitignore` keeps them out of git. Cloudflare's origin-pull CA next to them is
public and committed.

## Deploys: `deploy.sh`

```sh
ops/deploy.sh                  # pull master, build, migrate, roll everything over
ops/deploy.sh --status         # what's deployed, whether a deploy is running, the containers
ops/deploy.sh --ref <commit>   # roll back (or forward) to a commit, the same way
```

Options: `--no-pull` (deploy the checkout as it is), `--no-build` (use the images already built), `--no-worker` (skip
the website and the Cloudflare Worker), `--no-smoke`. One deploy at a time: a second one refuses while the first runs
(the lock is `.deploy/lock`; a lock left by a deploy that died is removed). `.deploy/deployed` records the last
deployed commit and `.deploy/history.log` every deploy.

What it does, in order:

1. `check-env.sh`; `git pull --ff-only` (or checks out `--ref`; it refuses a checkout with uncommitted changes); pulls
   the pinned images it lacks and builds ours.
2. Starts postgres and redis if they're not running, then `docker compose run --rm migrate` while the old API still
   serves. Migrations are expand-only (contract decision 6): the old code must work on the new schema, and a
   rollback never undoes a migration. Removing a column or a table is the next release's job.
3. **The API rollover.** A second `api` container starts next to the running one. Once each of its Sanic workers has
   logged `[api] worker <pid> ready`, the script waits 11 s more (nginx re-resolves `api` every 5 s and takes out for
   10 s a container that refused a connection), then sends the old container SIGTERM: it stops accepting at once and
   finishes its in-flight requests (up to 50 s, Sanic's `GRACEFUL_SHUTDOWN_TIMEOUT`; it's killed after 70 s). nginx
   finds `api` through Docker's DNS, so both containers get requests until the old one is gone, and a refused
   connection is retried on the other. **If the new container isn't ready within 180 s (`READY_TIMEOUT`), it's
   removed, the old one keeps serving, and the deploy stops there.**
4. `worker`, `scanner`, `rescanner`: recreated where their image or definition changed, with SIGTERM; each finishes
   its current job (up to 10 minutes). The converters: when one of them or `office` changed, they're stopped (RQ's
   warm shutdown waits for running jobs, up to 31 minutes for premium, 11 for members, 3 for previews), `office` is
   recreated, and they start again. Jobs queued meanwhile wait; nothing is lost.
5. The monitoring and backup services (recreated where they changed; prometheus and grafana restart when
   `monitoring/` changed since the last deploy), and nginx: `nginx -t`, then a reload.
6. The website and the Worker: `npm run build:web` (with `VITE_TURNSTILE_SITE_KEY` from `.env`) and `wrangler deploy`
   in `cf-worker/`, after the API so a new route never reaches an API that lacks it. `S3_ENDPOINT`, `S3_REGION` and
   `S3_BUCKET_FILES` come from `.env` (`--var`). wrangler signs in with `WORKER_DEPLOY_API_TOKEN` (and
   `CLOUDFLARE_ACCOUNT_ID`) when they're set, else with the deploy user's `npx wrangler login`. `WORKER_ENV=staging`
   deploys the staging Worker instead (`cf-worker/wrangler.toml`).
7. `node ops/smoke.mjs <PUBLIC_URL> --quick` (skipped with a warning if it or node is missing).

postgres, redis and clamav are never recreated by a deploy (that's an outage). When their definition changed the
deploy says so at the end; recreate one at a quiet moment with `docker compose up -d <service>`.

To keep two API containers up on purpose (the load test, LAUNCH.md §7.5):
`docker compose up -d --no-deps --no-recreate --scale api=2 api`; the next deploy refuses until it's back to one
(`docker compose up -d --no-deps --scale api=1 api`).

## The firewall: `nftables.conf.example` and `cloudflare-ips.sh`

As root, once:

```sh
apt install nftables
cp ops/nftables.conf.example /etc/nftables.conf   # then set WAN and the admin_v4 / admin_v6 addresses
mkdir -p /etc/nftables.d
ops/cloudflare-ips.sh                              # writes /etc/nftables.d/cloudflare.nft
nft -c -f /etc/nftables.conf && nft -f /etc/nftables.conf
systemctl enable nftables
```

Keep an SSH session open while trying it. The rules live in their own table (`inet filesgg`) and never flush Docker's.
Port 443 is filtered in `prerouting`, before Docker's DNAT, because a published port never passes the `input` chain.

Weekly, from root's crontab (it only rewrites the file when Cloudflare's lists changed, and puts the old one back if
the ruleset doesn't load):

```
17 4 * * 1  /path/to/checkout/ops/cloudflare-ips.sh --reload
```

## Prometheus and Grafana

Neither is published. Reach them through an SSH tunnel to the container's address on the compose network:

```sh
ssh -L 3000:$(ssh <server> "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' filesgg-grafana-1"):3000 <server>
# then http://localhost:3000 (admin, GRAFANA_ADMIN_PASSWORD)
```

The same with `filesgg-prometheus-1` and port 9090 for Prometheus.

## Services and ports (compose network only)

| Service | Port | Notes |
| --- | --- | --- |
| `nginx` | 443 (published) | TLS, Authenticated Origin Pulls; `127.0.0.1:8081/healthz` inside the container for its health check |
| `api` | 8080 | `/health`; `/internal/metrics` needs the origin secret and `X-Filesgg-Internal-Lookup: 1` |
| `prometheus` | 9090 | 15 days of data in the `prometheus-data` volume; config in `monitoring/prometheus/` |
| `grafana` | 3000 | provisioning in `monitoring/grafana/provisioning`, dashboards in `monitoring/grafana/dashboards` |
| `exporter-node` | 9100 | the host |
| `exporter-postgres` | 9187 | |
| `exporter-redis` | 9121 | |
| `cadvisor` | 8080 | per container, labelled by compose service |
| `postgres` | 5432 | `docker compose exec postgres psql -U filesgg` |
| `redis` | 6379 | |

Docker's logs are `json-file`, 5 files of 50 MB per container.
