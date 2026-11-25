# files.gg launch runbook

Everything between "green in e2e" and files.gg running in production on `files.gg`, `cdn.files.gg` and `api.files.gg` that isn't code: accounts, forms, settings, keys, commands, and the checks that say each one is done. It's a fresh launch: a new database and new B2 buckets, nothing carried over, the old site retired ([`contracts/milestone-7.md`](contracts/milestone-7.md) §8).

**Who:** every step is marked **Dan** (an account, a payment, a form, a legal decision, anything that needs his identity or card) or **Claude** (a command or a change, once Dan has given the access or the value). **Check** says how to know the step is done. Do the sections in order; within a section, steps marked for different people can run in parallel.

**The other runbooks:**
- [`ops/README.md`](../../ops/README.md): the server, `.env`, `ops/check-env.sh`, `ops/deploy.sh` (deploys, rollbacks, `--status`), `ops/smoke.mjs`, `ops/loadtest.mjs`, `ops/restore-drill.sh`, `ops/cloudflare-ips.sh`, the firewall.
- [`monitoring/README.md`](../../monitoring/README.md): Prometheus, Grafana (through an SSH tunnel), the dashboard and the alert rules.
- [`backup/README.md`](../../backup/README.md): restic backups to B2, retention, restoring.
- [`cf-worker/README.md`](../../cf-worker/README.md): the Worker's bindings, secrets and routes.

**Conventions:** commands run on the server from the checkout (for example `/srv/filesgg`) as the deploy user, unless they say otherwise. `dc` is `docker compose --env-file "${ENV_FILE:-.env}"` (the staging run in §7 sets `ENV_FILE=.env.staging`). Secrets are generated with `openssl rand -hex 32` and never pasted into chat, issues or commits: Dan puts vendor secrets straight into `.env` on the server (or into a password manager Claude reads from), and Claude never prints them.

**Not verified yet** (each has its check where it comes up): the unit of Cloudflare's 100 MB request-body limit (§7.5), Authenticated Origin Pulls on the Cloudflare for SaaS path (§2.4), a B2 application key that can write the evidence bucket and read the files bucket only (§3.3), Turnstile inside a cross-origin iframe and the other milestone-6 §18 items (§7.6), and Sanic with two API containers behind nginx during a rollover (§7.4).

---

## 0. The values, and where each one goes

Every value the stack needs, who produces it, and the variable it goes into. `.env` on the server is read by `docker-compose.yml`, `ops/check-env.sh` and `ops/deploy.sh`; the Worker's values are set with `npx wrangler secret put` (secrets) or in `cf-worker/wrangler.toml` `[vars]`; the web build reads `VITE_*` from the environment of `ops/deploy.sh`.

| Value | Variable | Where | Produced by | Section |
|---|---|---|---|---|
| Public URLs | `PUBLIC_URL=https://files.gg`, `CDN_URL=https://cdn.files.gg`, `API_PUBLIC_URL=https://api.files.gg` | `.env` | Claude | 1.4 |
| App secrets | `SECRET_KEY`, `RPC_KEY`, `VIEW_HASH_SECRET`, `ABUSE_HASH_SECRET` | `.env` | Claude, `openssl rand -hex 32` | 1.4 |
| Shared with the Worker | `ORIGIN_SHARED_SECRET`, `CDN_SIGNING_SECRET` | `.env` **and** `wrangler secret put` (the same value in both) | Claude, `openssl rand -hex 32` | 1.4, 8.2 |
| Database and Redis | `POSTGRES_PASSWORD`, `REDIS_PASSWORD` (`DATABASE_URL`, `REDIS_URL` follow from them) | `.env` | Claude, `openssl rand -hex 32` | 1.4 |
| Backups | `DB_BACKUP_RESTIC_PASSWORD` | `.env`, plus a copy off the server in Dan's password manager | Claude generates, Dan stores | 3.4 |
| Backup monitoring | `DB_BACKUP_HEALTHCHECK_URL` | `.env` | Dan, healthchecks.io | 4.6 |
| Grafana | `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_ALERT_DISCORD_WEBHOOK` | `.env` | Claude (password); Dan (webhook) | 4.7 |
| B2 endpoint | `S3_ENDPOINT`, `S3_REGION` | `.env` and `wrangler.toml` `[vars]` | Dan, B2 | 3.1 |
| Files bucket | `S3_BUCKET_FILES` | `.env` and `wrangler.toml` `[vars]` | Dan, B2 | 3.1 |
| API's B2 key | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `.env` | Dan, B2 | 3.3 |
| Worker's B2 key (read-only) | `S3_READ_ACCESS_KEY_ID`, `S3_READ_SECRET_ACCESS_KEY` | `wrangler secret put` | Dan, B2 | 3.3 |
| Evidence bucket and key | `S3_BUCKET_EVIDENCE`, `S3_EVIDENCE_ACCESS_KEY_ID`, `S3_EVIDENCE_SECRET_ACCESS_KEY` | `.env` | Dan, B2 | 3.2, 3.3 |
| Backup bucket and key | `S3_BUCKET_DB_BACKUP`, `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY` | `.env` | Dan, B2 | 3.4 |
| Evidence public key | `EVIDENCE_PUBLIC_KEY` (the private key never touches a server) | `.env` | Dan, offline | 5.3 |
| CSAM matcher | `CSAM_MATCHER=photodna`, `PHOTODNA_SUBSCRIPTION_KEY`, `PHOTODNA_MATCH_URL` | `.env` | Dan, Microsoft | 4.2 |
| Web Risk | `WEB_RISK_API_KEY` | `.env` | Dan, Google Cloud | 4.3 |
| Turnstile | `VITE_TURNSTILE_SITE_KEY` (web build), `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES=files.gg` | `.env` | Dan, Cloudflare | 2.7 |
| Email | `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM` (default `files.gg <noreply@mail.files.gg>`) | `.env` | Dan, Postmark | 4.4 |
| Discord sign-in | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI=https://files.gg/app/auth/discord` | `.env` | Dan, Discord | 4.5 |
| Custom domains | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CUSTOM_DOMAIN_TARGET=domains.files.gg` | `.env` | Dan, Cloudflare | 2.5 |
| Origin certificate | `nginx/certificates/certificate.cert`, `certificate.key` (files on the server, never committed) | server | Dan creates, Claude installs | 2.3 |
| Body limit | `PROXY_BODY_LIMIT_BYTES` (default `104857600`) and nginx `client_max_body_size` (together) | `.env`, `nginx/nginx.conf` | Claude, after the check | 7.5 |

**Never in production:** `FILESGG_DEV_TOOLS`, `SESSION_COOKIE_INSECURE`, `FILESGG_ALLOW_LEGAL_PLACEHOLDERS`, `STANDIN_MODE`, `WEB_RISK_STANDIN_FILE`, `DOMAIN_DNS_STUB`, `DEBUG`, `VITE_API_URL`. `ops/check-env.sh` refuses each of them, and refuses `CSAM_MATCHER` other than `photodna`.

---

## 1. The server (contract §1)

### 1.1 Rent it — **Dan**
- A dedicated server, 16 cores / 32 threads, 128 GB RAM, 2 × 2 TB NVMe (for example Hetzner AX102), not the notsobot.api host. Pick the location now: it's the Privacy Policy's `[SERVER LOCATION]` (§5.4) and decides whether EU data stays in the EU.
- Give Claude root SSH once (an SSH key, never a password) for the install below, and the server's IPv4 and IPv6 addresses.
- **Check:** the provider's panel shows the server running; `ssh root@<ip>` works with the key.

### 1.2 Install the system — **Claude**
- Debian 13 on software RAID 1 over both NVMe disks (Hetzner: `installimage`, `SWRAID 1`, `SWRAIDLEVEL 1`).
- A non-root deploy user in the `docker` group, with Dan's and Claude's SSH keys only. In `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`, `KbdInteractiveAuthentication no`.
- `unattended-upgrades` (security updates, no automatic reboot), `chrony`.
- Docker Engine and the compose plugin from Docker's own apt repository (`download.docker.com/linux/debian`), not Debian's `docker.io`.
- `/etc/docker/daemon.json`: `{"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5"}}` (compose's `x-logging` sets the same per service).
- **Check:**
  - `cat /proc/mdstat` shows the arrays `[UU]`;
  - `ssh root@<ip>` and a password login are refused, `ssh deploy@<ip>` works;
  - `timedatectl` says `System clock synchronized: yes`;
  - `docker compose version` prints the plugin's version;
  - `systemctl status unattended-upgrades` is active.

### 1.3 The firewall — **Claude**
- `nftables` from [`ops/README.md`](../../ops/README.md) (`ops/nftables.conf.example`): 22 from Dan's addresses only; 443 from Cloudflare's IPv4 and IPv6 ranges only; nothing else inbound. `ops/cloudflare-ips.sh` refreshes the Cloudflare set from `https://www.cloudflare.com/ips-v4` and `/ips-v6`; install its weekly cron.
- Docker publishes nginx's 443 with its own rules, which bypass an `input` chain: the Cloudflare-only rule must also hold for forwarded traffic (the `DOCKER-USER` chain, or the equivalent in the example file).
- Prometheus and Grafana are never published; Grafana is reached with an SSH tunnel to the container's address ([`ops/README.md`](../../ops/README.md) "Prometheus and Grafana" has the command).
- **Check:** from a machine outside Cloudflare (a phone hotspot), `curl -vk --connect-timeout 5 https://<server ip>/` times out, and `nmap -Pn -p 1-65535 <server ip>` shows nothing open (22 only from Dan's address). From the server, `nft list ruleset` shows the Cloudflare sets filled. After the cron's first run, its log shows the ranges fetched.

### 1.4 The checkout and `.env` — **Claude**
- Clone the repository to `/srv/filesgg` as the deploy user. Copy `.env.example` to `.env` (mode 600), fill in the generated secrets (§0) and the public URLs, and leave the vendor values for Dan's steps.
- **Check:** `ops/check-env.sh` lists only the vendor values still missing (it never prints values). Nothing else is started yet.

---

## 2. Cloudflare (the `files.gg` zone)

All in the Cloudflare dashboard for the `files.gg` zone. **Dan** does the ones that need the account owner (plan, billing, the CSAM tool's verified email, Email Routing destinations); **Claude** can do the rest with an API token Dan creates for the purpose (Zone: Zone Settings Edit, SSL and Certificates Edit, DNS Edit, Workers Routes Edit; Account: Workers Scripts Edit), revoked after launch.

### 2.1 Plan and DNS records — **Dan** (plan), **Claude** (records)
- The plan decides the request-body limit (100 MB on Free and Pro, 200 MB on Business): see §7.5.
- DNS, all **proxied** (orange cloud):

  | Name | Type | Content | Why |
  |---|---|---|---|
  | `files.gg` | `AAAA` | `100::` | Originless: the Worker answers everything on `files.gg/*` |
  | `www` | `AAAA` | `100::` | The Worker's `*/*` route serves it as `files.gg` |
  | `cdn` | `AAAA` | `100::` | The Worker answers everything on `cdn.files.gg/*` |
  | `api` | `A` / `AAAA` | the server's addresses | The Worker passes `api.files.gg` through to this origin |
  | `origin` | `A` / `AAAA` | the server's addresses | The Cloudflare for SaaS fallback origin (§2.5) |
  | `domains` | `CNAME` | `origin.files.gg` | What customers point their subdomains at (`CUSTOM_DOMAIN_TARGET`) |

  Only during the staging run (§7): `staging`, `cdn-staging`, `api-staging` (flat names: Universal SSL and the origin certificate cover one level of `*.files.gg` only, so `cdn.staging.files.gg` would get no certificate).
- **Delete** the old site's records at launch (§8.3), including **`proxy.files.gg`**.
- **Check:** `dig +short api.files.gg` answers Cloudflare addresses, not the server's.

### 2.2 SSL/TLS — **Claude**
- **SSL/TLS → Overview:** encryption mode **Full (strict)**.
- **SSL/TLS → Edge Certificates:** Always Use HTTPS **on**; Minimum TLS Version **1.2**; TLS 1.3 **on**; Automatic HTTPS Rewrites on. **Leave Cloudflare's own HSTS setting off:** the Worker sends `Strict-Transport-Security` itself (`max-age=63072000; includeSubDomains; preload` on files.gg, `www.`, `cdn.` and `api.`; a plain one-year header on custom domains). The zone setting would also reach customers' custom hostnames, which must never get `includeSubDomains` or `preload`.
- **Check:** `curl -sI http://files.gg/` is a `301` to `https://`; `curl -sI https://files.gg/` answers (from the old site until §8).

### 2.3 The origin certificate — **Dan** creates, **Claude** installs
- **SSL/TLS → Origin Server → Create Certificate:** "Generate private key and CSR with Cloudflare", RSA 2048, hostnames `files.gg` and `*.files.gg`, validity 15 years. Copy the certificate and the key (the key is shown once) straight to the server as `nginx/certificates/certificate.cert` and `nginx/certificates/certificate.key` (mode 600). The repository's copies are empty placeholders; never commit the real ones.
- `nginx/certificates/cloudflare-origin-pull-ca.pem` (Cloudflare's public origin-pull CA, valid to 2029-11-01) is already in the repository.
- **Check:** `ops/check-env.sh` passes the certificate checks (present, matches its key, not expiring within 30 days). `openssl x509 -in nginx/certificates/certificate.cert -noout -subject -ext subjectAltName -enddate` shows both names.

### 2.4 Authenticated Origin Pulls — **Claude**
- **SSL/TLS → Origin Server → Authenticated Origin Pulls:** **on** (zone level). nginx has `ssl_verify_client on` with Cloudflare's CA, so a request that didn't come through Cloudflare fails at TLS.
- Turn it on **before** the stack starts serving: with nginx requiring the client certificate and the toggle off, every request through Cloudflare fails with 525/526.
- **Check:** `curl -sI https://api.files.gg/health` through Cloudflare answers (once the stack runs, §7); `curl -vk --resolve api.files.gg:443:<server ip> https://api.files.gg/health` from the server itself fails the handshake (no client certificate).
- **Unverified: Cloudflare for SaaS.** Cloudflare's docs describe zone-level and per-hostname origin-pull certificates; which one is presented when a custom hostname reaches the fallback origin isn't stated. In this stack the Worker's `*/*` route answers every custom hostname and only calls `api.files.gg` itself, so the fallback origin normally sees nothing. **Check on staging** (§7.6): add a Worker route for one test custom hostname with **Worker: None**, request it, and expect nginx's `421` (the handshake passed, so a client certificate was presented); a `525`/`526` means it wasn't, and per-hostname Authenticated Origin Pulls must be set up for the fallback origin. Remove the test route afterwards.

### 2.5 Cloudflare for SaaS (custom domains) — **Dan** (enable, billing), **Claude** (the rest)
From milestone-6 §17:
- **SSL/TLS → Custom Hostnames:** enable Cloudflare for SaaS (100 custom hostnames included, then $0.10 each). Set a billing notification.
- **Fallback origin:** `origin.files.gg` (§2.1), and wait for **Active**. (Milestone-6 §17 described an originless `fallback.files.gg AAAA 100::`; milestone-7 §2.2 uses `origin.files.gg` on the server, which nginx answers with `421` for any custom hostname. Either works while the Worker's `*/*` route is in place; this runbook follows milestone-7.)
- **API token** for the API: **My Profile → API Tokens → Create Token → Custom:** Zone · SSL and Certificates · Edit, on the zone `files.gg` only. Its value goes into `CLOUDFLARE_API_TOKEN`; the zone id (zone **Overview**, right column) into `CLOUDFLARE_ZONE_ID`.
- **Check:** `curl -s -H "Authorization: Bearer <token>" https://api.cloudflare.com/client/v4/user/tokens/verify` says `active`; the custom hostnames page shows the fallback origin **Active**. The end-to-end check (a real subdomain, DCV, Check now, deletion) is in §7.6.

### 2.6 Other zone settings — **Claude**
These change HTML or block API clients, so they're off:
- **Speed → Optimization:** Rocket Loader **off** (it rewrites scripts, which the CSP refuses).
- **Scrape Shield:** Email Address Obfuscation **off** (it injects a script the CSP refuses); Hotlink Protection **off** (it breaks embeds of `cdn.files.gg`).
- **Security → Bots:** Bot Fight Mode **off** (it challenges ShareX and curl on `api.files.gg`, which can't solve it; the API has its own rate limits).
- **Caching → Configuration:** Browser Cache TTL **Respect Existing Headers** (the Worker sets every `Cache-Control`).
- **Check:** after launch, `node ops/smoke.mjs https://files.gg` passes its header checks, and an upload with an upload key from curl works (§8.5).

### 2.7 Turnstile — **Dan**
- **Turnstile → Add widget:** name "files.gg", hostnames `files.gg` (plus `staging.files.gg` for §7; custom domains need nothing, milestone-6 §10.10), mode **Managed**.
- Site key → `VITE_TURNSTILE_SITE_KEY` (the web build); secret key → `TURNSTILE_SECRET`; `TURNSTILE_HOSTNAMES=files.gg`.
- **Check:** an anonymous upload on staging passes the challenge, and `api` logs no Turnstile failure.

### 2.8 CSAM Scanning Tool — **Dan**
- **Caching → Configuration → CSAM Scanning Tool:** enable, with a monitored notification address (the `abuse@` route below). Cloudflare verifies the address first.
- **Check:** the page shows the tool **Enabled** with the address.

### 2.9 Email Routing — **Dan**
- **Email → Email Routing:** enable (Cloudflare adds its MX and SPF records on `files.gg`), verify the destination mailbox, then add routes for **`abuse@`**, **`support@`**, **`dmca@`**, **`privacy@`** and **`security@`** (`security.txt` lists `security@` and `abuse@`) to the staffed mailbox.
- Sending is from `mail.files.gg` (§4.4), so Email Routing's records on `files.gg` don't conflict with Postmark's.
- **Check:** a mail from an outside account to each address arrives; `dig MX files.gg` shows Cloudflare's servers.

---

## 3. Backblaze B2 (US)

**Dan** creates the account (US region), adds billing, and creates the buckets and keys below in the B2 web UI (or gives Claude a master key for the `b2` CLI for this hour, then deletes it). Write down the region's S3 endpoint (for example `https://s3.us-west-004.backblazeb2.com`, region `us-west-004`): it's `S3_ENDPOINT` and `S3_REGION` in `.env` **and** in `cf-worker/wrangler.toml` `[vars]`.

### 3.1 The files bucket — **Dan**
- **Buckets → Create a Bucket:** `filesgg-files` (any free name; it's `S3_BUCKET_FILES`), **Private**, Default Encryption **Enable** (SSE-B2), Object Lock **Disable**.
- **Lifecycle Settings: Keep only the last version of the file.** Deletes, including a CSAM removal, must really remove the bytes (milestone-4 §15).
- No CORS rules: browsers never talk to B2; the Worker reads it with SigV4.
- **Check:** the bucket page shows Private, the lifecycle rule, and encryption on.

### 3.2 The evidence bucket — **Dan**
- **Create a Bucket:** `filesgg-evidence` (`S3_BUCKET_EVIDENCE`), **Private**, Default Encryption **Enable**, **Object Lock: Enable** (at creation). No default retention: the API sets **compliance**-mode retention on every object it preserves, `EVIDENCE_RETENTION_DAYS` (365) ahead.
- Lifecycle: keep all versions (B2's default). Never add a rule that deletes from this bucket.
- **Check:** the bucket page shows Object Lock enabled. The end-to-end check is the NCMEC test in §5.1: after it, `aws s3api head-object --endpoint-url $S3_ENDPOINT --bucket filesgg-evidence --key <key from the case>` (with a key that may read it, from Dan's machine) shows `ObjectLockMode: COMPLIANCE` and the retain-until date.

### 3.3 Application keys — **Dan**
**App Keys → Add a New Application Key**, one per use. Each secret is shown once; it goes straight into `.env` or `wrangler secret put`.

| Key name | Access | Goes into |
|---|---|---|
| `filesgg-api` | bucket `filesgg-files` only, **Read and Write** | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `filesgg-worker` | bucket `filesgg-files` only, **Read Only** | `S3_READ_ACCESS_KEY_ID`, `S3_READ_SECRET_ACCESS_KEY` (Worker secrets) |
| `filesgg-evidence` | write and copy into `filesgg-evidence`, **no read or delete there**, plus read on `filesgg-files` (the preservation step is a server-side copy from it) | `S3_EVIDENCE_ACCESS_KEY_ID`, `S3_EVIDENCE_SECRET_ACCESS_KEY` |
| `filesgg-backup` | bucket `filesgg-db-backup` only, **Read and Write** | `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY` |

- **Unverified: the evidence key.** The web UI's keys are one bucket (or all buckets) with a preset access level, which can't express "write-only here, read there". Create it with the `b2` CLI's custom capabilities, and check what B2 accepts: `b2 key create --bucket filesgg-evidence filesgg-evidence writeFiles,listBuckets` lacks the read on the files bucket; an all-buckets key with `readFiles` could read evidence too. **Check** with the key itself: `copy-object` from `filesgg-files/<test object>` into `filesgg-evidence` succeeds; `get-object` and `delete-object` on `filesgg-evidence` fail with `AccessDenied`. If B2 can't express it, the fallback (deciding it is **Dan**'s) is a key with `readFiles` on the files bucket for the copy source and `writeFiles` only on evidence through B2's multi-bucket keys if available; otherwise accept an all-buckets `readFiles,writeFiles,listBuckets` key without `deleteFiles` (Object Lock still stops deletion) and record that the evidence key can read evidence.
- **Check** (Claude, after §7.1): the scanner and rescanner start (they refuse to without the evidence key); the Worker serves a test file from `cdn-staging.files.gg`; `dc exec backup-db restic snapshots` works.

### 3.4 The backup bucket and the restic repository — **Dan** (bucket), **Claude** (repository)
- **Create a Bucket:** `filesgg-db-backup` (`S3_BUCKET_DB_BACKUP`), Private, encryption on, Object Lock off, lifecycle **Keep only the last version** (restic's prune must free space, [`backup/README.md`](../../backup/README.md)).
- Claude generates `DB_BACKUP_RESTIC_PASSWORD` (`openssl rand -hex 32`); **Dan** stores a copy in his password manager. Without it the backups can't be read by anyone.
- After the stack is up (§7.1), Claude runs the first backup, which creates the repository: `dc exec backup-db backup all`.
- **Check:** `dc exec backup-db restic snapshots` lists `postgres` and `postgres-roles` snapshots; healthchecks.io (§4.6) shows a ping.

---

## 4. Vendors

### 4.1 Budget alerts — **Dan**
- B2 (Caps & Alerts: daily storage, download and transaction caps with alerts), Google Cloud (a budget on the Web Risk project), Cloudflare (billing notifications for custom hostnames), Postmark (usage alert).
- **Check:** each console shows the alert.

### 4.2 PhotoDNA — **Dan** (application), **Claude** (configuration)
- Apply for **PhotoDNA Cloud Service** at `https://myphotodna.microsoftmoderator.com/Profile` (third-party vetting; free for qualified organisations). **This gates launch:** production refuses the stand-in matcher, so without PhotoDNA no upload can publish.
- When approved, record in milestone-4 §3.2 what Microsoft confirms (endpoint, header, fields, status codes, image limits, monthly allowance, rate limit, test images) and ask how the 30-day term renews.
- `.env`: `CSAM_MATCHER=photodna`, `PHOTODNA_SUBSCRIPTION_KEY`, `PHOTODNA_MATCH_URL`; `PHOTODNA_MAX_RPS` and `PHOTODNA_TIMEOUT` from Microsoft's limits.
- **Check:** the scanner starts (`dc logs scanner` has no "Refusing to start"), and a scan of an ordinary image on staging records `checks.csam.matcher: photodna` (admin lookup of the file).

### 4.3 Google Web Risk — **Dan** (project, billing), **Claude** (check)
- Google Cloud console: a project "filesgg", a billing account, **enable the Web Risk API**, then **APIs & Services → Credentials → Create credentials → API key**, restricted to the Web Risk API and to the server's IP addresses. → `WEB_RISK_API_KEY`.
- Pricing (checked 2026-11-25): `uris.search` free for 100,000 calls a month, then $0.50 per 1,000. **Never call `threatLists.computeDiff` from this project** (it reprices `uris.search` at $50 per 1,000). Set a budget alert (§4.1).
- **Check** (Claude), with Google's own test page: `curl -s "https://webrisk.googleapis.com/v1/uris:search?threatTypes=MALWARE&uri=http%3A%2F%2Ftestsafebrowsing.appspot.com%2Fs%2Fmalware.html&key=$WEB_RISK_API_KEY"` from the server answers with a `threat`; a text file containing that URL on staging gets the link warning, and its **Learn more** links open `https://staging.files.gg/help/link-warnings#malware`.

### 4.4 Postmark — **Dan** (account, approval), **Claude** (DNS, tests)
- Create the account and a **Server** "files.gg" (transactional message stream `outbound`). New accounts send only to their own domain until Postmark **approves** the account: request approval early.
- **Sender Signatures → Add Domain:** `mail.files.gg`. Postmark then shows the exact records to add in Cloudflare DNS, **DNS only** (grey cloud):
  - **DKIM:** a `TXT` record at `<selector>pm._domainkey.mail.files.gg` with the key Postmark shows;
  - **Return-Path:** `CNAME` `pm-bounces.mail.files.gg` → `pm.mtasv.net` (this is what makes SPF align; no SPF `include` is needed on `mail.files.gg`);
  - **DMARC:** `TXT` at `_dmarc.mail.files.gg`: `v=DMARC1; p=none; rua=mailto:dmarc@files.gg` to start (tighten to `quarantine` after a few clean weeks). Add `dmarc@` to Email Routing (§2.9) to receive the reports.
- Server → **API Tokens** → `POSTMARK_SERVER_TOKEN`. `EMAIL_FROM` stays `files.gg <noreply@mail.files.gg>`. Open and link tracking stay off (the emails carry one-time links).
- **Check:** Postmark's domain page shows DKIM and Return-Path **Verified**; on staging, sign up, verify, forgot-password and each milestone-6 §2.7 template reach Gmail, Outlook and iCloud inboxes (not spam), and Gmail's "Show original" says `DKIM: PASS`, `SPF: PASS`, `DMARC: PASS`.

### 4.5 Discord application — **Dan**
From milestone-6 §17:
- **Discord Developer Portal → New Application** "files.gg", with the logo (`branding/png/filesgg-mark-512.png`) and the Terms and Privacy URLs (`https://files.gg/legal/terms`, `https://files.gg/legal/privacy`).
- **OAuth2 → Redirects:** `https://files.gg/app/auth/discord`, and for the staging run `https://staging.files.gg/app/auth/discord`. They must match `DISCORD_REDIRECT_URI` exactly (no trailing slash; Discord's matching rules aren't documented).
- Public Client **off** (a confidential client). No bot user, no bot permissions.
- Client id → `DISCORD_CLIENT_ID`; client secret → `DISCORD_CLIENT_SECRET`; `DISCORD_REDIRECT_URI=https://files.gg/app/auth/discord` (the staging `.env` uses the staging one).
- **Check** on staging: sign up, sign in, link, unlink and re-auth with Discord, including an account with an unverified email and one with no email (milestone-6 §17).

### 4.6 healthchecks.io — **Dan**
- A check "filesgg db backup": period **1 day**, grace **2 hours** (so a missed 02:00 backup alerts at about 26 hours, contract §4.3), with email and the Discord integration. Its ping URL → `DB_BACKUP_HEALTHCHECK_URL`.
- **Check:** after the first backup (§3.4) the check is green with a recent ping.

### 4.7 The alerts channel — **Dan**
- In the files.gg Discord server, a private channel `#alerts`: **Edit Channel → Integrations → Webhooks → New Webhook** → copy the URL into `GRAFANA_ALERT_DISCORD_WEBHOOK`.
- **Check** (Claude): Grafana's **Alerting → Contact points → Test** on the Discord contact point posts in `#alerts` ([`monitoring/README.md`](../../monitoring/README.md)).

---

## 5. Legal and policy

None of this is code, and none of it is legal advice. Items marked "lawyer" need one.

### 5.1 NCMEC — **Dan**
- **Register with NCMEC as an electronic service provider** for CyberTipline reporting; learn what a report includes and the timelines. Name the child-safety lead (who holds the evidence private key, §5.3).
- Test the path **end to end with the vendor's test images, never real material:** match → block → evidence copy (Object Lock, §3.2) → P0 case → report filed outside files.gg → recorded with `POST /admin/cases/<id>/cybertip`.
- **Check:** NCMEC's confirmation; the test case in the admin queue shows the evidence hold and the recorded report id.

### 5.2 DMCA designated agent — **Dan**
- Register at the US Copyright Office's DMCA Designated Agent Directory: **$6** until 2027-01-04, **$25 from 2027-01-05**. A designation expires **three years** after registration unless amended or resubmitted: set a renewal reminder.
- The agent's details replace `[DMCA AGENT]` in the Terms.
- **Check:** the directory lists files.gg with the agent.

### 5.3 The evidence key pair — **Dan** (the child-safety lead), offline
- On Dan's own machine, not the server:
  ```sh
  python3 -m venv /tmp/nacl && /tmp/nacl/bin/pip install PyNaCl==1.6.2
  /tmp/nacl/bin/python -c "from nacl.public import PrivateKey; import base64; k = PrivateKey.generate(); print('EVIDENCE_PUBLIC_KEY=' + base64.b64encode(bytes(k.public_key)).decode()); print('private (keep offline):', base64.b64encode(bytes(k)).decode())"
  ```
- The private key goes into the password manager **and** a documented offline backup; it never touches a server, chat or a commit. The public key goes into `.env` as `EVIDENCE_PUBLIC_KEY`.
- **Check:** the API starts (it refuses a malformed key); a staging upload's `files.uploader_ip_sealed` is set, and only the private key opens it.

### 5.4 Terms and Privacy placeholders — **Dan**, with a lawyer
The production build refuses to ship while any placeholder remains (milestone-5 §19.6). Every one, by file:

| Placeholder | File | Decision |
|---|---|---|
| `[OPERATOR]`, `[OPERATOR ADDRESS]` | both | Who runs files.gg (a person or a company) and its address |
| `[CONTACT EMAIL]` | Terms | Probably `support@files.gg` (§2.9) |
| `[DMCA AGENT]` | Terms | From §5.2 |
| `[GOVERNING LAW]` | Terms | Lawyer |
| `[LIABILITY CAP]` | Terms | Lawyer |
| `[NOTICE PERIOD]` | both | How long before a significant change takes effect (for example 30 days) |
| `[PRIVACY CONTACT]` | Privacy | Probably `privacy@files.gg` (§2.9) |
| `[CONVERSION HISTORY RETENTION]` | Privacy | How long conversion records are kept (no code deletes them today: decide, and Claude adds the cleanup) |
| `[LOG RETENTION]` | Privacy | Docker keeps 5 × 50 MB of logs per service (§1.2), so roughly days to weeks depending on traffic; Prometheus keeps 15 days of metrics |
| `[SERVER LOCATION]` | Privacy | From §1.1 |
| `[TRANSFER SAFEGUARDS]` | Privacy | Lawyer (Standard Contractual Clauses, the vendors' DPAs) |
| `[EU/UK REPRESENTATIVE, if needed]` | Privacy | Lawyer: GDPR Art. 27 and UK GDPR, if files.gg has no establishment there |

- **Check:** `cd web && npm run build` (without `FILESGG_ALLOW_LEGAL_PLACEHOLDERS`) succeeds; `/legal/terms` and `/legal/privacy` show no "Draft: pending legal review" banner.

### 5.5 The other legal questions — **Dan**, with a lawyer
From PLAN.md §4 item 8, milestone-4 §15, milestone-5 §19 and milestone-6 §17:
1. **UK and EU duties** (the Online Safety Act, the Digital Services Act): what applies at files.gg's size (risk assessments, a point of contact, notice-and-action, transparency).
2. **Age verification:** whether hosting marked adult content requires it anywhere files.gg has users (UK OSA, US state laws). Today: 18+ is a statement, not a check.
3. **The evidence preservation period** (`EVIDENCE_RETENTION_DAYS`, 365) and keeping **sealed uploader IPs** for 30 days (`ABUSE_IP_KEEP_DAYS`).
4. **What a CyberTipline report includes**, and who files it.
5. **The DMCA good-faith and perjury statements** in the report and appeal forms (PLAN.md Milestone 4 follow-ups).
6. **The public report copy:** no time-bound promises ("We review every report. Child-safety reports are prioritised.").
7. **Erasure requests from suspended accounts**, and law-enforcement holds against deletion (milestone-6 §17).
8. **The minimum age** (13, and 18 for adult content) and the EU countries where consent needs an older age.
9. **The security policy page.** `security.txt` says `Policy: https://files.gg/legal/security`, and that page doesn't exist (the Worker answers `/legal/security` with the missing page). Either write it (Claude can draft it: scope, how to report, safe harbour, what's out of scope) or drop the `Policy:` line. **Claude** does whichever Dan picks before launch.
- **Check:** each has a written answer in this file (append them under "Decisions" below) or a change in the Terms or Privacy Policy.

### 5.6 Dates — **Claude**, on launch day
- `CHANGELOG.md`: the first entry's date (`## 2026-11-25: The new files.gg`) becomes the launch date (its anchor is the date).
- `web/public/.well-known/security.txt`: `Expires` becomes the launch date plus one year. **Dan:** a yearly reminder to renew it (and the DMCA designation's three years, §5.2).
- The Terms' and Privacy Policy's `updated:` front matter: the date their final text was approved.
- **Check:** `https://files.gg/changelog` shows the launch date; `curl -s https://files.gg/.well-known/security.txt` shows the new `Expires`.

---

## 6. Search Console and `security.txt` — **Dan** (verification), **Claude** (check)

- **Google Search Console → Add property → Domain** `files.gg` (covers every subdomain), verified with the DNS TXT record (Cloudflare's one-click integration, or add the record by hand, DNS only).
- **Settings → Users and permissions:** add the staffed mailbox, so Safe Browsing "Security issues" emails reach someone. Subscribe to Cloudflare's abuse notifications to the same mailbox.
- `security.txt` contacts (`security@`, `abuse@`) are live once §2.9 is done; its `Policy:` line follows §5.5 item 9.
- **Check:** Search Console shows the property verified and **Security issues: No issues detected**; mail to `security@files.gg` arrives.

---

## 7. The staging run (contract §5)

The production server, under staging hostnames, with a **throwaway B2 bucket** (`filesgg-staging`, same settings as §3.1, its own Read-and-Write key), before DNS for `files.gg` changes. Everything here is **Claude**, except where it says Dan.

### 7.1 Bring it up
- A staging `.env` (`ENV_FILE=.env.staging`): `PUBLIC_URL=https://staging.files.gg`, `CDN_URL=https://cdn-staging.files.gg`, `API_PUBLIC_URL=https://api-staging.files.gg`, `S3_BUCKET_FILES=filesgg-staging` and its key, `DISCORD_REDIRECT_URI=https://staging.files.gg/app/auth/discord`, `TURNSTILE_HOSTNAMES=staging.files.gg`, and raise `upload_key` in `RATE_LIMITS` for the load test. Everything else as production.
- Also in `.env.staging`: `NGINX_EXTRA_API_HOSTS=api-staging.files.gg` (nginx answers it besides `api.files.gg` and `origin.files.gg`; `ops/check-env.sh` refuses it with a production `PUBLIC_URL`) and `WORKER_ENV=staging` (`ops/deploy.sh` then deploys `wrangler.toml`'s `[env.staging]`).
- The staging Worker is `wrangler.toml`'s `[env.staging]`: `files-gg-staging`, the three staging hostnames, routes on those only (no `*/*`: the old Worker keeps serving everything else). The deploy passes `S3_ENDPOINT`, `S3_REGION` and the staging `S3_BUCKET_FILES` from `.env.staging` with `--var`. It needs its own secrets (`wrangler secret put … --env staging`).
- `ENV_FILE=.env.staging ops/check-env.sh`, then `ENV_FILE=.env.staging ops/deploy.sh` ([`ops/README.md`](../../ops/README.md)).
- **Check:** `ops/deploy.sh --status` shows every service up and healthy, and the post-deploy `smoke.mjs --quick` passed; `https://staging.files.gg/` shows the home page.

### 7.2 The first staff account (staging)
- **Dan:** register at `https://staging.files.gg/app/register` (or with Discord), verify the email.
- **Claude:** `dc exec postgres psql -U filesgg -d filesgg -c "SELECT id, username FROM users ORDER BY id"`, then `dc exec api python -m tools.staff grant <id> --role admin --child-safety --by claude`. (`tools.create_user` is dev-only and refused here.)
- **Check:** `dc exec api python -m tools.staff list` shows the grant; `/app/admin` opens for Dan.

### 7.3 Smoke and security checks
- `node ops/smoke.mjs https://staging.files.gg --uploads --session <Dan's staff session cookie value>`: the pages and their headers, the hostile uploads (HTML, SVG, PDF with `/JavaScript`, polyglot, renamed `.exe`, archive with an `.exe`, encrypted archive, macro `.docx`, bidi filename), the `__Host-` cookie check, `/internal/*` through every host, and the body-limit pair. It deletes what it uploaded.
- Also run `https://securityheaders.com/?q=https://cdn-staging.files.gg/files/<a test file>` and `?q=https://staging.files.gg/`.
- **Check:** smoke exits 0; securityheaders.com grades A or better.

### 7.4 Load test
- With two API containers up on purpose (the deploy's rollover state, [`ops/README.md`](../../ops/README.md)) and three `worker` replicas: `node ops/loadtest.mjs --main https://staging.files.gg --api http://<api container 1>:8080 --api http://<api container 2>:8080 --session <session> --concurrency 6 --duration 300 --report loadtest-report.json`.
- This also answers contract §10's open question: Sanic with two containers sharing nginx's upstream under load.
- **Check:** exit 0: every upload completed with the right hashes, each scheduled task ran once per period, the error count is 0; keep the report's p95 throughput as the baseline.

### 7.5 The Cloudflare body limit (unverified until now)
- `smoke.mjs --uploads` sends exactly **100,000,000 bytes** through `api-staging.files.gg` (must succeed) and one byte more (must be `413`).
- **Unverified:** whether Cloudflare's "100 MB" is 10⁸ bytes or 100 MiB. If the 100,000,000-byte upload gets Cloudflare's own `413` (an HTML page from Cloudflare, not the API's JSON), the limit is 10⁸ bytes: set `PROXY_BODY_LIMIT_BYTES=100000000` and nginx's `client_max_body_size` to match (`ops/check-env.sh` refuses them disagreeing), and the single-request cap becomes 98.95 MB. Otherwise keep the default `104857600`. Record the result here.
- **Check:** the body-limit pair passes with the chosen value.

### 7.6 The rest of the staging checks
- Custom domains (milestone-6 §17), with a domain Dan controls: add `i.<domain>` from Settings → Domains on a premium account (`dc exec api python -m tools.entitlements grant <id> --kind premium --by claude --note staging`), point its CNAME at `domains.files.gg`, and confirm real-time validation, HTTP DCV issuing the certificate with the Worker on `*/*`, **Check now**, a file served on it, and deletion. The staging Worker has no `*/*` route, so this runs against the production Worker's `*/*` after §8.2, or with a temporary `*/*` route on the staging Worker during a quiet moment.
- Authenticated Origin Pulls on the fallback origin (§2.4).
- Turnstile inside the custom domain's challenge frame (a cross-origin iframe; milestone-6 §18 item 8).
- Discord PKCE with a confidential client, `prompt=none`, and the redirect matching (milestone-6 §18 items 1–3).
- A 5 GB chunked upload on a premium account: finalize's multipart copy on B2 (`UploadPartCopy`), scanning (`too_large_to_scan`), probing, serving with `Range` (milestone-6 §17).
- Email to Gmail, Outlook and iCloud (§4.4); the session cookie only on `staging.files.gg` (milestone-6 §17).
- **Check:** each one passes, or its fix is in.

### 7.7 Restore drill
- `ops/restore-drill.sh`: restores the newest restic snapshot into a throwaway Postgres container and checks the main tables' row counts and the migration history.
- **Check:** it reports OK. Then monthly (§9.2).

### 7.8 Tear down staging
- Stop the staging stack, delete the staging Worker and its routes, the staging DNS records, the `filesgg-staging` bucket and its key, the staging hostnames from Turnstile and the Discord redirects, `.env.staging` (with its `NGINX_EXTRA_API_HOSTS`), and the staging rate-limit override. **Delete the staging database** (production starts empty).
- **Check:** `dig staging.files.gg` answers nothing; the B2 bucket is gone; `dc ps` (production project) shows nothing running yet.

---

## 8. Launch

In one sitting, Dan and Claude together, at a quiet hour.

### 8.1 Final gates — **Dan** confirms
- PhotoDNA live (§4.2), NCMEC registered and tested (§5.1), DMCA agent registered (§5.2), no legal placeholders (§5.4), §5.5 answered, every §7 check passed.

### 8.2 Production stack and Worker — **Claude**
- `ops/check-env.sh`, then `ops/deploy.sh` with the production `.env`: the stack, `migrate` (a fresh database), the API, the workers, nginx, monitoring and backups, then `npm run build:web` and `wrangler deploy` of the production Worker.
- Before the Worker's first deploy: `npx wrangler secret put` for `ORIGIN_SHARED_SECRET` and `CDN_SIGNING_SECRET` (the same values as `.env`), `S3_READ_ACCESS_KEY_ID`, `S3_READ_SECRET_ACCESS_KEY`. `S3_ENDPOINT`, `S3_REGION` and `S3_BUCKET_FILES` are `[vars]` in `wrangler.toml`, which every `wrangler deploy` re-applies: they must hold the production values there (or be passed with `--var` by the deploy), or the CDN answers 503 for every file.
- **Check:** `ops/deploy.sh --status`; `curl -s https://api.files.gg/health` (through Cloudflare once DNS is switched below).

### 8.3 Retire the old site — **Dan** (dashboard), **Claude** (checks)
From PLAN.md "Before the first deploy" and contract §6:
- **Workers & Pages:** delete the **old unnamed zone-level Worker** and **its routes** (Workers Routes on the zone). The new `files-gg` Worker's routes are `files.gg/*`, `cdn.files.gg/*`, `api.files.gg/*` and `*/*` (which also covers `www.files.gg`).
- With it go its secrets and variables: **`PROXY_SECRET`**, **`CORS_ALLOWED_ORIGINS`**, `CDN_TOKEN_SECRET`, `STORAGE_GCS_FALLBACK`, `STORAGE_ORIGIN`. If any is set on the `files-gg` Worker, `npx wrangler secret delete <NAME>` (secrets) or remove it under **Settings → Variables** (vars).
- **DNS:** delete **`proxy.files.gg`**, and replace the old origin's `files.gg`, `cdn` and `api` records with §2.1's.
- The old server, its database and the old Google Cloud Storage bucket: nothing is migrated (decision 2026-11-25). **Dan** decides when to shut the server down and delete the old data (a privacy decision as much as a cost one); delete the old GCS service account and its keys in Google Cloud IAM, and the old reCAPTCHA and Mailgun accounts, at the same time.
- Old links get the plain missing page (decision 3): nothing to configure.
- **Check:** `curl -s https://files.gg/ | grep -o '<title>[^<]*'` shows `files.gg: share any file with a link`; `curl -sI https://proxy.files.gg/` fails to resolve; **Workers Routes** lists only the new Worker's four routes; an old link (`https://files.gg/<an old vanity>`) shows the missing page with a `404`.

### 8.4 Full smoke check — **Claude**
- `node ops/smoke.mjs https://files.gg --uploads --session <staff session>`, including the body-limit pair with the value from §7.5.
- **Check:** exit 0.

### 8.5 The first staff account — **Dan**, then **Claude**
- **Dan:** register at `https://files.gg/app/register`, verify the email, link Discord if wanted.
- **Claude:** look up the id (`dc exec postgres psql -U filesgg -d filesgg -c "SELECT id, username FROM users ORDER BY id"`), then `dc exec api python -m tools.staff grant <id> --role admin --child-safety --by claude`. Further moderators: `--role moderator` (with `--child-safety` only for those who handle child-safety cases).
- **Check:** `dc exec api python -m tools.staff list`; `/app/admin` opens; an upload with a new upload key from curl (`curl -F file=@x.png -H "Authorization: Key fgg_…" https://api.files.gg/files`) works.

### 8.6 After launch — **Claude**
- Revoke the temporary Cloudflare API token (§2) and B2 master key (§3) if any were used.
- Mark PLAN.md Phase 5 done, and update `CHANGELOG.md`'s date (§5.6) if launch moved.
- **Check:** Cloudflare's API tokens page shows only `CLOUDFLARE_API_TOKEN`'s token.

---

## 9. The first week, and after

### 9.1 Every day of the first week — **Dan** and **Claude**
- **Grafana `files.gg` dashboard** (through the tunnel): 5xx rate and p95 latency per route, uploads and refusals by code, scans by state and reason and their duration, the pending-scan count and oldest age, conversion queues, rate-limit refusals by scope, the host, containers, Postgres and Redis.
- **`#alerts`:** every alert has a line in §10; note each one that fired and what was done.
- **The admin queue** (`/app/admin`): P0 first (child safety, NCII), then P1 (malware, Web Risk flags, `scan_failing` holds); the NSFW review requests (to judge `NSFW_THRESHOLD`).
- **Scans:** nothing pending for more than a minute or two; `scan_failing` holds retried or explained.
- **Conversions:** oldest job per queue; `failure_reason` counts (`killed_SIGKILL` means a pool needs more memory or fewer processes, milestone-5 §16).
- **Vendors:** B2 (storage, downloads, Class B and C transactions), Web Risk calls against the 100,000 free, PhotoDNA against its allowance, Postmark bounces and spam complaints, Cloudflare (Worker errors and CPU time under **Workers & Pages → files-gg → Metrics**, 413s and 5xx in Analytics, custom hostnames against the 100 included).
- **Backups:** healthchecks.io green; `dc exec backup-db restic snapshots` grows daily.
- **Watch for** the one unexplained 503 after a fresh start (PLAN.md Milestone 3 checks) and any first-unlock failures.
- **Rate limits:** 429s by scope; loosen `RATE_LIMITS` if real users hit them.

### 9.2 Afterwards — **Claude** (scheduled), **Dan** (decisions)
- Monthly: `ops/restore-drill.sh`; `docker image prune` of old images; minor version and digest bumps (PLAN.md version policy).
- Re-pick `NSFW_THRESHOLD` from the first weeks' appeals and the labelled-set measurement (milestone-4 §15).
- After the first month with no HTTP-only need anywhere under `files.gg`: **Dan** submits `files.gg` at hstspreload.org (the header already qualifies; `ops/smoke.mjs` checks it). Getting off the list takes months, so only once every subdomain is HTTPS for good.
- Yearly: `security.txt`'s `Expires`; every three years: the DMCA designation.

---

## 10. Alert runbook

One line per alert in `monitoring/grafana/provisioning/alerting/alerts.yml` (contract §4.3), under the title the Discord message shows: what it means and what to do first. Logs: `dc logs --since 30m <service>`; state: `dc ps`, `ops/deploy.sh --status`.

| Alert | What it means | What to do |
|---|---|---|
| **API 5xx above 2%** | Over 2% of requests answered 5xx for 5 minutes | Find the route on the dashboard, then `dc logs --since 15m api`. Right after a deploy: roll back with `ops/deploy.sh --ref <previous commit>` (`--status` shows it). Otherwise check Postgres, Redis and B2 (the alerts below), and the API's Postgres pool panel. |
| **Page routes slow (p95 above 1 s)** | Pages are slow (for 10 minutes) | Check the host CPU and the converters (a conversion burst starving the API means lowering a pool's `CONVERTER_*_PROCESSES`), the Postgres pool's waiting count, slow queries (`SELECT pid, now() - query_start, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY 2 DESC`), and Redis latency. |
| **files.gg metrics not scraped** | Prometheus can't read part or all of `/internal/metrics`, so **every other files.gg alert is blind** until it's fixed | `dc ps api prometheus`; Grafana → Explore: `up{job="filesgg"}` and `filesgg_metrics_collector_up` (a `0` names the failing collector: Redis, Postgres or the queues). A 404 on the scrape means Prometheus isn't sending the origin secret: check the `origin_shared_secret` compose secret against `.env` and `dc up -d prometheus`. |
| **Scans pending over 10 minutes** | New uploads can't publish | `dc ps scanner clamav`; `dc logs --since 15m scanner`. Common causes: ClamAV down or reloading signatures, PhotoDNA failing (next line), B2 unreachable. Restart with `dc restart scanner` once the cause is fixed; the sweeper re-queues lost scans, and hashes that keep failing are held for staff (`scan_failing`, retry from the admin UI). |
| **CSAM matcher errors** | Uploads fail closed (nothing publishes) | `dc logs --since 15m scanner \| grep -i photodna`: an expired or wrong key, the monthly allowance used up, rate limiting (`PHOTODNA_MAX_RPS`), or Microsoft's outage. Fix the key or limits in `.env` and `ops/deploy.sh --no-build`; contact Microsoft for allowance or outages. Never switch the matcher off. |
| **Member conversions waiting over 10 minutes**, **Premium conversions waiting over 30 minutes** | Conversions are stuck or the pool is too small | `dc ps converter converter-premium converter-previews office`; `dc logs --since 30m converter`. `killed_SIGKILL` failures mean memory: raise `mem_limit` or lower the processes. Busy but healthy: raise `CONVERTER_PROCESSES` within the host's CPU. Anonymous jobs over 10 min are cancelled on their own. |
| **Disk above 85%** | Postgres, Docker images or scratch space are filling the disk | `df -h`, `docker system df`, `du -sh /var/lib/docker/volumes/*`. Remove old images (`docker image prune -a --filter until=168h`); look for leftover scan or convert directories; check Postgres' size. Logs are capped (§1.2). |
| **Memory above 90%** | Something will be OOM-killed | `docker stats --no-stream`: usually the converters, `office` or ClamAV. Lower that pool's processes; check for a leak (memory that only grows) and restart the service. |
| **A container keeps restarting** (more than 3 times in 10 minutes) | A crash loop | `dc ps` for the name, `dc logs --tail 200 <service>` for the last crash, `docker inspect -f '{{.State.OOMKilled}}' <container>`. A bad deploy: roll back. A missing or wrong `.env` value: `ops/check-env.sh`. |
| **Postgres down** | Nearly everything fails | `dc logs --tail 200 postgres`; disk full is the usual cause (see above). `dc up -d postgres`. If the data is damaged: stop `api`, `worker`, `scanner`, `rescanner` and restore ([`backup/README.md`](../../backup/README.md) "Restoring"). |
| **Redis down** | Rate limits: the fail-open ones let everything through; the fail-closed ones (login, register, password reset, unlock, reports) answer `503 RATE_LIMIT_UNAVAILABLE`; conversions can't queue | `dc logs --tail 200 redis`; `dc up -d redis`. Check its memory and the `redis-data` volume. |
| **Redis refusing (fail-closed limits answering 503)** | Redis is up but erroring (memory, connections, auth) | `dc exec redis redis-cli -a "$REDIS_PASSWORD" info memory` and `info clients`; a wrong `REDIS_PASSWORD` after an `.env` change means redeploying everything that uses it. |
| **ClamAV down** | Scans fail (it's a required check), so the pending-scan alert follows | `dc logs --tail 200 clamav`: usually freshclam failing to download signatures, or memory while it reloads them. `dc restart clamav` and wait for healthy (several minutes). |
| **Backup didn't report in 26 hours** (healthchecks.io's own alert) | Last night's database backup failed or didn't run | `dc logs --since 26h scheduler-ofelia`; run it by hand: `dc exec backup-db backup all`. A stale restic lock: `dc exec backup-db restic unlock`. A B2 error: the backup key or bucket (§3.4). |

---

## Decisions

Record the answers to the open items here as they're made, with the date: the body-limit result (§7.5), the evidence key's final capabilities (§3.3), Authenticated Origin Pulls on the fallback origin (§2.4), the legal answers (§5.4, §5.5), the server location (§1.1) and the launch date (§5.6).
