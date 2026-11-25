# Local full stack and end-to-end test

The whole of files.gg on your machine: the API, the jobs worker, the Milestone 4 scanner and rescanner with an offline ClamAV, Postgres, MinIO standing in for B2, a mock of Cloudflare's custom hostnames API, the Cloudflare Worker under `wrangler dev`, and a fresh `web` build. It runs on hostnames that resolve to loopback by themselves, so no `/etc/hosts` edits and no sudo.

## Commands

From the repo root:

```sh
e2e/up.sh          # start everything (first run builds the API and worker images and the web app)
node e2e/run.mjs   # the end-to-end test, against the running stack (about 2.5 minutes)
e2e/down.sh        # stop everything and delete its data (volumes, secrets, web build, logs)
```

`up.sh` is safe to run again: it rebuilds what changed and restarts the Worker. It prints the URLs, the e2e user's credentials and how to sign in at the end.

**Milestone 4 (trust & safety)** needs no setup of its own: `up.sh` generates `ABUSE_HASH_SECRET` and the evidence key pair, creates the Object Lock evidence bucket, starts the scanner and an offline clamd, and makes the `e2e` user staff. Nothing is downloaded for scanning: clamd runs on the API suite's tiny test signature database, and the CSAM matcher is the stand-in.

**Milestone 6 (accounts)** needs no setup either: `up.sh` turns on the plain-http session cookie, starts the mock Cloudflare, and generates its token and zone id (below).

**Needs:** Docker, Node 24+, `openssl`, `curl`, and **internet access**. Turnstile uses Cloudflare's documented always-pass testing keys, so the API calls Cloudflare's real `siteverify`. There's no test-only bypass in the API.

## URLs

| URL | What |
|---|---|
| http://files.localhost:8787/ | The site (viewer shell, home) |
| http://files.localhost:8787/app/upload | Upload page (dashboard) |
| http://files.localhost:8787/app | Dashboard |
| http://files.localhost:8787/&lt;vanity&gt; | A file page |
| http://cdn.files.localhost:8787/files/&lt;vanity&gt;.&lt;ext&gt; | File bytes |
| http://api.files.localhost:8787/health | The API, through the Worker (tools and upload keys; never a cookie) |
| http://files.localhost:8787/api/... | The API, same-origin, as the website calls it (the only place the session cookie goes) |
| http://files.localhost:8787/app/login | Sign in (also `/app/register`) |
| http://files.localhost:8787/app/admin | Admin pages (the `e2e` user is staff) |
| http://files.localhost:8787/app/integrations | Upload keys (ShareX `.sxcu`, curl) |
| http://files.localhost:8787/app/settings/domains | Custom domains (premium) |
| http://files.localhost:8787/report/&lt;vanity&gt; | The report page for a file (`/report/a/<vanity>` for an album) |
| http://files.localhost:8787/a/&lt;vanity&gt;?item=&lt;n&gt; | An album, opened at an item |
| http://&lt;name&gt;.example.localhost:8787/&lt;vanity&gt; | A custom domain you added (any other `*.localhost` host is "isn't connected") |
| http://files.localhost:8787/.well-known/security.txt | `security.txt` (also on `cdn.files.localhost`) |

`*.localhost` resolves to `127.0.0.1` and `::1` in Chromium, Firefox and curl, and on macOS for Node too. `run.mjs` checks this first.

**Signing in** (milestone-6 §3, §4): the website's session is an **HttpOnly cookie**, `filesgg_session` locally (no `Secure` over plain http: the API has `SESSION_COOKIE_INSECURE=1` with `FILESGG_DEV_TOOLS=1`, and the Worker's `SESSION_COOKIE_NAME` matches). The Worker forwards it only on `files.localhost/api/*`, so the dashboard and the viewer call the API there, same-origin; `api.files.localhost` never sees it. JavaScript can't set an HttpOnly cookie, so either:
- open http://files.localhost:8787/app/login and sign in with the email and password `up.sh` prints (Turnstile uses Cloudflare's always-pass testing key), or
- add the cookie by hand in devtools (Application → Cookies → `http://files.localhost:8787`): name `filesgg_session`, the `session.value` from `e2e/.local/e2e-user.json` (also printed by `up.sh`), path `/`, HttpOnly.

Every cookie-authenticated write (and every `/auth/*` `POST`) needs `X-Filesgg-Csrf: 1`, a same-origin `Origin` when one is sent, and `Sec-Fetch-Site: same-origin` when that is sent; the web app sends them. `Authorization: Bearer` is never a session. The credentials are kept in `e2e/.local/.env` (`E2E_USER_PASSWORD`) and `e2e/.local/e2e-user.json`.

**Staff:** `e2e` is staff, an `admin` with the `child_safety` capability (milestone-4 §9.1), granted by `up.sh` after the migrations with the production CLI:

```sh
docker compose -p filesgg-e2e exec api python -m tools.staff grant <user_id> --role admin --child-safety --by e2e/up.sh
```

`up.sh` also creates two users who aren't staff, `e2e.member` and `e2e.reporter` (usernames are `[a-z0-9_.]` since Milestone 6; passwords `E2E_MEMBER_PASSWORD` and `E2E_REPORTER_PASSWORD` in `.env`, sessions in `e2e-member.json` and `e2e-reporter.json`). `run.mjs` uses them as a file owner and a reporter, and to check that non-staff get 404 from `/admin/*`. The three are made 8 days old with psql, so they can add a custom domain once premium (`DOMAIN_MIN_ACCOUNT_AGE_DAYS` is 7).

To make another user, run the dev tool in the API container. It refuses to run without `FILESGG_DEV_TOOLS=1`, makes a verified account (running it again for the same email resets the password) and prints `{id, username, email, session: {name, value, max_age}}`, a new web session for the cookie:

```sh
docker compose -p filesgg-e2e exec -e FILESGG_DEV_TOOLS=1 api \
  python -m tools.create_user --username alice --password 'something-long' [--premium]
```

**Premium** (milestone-6 §9) is granted by an admin at `/app/admin/users/<id>` (`POST /admin/users/<id>/entitlements`), or with the production CLI:

```sh
docker compose -p filesgg-e2e exec api python -m tools.entitlements grant <user_id> --by you --note local [--days 30]
docker compose -p filesgg-e2e exec api python -m tools.entitlements revoke <user_id> --by you --note local
docker compose -p filesgg-e2e exec api python -m tools.entitlements list
```

**Custom domains** (milestone-6 §10): as a premium user at least 7 days old, add a hostname under `example.localhost` (for example `files.example.localhost`) in Settings → Domains and press **Check now**. The API talks to the mock Cloudflare (below) and `DOMAIN_DNS_STUB=1` treats the CNAME and TXT records as present, so one check makes it `active`. `*.localhost` reaches the same `wrangler dev`, which sends every host it doesn't know to the custom-host router, so `http://files.example.localhost:8787/<vanity>` serves your files (signed URLs are rehosted onto it). Discord is off locally (`DISCORD_*` unset): `GET /auth/config` says `{ "discord": false }` and the Discord endpoints answer `503 DISCORD_UNAVAILABLE`.

**Upload keys** (milestone-6 §7): create one in Integrations; tools send `Authorization: Key fgg_…` to `http://api.files.localhost:8787/files` (the `.sxcu`'s `RequestURL` is `API_PUBLIC_URL`). Without a key or a Turnstile token, an upload is `401 UPLOAD_KEY_REQUIRED`.

## How it's put together

| Part | Where it runs | Notes |
|---|---|---|
| Postgres 19, MinIO, bucket creation, `python -m migrate`, the API (`sanic`, 2 workers), `python -m worker` (`default,media`) | Docker, `docker-compose.e2e.yml` (project `filesgg-e2e`) | Data in named volumes only. The API is published on `127.0.0.1:18080` and MinIO on `127.0.0.1:19000`, both for the Worker. The jobs worker also runs Milestone 6's `domain_checker`, `domain_delete`, `account_deletion` and the other account tasks. |
| `cloudflare` (mock) | Docker, the API image running `e2e/scripts/mock_cloudflare.py` (standard library only, bind-mounted read-only) | Stands in for Cloudflare's custom hostnames API at `CLOUDFLARE_API_BASE=http://cloudflare:8080/client/v4`, for the zone `CLOUDFLARE_ZONE_ID` with the token `CLOUDFLARE_API_TOKEN` (both random, in `.env`). `POST`, `GET`, `PATCH` and `DELETE` answer Cloudflare's envelope; a hostname is created `pending`/`initializing`, and each `GET` or `PATCH` moves it on: `active`/`pending_validation`, then `active`/`active`, so one **Check now** activates it. In memory only. Published on `127.0.0.1:18081`, where `GET /_mock/hostnames` lists what the API asked for. |
| `scanner` (`WORKER_QUEUES=scan`) and `rescanner` (`rescan`) | Docker, the worker image | Milestone 4 §2.2. New uploads stay `pending` until the scanner is done. They get the ClamAV and evidence settings; the API and the jobs worker don't. |
| `clamav` | Docker, the image pinned in `docker-compose.test.yml` | Offline, as in the API test compose: `clamd` only, no `freshclam`, and only the test database from `api/tests/fixtures/clamav/` (EICAR by hash, which blocks, and a test-only `PUA.` string, which flags), bind-mounted read-only with its `clamd.conf`. That's the stack's only bind mount. Not published. |
| The `bucket` one-off | Docker, the API image | Creates `filesgg` and the evidence bucket `filesgg-evidence`, the latter **with Object Lock** (it can only be enabled at creation), and checks it's on. |
| The Worker | `wrangler dev` on `127.0.0.1:8787`, started in the background by `up.sh` | Config generated from `cf-worker/wrangler.toml` without the routes (so `Host` is kept), with `MAIN_HOST`, `CDN_HOST` and `API_HOST` set to `files.localhost`, `cdn.files.localhost` and `api.files.localhost`; every other host is a custom domain. `SESSION_COOKIE_NAME=filesgg_session`. `API_ORIGIN` points at the API, `S3_ENDPOINT` at MinIO. |
| The web app | Built by `up.sh` into `~/.cache/filesgg-e2e/web-dist` (never `web/dist`) | No `VITE_API_URL`: it calls `/api` same-origin (milestone-6 §13.1). Cloudflare's always-pass testing site key from `web/src/lib/config.ts`. |
| The API's public URLs | `PUBLIC_URL=http://files.localhost:8787`, `CDN_URL=http://cdn.files.localhost:8787`, `API_PUBLIC_URL=http://api.files.localhost:8787` | There's no `ALLOWED_ORIGINS` any more: nothing is credentialed cross-origin. |
| Account settings (Milestone 6) | The API and every worker container | `SESSION_COOKIE_INSECURE=1` (cookie `filesgg_session` without `Secure`; production refuses to boot with it), the mock Cloudflare's `CLOUDFLARE_*`, and `DOMAIN_DNS_STUB=1` (dev only, with `FILESGG_DEV_TOOLS=1`). `DISCORD_*` and `POSTMARK_SERVER_TOKEN` are unset. |
| Trust & safety settings | Every API, worker and scanner container | `CSAM_MATCHER=standin` with `FILESGG_DEV_TOOLS=1` (the stand-in matcher refuses to run without it, and the API refuses to boot without a matcher), `ABUSE_HASH_SECRET` and `EVIDENCE_PUBLIC_KEY` from `.env`. The scanner and rescanner also get `CLAMAV_HOST=clamav`, `CLAMAV_PORT=3310`, `S3_BUCKET_EVIDENCE=filesgg-evidence` and the MinIO key as `S3_EVIDENCE_ACCESS_KEY_ID` / `S3_EVIDENCE_SECRET_ACCESS_KEY`. `WEB_RISK_API_KEY` is unset, so Web Risk is `skipped` (it fails open). |

**Generated files:** in `e2e/.local/`, which is git-ignored:
- `.env`: random secrets, shared by the API and the Worker, including `ABUSE_HASH_SECRET`, `EVIDENCE_PUBLIC_KEY`, the mock Cloudflare's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ZONE_ID`, and the three users' passwords (missing Milestone 4 and 6 entries are added to an older `.env`);
- `evidence-private.pem` (mode 600): the X25519 private key of the evidence key pair (milestone-4 §3.6), made with Node's `crypto.generateKeyPairSync('x25519')`. The API only gets the raw 32-byte public key, as base64. Nothing in the stack reads the private key; it's there to open sealed uploader IPs by hand;
- `wrangler.log` and `wrangler.pid`;
- `e2e-user.json`, `e2e-member.json` and `e2e-reporter.json` (`tools.create_user`'s output: id, username, email, and a web session for the cookie).

and, outside the checkout, in `${XDG_CACHE_HOME:-~/.cache}/filesgg-e2e/` (or `E2E_WORKER_DIR`), mode 700, everything `wrangler dev` reads and watches:
- `.dev.vars`: the Worker's secrets;
- `wrangler.json`: the Worker's config;
- `web-dist/`: the web build;
- `wrangler-state/` and `.wrangler/`: wrangler's local state and bundle.

Why outside: when the checkout is in a synced folder (iCloud Desktop & Documents, Dropbox), the sync client keeps touching freshly built files for minutes. Wrangler's asset watcher takes each touch as a change and restarts the Worker (62 restarts in one run), and any POST in flight at that moment gets wrangler's own `503 Your worker restarted mid-request` (it retries only GET and HEAD). `down.sh` removes both folders.

**Ports:** override them with `E2E_PORT` (8787), `E2E_API_PORT` (18080), `E2E_MINIO_PORT` (19000) and `E2E_CLOUDFLARE_PORT` (18081). Use the same values for `up.sh` and `run.mjs`. `E2E_WRANGLER_LOG_LEVEL` (`info`) sets wrangler's log level; `debug` logs every file change and reload.

**Logs:**
- the Worker: `e2e/.local/wrangler.log`;
- the API, the jobs worker, the scanner and the mock Cloudflare: `docker compose -p filesgg-e2e logs -f api worker scanner rescanner clamav cloudflare`.

**Local differences from production:**
- MinIO has one key, so the Worker reads with the same key the API writes with. In production, the Worker's key is read-only.
- No email is sent: `POSTMARK_SERVER_TOKEN` is unset (the API logs that account emails fail with 503; nothing else depends on them).
- The session cookie is `filesgg_session` without `Secure`, not `__Host-filesgg_session`.
- Cloudflare's custom hostnames API is the mock, and DNS checks for custom domains are stubbed (`DOMAIN_DNS_STUB=1`).
- `wrangler dev` passes a client's `CF-Connecting-IP` through to the Worker (Cloudflare's edge overwrites it in production), and the Worker vouches for it to the API. `run.mjs` uses that to be several viewers (view limits) and a fresh address for registering.
- CSAM matching uses the stand-in matcher and its benign test hashes (`api/tests/fixtures/standin/`), never PhotoDNA. `run.mjs` has no CSAM or NSFW steps: the API suite covers both.
- ClamAV knows only the test signatures, not the official databases.
- The evidence bucket is written with the MinIO root key. In production its key can write and copy into the bucket but not read or delete.

## What `run.mjs` checks

It uses plain `fetch` against the local hosts. **The website** is signed in with real logins through `files.localhost/api`: a small `Caller` keeps a cookie jar for `filesgg_session` and sends `X-Filesgg-Csrf: 1` on every write, like the web app. **Tools** upload to `api.files.localhost` with an upload key. It also runs `docker compose exec`: psql (to move a file's expiry, a session's sign-in time and an account's age into the past, and to store a raw HTML filename), `tools.create_user` (a fresh account for each Milestone 6 step that changes one) and `tools.entitlements`. Test media is made by `ffmpeg` in the jobs worker container. Each run uploads new files and makes its own accounts and domain, so it can run again on the same stack. Reports are rate-limited to 10 an hour per IP (milestone-4 §7.7) and every run sends one anonymous report from the same address, so about ten runs an hour fit. Registering uses a random address of its own each run (`register` allows 5 an hour per IP).

**Waiting for scans.** Since Milestone 4 every new upload is `pending` until the scanner is done (§2). Wherever a step uploads and then expects a page or CDN bytes, it first polls the owner's `GET /users/@me/files/<id>` until `safety.state` leaves `pending` (or the upload is rejected with `410 UPLOAD_REJECTED`). Each wait is printed under its step, with a min/median/max summary at the end. Content the stack has seen before (the same test media on a second run) is passed at once.

0. **Setup.** The hosts resolve to loopback, the API answers through the Worker, and the viewer CSP names the local CDN and API. `e2e`, `e2e.member` and `e2e.reporter` sign in with `POST /api/auth/login` and a Turnstile testing token; the response sets `filesgg_session` (`HttpOnly`, `SameSite=Lax`, `Path=/`, the 180-day `Max-Age`, no `Secure`).
1. **Anonymous single upload** through `files.localhost/api` with a Turnstile token. Without a token (or a key) it's `401 UPLOAD_KEY_REQUIRED`. The CDN bytes match (sha256). `files.localhost/<vanity>` returns the shell with a correct `#file-data`, and `&` is escaped as `&`.
2. **Signed-in chunked upload** of 30 MB. Four chunks go up concurrently and out of order, then `complete`, then a poll until `complete`. The CDN bytes match, and a `Range` request across a chunk boundary works.
3. **HTML filename** `</script><script>alert(1)</script>.png`.
   - The API turns `<`, `>` and `/` into `_` on upload. That's long-standing behaviour.
   - The file is a real PNG: an image the scanner can't decode is served as an attachment only (milestone-4 §2.3), and step 7 needs an image.
   - The raw name is then written to the database, and the shell is checked: the JSON escapes it, it adds exactly one `<script>`, `<script>alert(1)` appears nowhere live, the meta tags are escaped, and the CDN's `Content-Disposition` is encoded.
4. **Password.**
   - `PATCH visibility: password` gives the `locked` shell, with no media or name in the meta.
   - The CDN gives 401.
   - Unlock without Turnstile gives `CAPTCHA_INVALID`, and a wrong password gives `WRONG_PASSWORD`.
   - A successful unlock (`POST /access/unlock/files/<vanity>`) returns a token and signed URLs, and `GET /access/view/files/<vanity>` and `POST /access/refresh/files/<vanity>` work with it.
   - Changing the password bumps `access_version`. The API refuses the old token at once. The CDN refuses it within the Worker's 5 s lookup cache, so the test polls.
5. **Private.**
   - The shell is `missing` (404), for bots too, and the CDN and `/access/view` give 404 without a token.
   - The owner's signed URL serves it, an owner pass works on `/access/view`, and its `url` uses `PUBLIC_URL`.
6. **Expiry.** `expires_at` is set in the past with psql, because the minimum `expires_in` is 1 h. The API forgets the file at once. The shell and the CDN show it as missing after the lookup cache expires, so the test polls.
7. **Bots.**
   - `TelegramBot` on a `link` file is redirected (302) to the CDN.
   - `Discordbot` gets the embed page, whose `og:image` is the CDN URL. Only Telegram is redirected among `*bot` agents, as before.
   - On a password file, neither bot nor `Accept: image/*` is redirected. They get the locked shell, with no media.
8. **Limits.** `GET /users/@me/limits` returns the anonymous and the signed-in values from contract §6, plus `nsfw_allowed` (milestone-4 §13) and Milestone 6's fields (§9.2): `premium`, `custom_domains`, `upload_keys`, `domain_only_allowed`, and `max_file_size_single` capped at `PROXY_BODY_LIMIT_BYTES` − 1 MiB (98,951,424) with the configured 100 MB in `max_file_size_single_configured`.
9. **Media.** A PNG, an MP4 and an MP3 are scanned, probed and derived. The previews are at `/previews/<kind>/<vanity>`, and malformed preview paths are 404.
10. **Protected previews** are signed per path. A signature only opens its own path.
11. **Albums.** The page, the collage, the ZIP (checked with `unzip -t`), a link album hiding its password item, and a password album whose token opens every item.
12. **Library.** Filters, search, bulk expiry, and a deleted file leaving its album and previews.
13. **Executables** are refused at upload: by name, disguised as an image, declared as a program, and in a chunked upload.

Milestone 4 (`docs/redesign/contracts/milestone-4.md`):

14. **Gating** (§2.4, §10). Straight after uploading a new image:
    - the page is the `pending` shell (200, `private, no-store`, `#file-data` = `{ vanity, pending: true }`, "Checking this file" with no media or name);
    - the CDN is `404 private, no-store`, `GET /files/<vanity>` is `409 FILE_PENDING`, and TelegramBot isn't redirected.
    
    After the scan, the CDN serves the bytes and the page the file, once the Worker's lookup cache (5 s) has expired.
15. **Malware** (§2.5, §5.2). The EICAR string is assembled at runtime and never written to disk. The e2e clamd knows it by its exact hash, so it goes in a zip with a fresh second entry, for a new hash every run.
    - Anonymous: the owner gets `410 UPLOAD_REJECTED { reason: "MALWARE_DETECTED" }`. The page is `missing` (404), and neither the CDN nor `GET /files/<vanity>` ever serves it.
    - Signed in: the file is `blocked` (`malware`), with an appealable `scan_block` notice, and it's never served. The same bytes again are refused at upload with `400 MALWARE_DETECTED`.
    - The bare EICAR file is scanned and blocked on a fresh stack, and refused at upload once the stack knows it.
    - The test `PUA.` signature only flags: the owner sees `flagged` (`unwanted_software`), and the page, the CDN and the public API serve it with the `unwanted_software` warning.
16. **Archives** (§5.3). Zips holding a Windows PE (built like `api/tests/test_filetypes.py` does), as `setup.exe` or disguised as `docs/readme.txt`, are `blocked` (`blocked_type`) with a notice when signed in. Anonymously (`game/bin/tool.EXE`) they're rejected with `410 UPLOAD_REJECTED { reason: "FILE_TYPE_NOT_ALLOWED" }`. None is ever served.
17. **Reports and moderation** (§7–§9). `e2e.member` uploads a file.
    - It's reported anonymously, with the Turnstile testing token (without it: `CAPTCHA_INVALID`), and by `e2e.reporter` through its URL. The owner can't report it (`CANNOT_REPORT_YOURSELF`). Two `spam` reports are under the threshold, so nothing happens automatically.
    - Staff (`e2e`) find the case in `GET /admin/cases`, claim it, and hide the file with `POST /admin/actions`.
    - Within the 5 s lookup cache (plus 3 s slack), the page is the `removed` shell (410, `no-cache`, reason `review`, no name), the CDN is `410 private, no-store`, and `GET /files/<vanity>` is `410 FILE_REMOVED`.
    - The owner's file is `hidden` (`spam`), with the notice in `GET /users/@me/warnings` and in the badges. The owner appeals, once (a second appeal gets `APPEAL_NOT_ALLOWED`), and acknowledges the notice.
    - Closing the case resolves the reporter's report (`GET /users/@me/reports/<id>`), with a message from staff in its thread.
    - The appeal is a P2 case that needs a second review. `e2e` is the only staff member, so it may grant it, which serves the file again.
18. **`security.txt`** on `files.localhost` and `cdn.files.localhost` matches `web/public/.well-known/security.txt` (`text/plain; charset=utf-8`; the CDN copy has `nosniff`). It's 404 on `api.files.localhost`.
19. **Admin access** (§9.1). `GET /users/@me` shows `e2e` as staff. Staff get the queue and the summary (no stalled scans). For `e2e.member`, `e2e.reporter` and signed-out callers, `/admin/*` answers exactly like an unknown route (404, same body), and `POST /admin/actions` changes nothing. Staff's cookie sent to `api.files.localhost` is ignored (404 there too).

Milestone 6 (`docs/redesign/contracts/milestone-6.md`):

20. **Sessions** (§3). A fresh account signs in: the cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, host-only, and the token (`fgs_` + 36 base62) is never in the body. `GET /api/auth/session` returns the user (and `{ user: null }`, never 401, signed out). The session `tools.create_user` printed works as the cookie.
    - On `api.files.localhost` the cookie is ignored (no `X-Filesgg-Via`; a client's own `X-Filesgg-Via: main` is stripped): 401, `{ user: null }`, no `Set-Cookie`.
    - CSRF: a cookie `PATCH` without `X-Filesgg-Csrf`, with a foreign `Origin`, with `Origin: null` or with `Sec-Fetch-Site: cross-site` is `403 CSRF`; with the header and same-origin values it's 200. A login without the header is `403 CSRF` too.
    - `Authorization: Bearer <token>` is 401 on both hosts.
    - Logout clears the cookie (`Max-Age=0`) and the old value is refused. A password change ends every other session (the old password stops working); sign out everywhere ends all of them, including this one, and a dead cookie is cleared by `GET /auth/session`.
21. **Register** (§4.3, §4.2). Discord is off (`/auth/config`, `503 DISCORD_UNAVAILABLE`). The username check works signed out (available, `taken`, `reserved`, `characters`). An anonymous upload, then `POST /api/auth/register` with the same fingerprint (Turnstile testing token): 201, the cookie, a lowercased username and an **unverified** email; the name is now taken to others, the email again is `EMAIL_TAKEN`, and the anonymous upload is the account's, with its expiry.
22. **Upload keys** (§7). Created once with its secret (`fgg_…`, prefix = 12 characters), the `.sxcu` (`RequestURL` = `API_PUBLIC_URL/files`) and the curl snippet; never shown again. A tool uploads with it to `api.files.localhost`, single and chunked; the files are e2e's. The key is refused (`403 UPLOAD_KEY_NOT_ALLOWED`) on non-upload endpoints there and on `files.localhost/api` website calls (`/admin/*` is the plain 404). Revoked or mistyped: `401 UPLOAD_KEY_INVALID`. No key and no Turnstile: `401 UPLOAD_KEY_REQUIRED` on `POST /files` and `POST /uploads`.
23. **Premium** (§9). A fresh account's limits; a 2 GB chunked upload is `413 FILE_TOO_LARGE`. An admin grants premium (`POST /api/admin/users/<id>/entitlements`; twice is `ENTITLEMENT_EXISTS`; a non-staff caller gets the 404): 100 GB storage, 5 GB chunked (2 GB accepted), 5 domains, domain-only allowed, and single requests still capped by `PROXY_BODY_LIMIT_BYTES`. Revoked, the limits are back at once. Then the same with `python -m tools.entitlements grant --days 30` / `list` / `revoke`, and the admin detail shows both entitlements.
24. **Custom domain** (§10). A fresh premium account: refused while it's minutes old (`DOMAIN_REQUIREMENTS account_too_new`), then made 8 days old with psql; a non-premium user gets `PREMIUM_REQUIRED`, an apex hostname `INVALID_HOSTNAME`.
    - Adding `files-<random>.example.localhost` creates the hostname at the mock Cloudflare (HTTP DCV) and is `pending_dns` (the host shows "isn't connected"). **Check now** makes it `active` and serving; again within a minute is `429`.
    - On the custom host: the owner's file (`data-host="custom"`, `#host-data`), with every URL rehosted onto the host, its bytes with the CDN hardening, HSTS, no cookies; the landing card; `/app`, `/api`, `/login` and `security.txt` are 404. A password file is locked there, and an unlock's signed URL works when rehosted. An owner pass on the domain opens the file.
    - "Only my files": e2e's file and an anonymous file are `missing` there (and still served on `files.localhost`).
    - Domain-only (with `confirm`): the file is `missing` on `files.localhost`, the CDN is `404 private, no-store` unsigned but serves the owner's signed URL, and the custom host still serves it.
    - A staff URL (`staff=`) works on the CDN but is refused on the custom host (404 for a link file, 401 for a password file). An unknown `*.localhost` host shows "isn't connected".
    - Removing the domain deletes the hostname at the mock Cloudflare (the worker's `domain_delete` job), and the host stops serving.
    - Last: the owner's `url`, `direct_url` and owner-pass `url` are on the domain with `PUBLIC_URL`'s scheme and port, like the Worker's rehosting.
25. **View limits** (§19). Uploaded with an upload key and `view_limit=2`: the page is the `limited` shell (`private, no-store`, generic og tags), the CDN refuses unsigned (404), and `GET /files/<vanity>` is only the stub. Discordbot, facebookexternalhit, WhatsApp, TelegramBot and `Accept: image/*` get `403` with the text, and no view is used; neither does the owner, nor an open without Turnstile (`CAPTCHA_INVALID`).
    - Viewers are different addresses (`CF-Connecting-IP`, above). Viewer A opens it twice (`POST /api/access/open/files/<vanity>`): one view. Viewer B is the last: their signed URL works, A's earlier one stops working (`access_version`). Viewer C gets `404 UNKNOWN_FILE`, and the page becomes `missing`.
    - `view_limit_action=private` with a limit of 1: after one viewer the file is private, missing to everyone else, and the owner's signed URL still serves it. An anonymous upload can't choose `private`.
    - A password file with a limit: open without unlocking is `401 UNLOCK_REQUIRED`; a wrong password uses nothing; the unlock is the view, once per viewer (unlocking again or opening with the token doesn't count); after the second viewer the right password gets 404.
26. **Routes** (§20). The old `/files/<v>/unlock`, `/unlock/refresh`, `/view`, `/open` and the album ones are 404 on both API hosts. `/report/<vanity>`, `/report/a/<vanity>` and `/report` are the report pages, and the old `/<vanity>/report` and `/a/<vanity>/report` are `missing`. `/a/<vanity>?item=2` is the album, and `/a/<vanity>/2` is `missing`.
27. **Account deletion** (§8.8). Staff can't (`409 ACCOUNT_DELETE_NOT_ALLOWED staff`). A fresh account whose session signed in an hour ago (psql) gets `403 REAUTH_REQUIRED`; `POST /api/auth/reauth` (a wrong password is `INVALID_CREDENTIALS`), then `POST /api/users/@me/delete` with the username: 202, 14 days. The other session ends, the library and the upload key are `403 ACCOUNT_PENDING_DELETION`, and the file is `missing` (never removed): the page 404, the CDN `404 private, no-store`, the API `UNKNOWN_FILE`. Signing in still works and shows the deletion. **Keep my account** (`POST /api/users/@me/delete/cancel`) brings the file, the library and the key back.
