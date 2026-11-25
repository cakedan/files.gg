# Local full stack and end-to-end test

The whole of files.gg on your machine: the API, the jobs worker, the Milestone 4 scanner and rescanner with an offline ClamAV, Postgres, MinIO standing in for B2, the Cloudflare Worker under `wrangler dev`, and a fresh `web` build. It runs on hostnames that resolve to loopback by themselves, so no `/etc/hosts` edits and no sudo.

## Commands

From the repo root:

```sh
e2e/up.sh          # start everything (first run builds the API and worker images and the web app)
node e2e/run.mjs   # the end-to-end test, against the running stack (about 90 s)
e2e/down.sh        # stop everything and delete its data (volumes, secrets, web build, logs)
```

`up.sh` is safe to run again: it rebuilds what changed and restarts the Worker. It prints the URLs and the e2e user's credentials at the end.

**Milestone 4 (trust & safety)** needs no setup of its own: `up.sh` generates `ABUSE_HASH_SECRET` and the evidence key pair, creates the Object Lock evidence bucket, starts the scanner and an offline clamd, and makes the `e2e` user staff. Nothing is downloaded for scanning: clamd runs on the API suite's tiny test signature database, and the CSAM matcher is the stand-in.

**Needs:** Docker, Node 24+, `openssl`, `curl`, and **internet access**. Turnstile uses Cloudflare's documented always-pass testing keys, so the API calls Cloudflare's real `siteverify`. There's no test-only bypass in the API.

## URLs

| URL | What |
|---|---|
| http://files.localhost:8787/ | The site (viewer shell, home) |
| http://files.localhost:8787/app/upload | Upload page (dashboard) |
| http://files.localhost:8787/app | Dashboard |
| http://files.localhost:8787/&lt;vanity&gt; | A file page |
| http://cdn.files.localhost:8787/files/&lt;vanity&gt;.&lt;ext&gt; | File bytes |
| http://api.files.localhost:8787/health | The API, through the Worker |
| http://files.localhost:8787/app/admin | Admin pages (the `e2e` user is staff) |
| http://files.localhost:8787/&lt;vanity&gt;/report | The report page for a file |
| http://files.localhost:8787/.well-known/security.txt | `security.txt` (also on `cdn.files.localhost`) |

`*.localhost` resolves to `127.0.0.1` and `::1` in Chromium, Firefox and curl, and on macOS for Node too. `run.mjs` checks this first.

**Signing in:** there's no login page until Milestone 6 (accounts). `up.sh` creates the user `e2e` (email `e2e@files.localhost`) with a random password and prints a line to paste in the browser console on `http://files.localhost:8787/app`:

```js
localStorage.setItem('filesgg.token', '<token>'); location.reload()
```

The password works with `POST /auth/login` too: `run.mjs` signs in that way. The credentials are kept in `e2e/.local/.env` (`E2E_USER_PASSWORD`) and `e2e/.local/e2e-user.json`.

**Staff:** `e2e` is staff, an `admin` with the `child_safety` capability (milestone-4 §9.1), granted by `up.sh` after the migrations with the production CLI:

```sh
docker compose -p filesgg-e2e exec api python -m tools.staff grant <user_id> --role admin --child-safety --by e2e/up.sh
```

`up.sh` also creates two users who aren't staff, `e2e-member` and `e2e-reporter` (passwords `E2E_MEMBER_PASSWORD` and `E2E_REPORTER_PASSWORD` in `.env`, tokens in `e2e-member.json` and `e2e-reporter.json`). `run.mjs` uses them as a file owner and a reporter, and to check that non-staff get 404 from `/admin/*`.

To make another user, run the dev tool in the API container. It refuses to run without `FILESGG_DEV_TOOLS=1`:

```sh
docker compose -p filesgg-e2e exec -e FILESGG_DEV_TOOLS=1 api \
  python -m tools.create_user --username alice --password 'something-long'
```

## How it's put together

| Part | Where it runs | Notes |
|---|---|---|
| Postgres 19, MinIO, bucket creation, `python -m migrate`, the API (`sanic`, 2 workers), `python -m worker` (`default,media`) | Docker, `docker-compose.e2e.yml` (project `filesgg-e2e`) | Data in named volumes only. The API is published on `127.0.0.1:18080` and MinIO on `127.0.0.1:19000`, both for the Worker. |
| `scanner` (`WORKER_QUEUES=scan`) and `rescanner` (`rescan`) | Docker, the worker image | Milestone 4 §2.2. New uploads stay `pending` until the scanner is done. They get the ClamAV and evidence settings; the API and the jobs worker don't. |
| `clamav` | Docker, the image pinned in `docker-compose.test.yml` | Offline, as in the API test compose: `clamd` only, no `freshclam`, and only the test database from `api/tests/fixtures/clamav/` (EICAR by hash, which blocks, and a test-only `PUA.` string, which flags), bind-mounted read-only with its `clamd.conf`. That's the stack's only bind mount. Not published. |
| The `bucket` one-off | Docker, the API image | Creates `filesgg` and the evidence bucket `filesgg-evidence`, the latter **with Object Lock** (it can only be enabled at creation), and checks it's on. |
| The Worker | `wrangler dev` on `127.0.0.1:8787`, started in the background by `up.sh` | Config generated from `cf-worker/wrangler.toml` without the routes (so `Host` is kept), with `MAIN_HOST`, `CDN_HOST`, `API_HOST` and `PROXY_HOST` set to `files.localhost`, `cdn.files.localhost`, `api.files.localhost` and `proxy.files.localhost`. `API_ORIGIN` points at the API, `S3_ENDPOINT` at MinIO. The GCS fallback is off. |
| The web app | Built by `up.sh` into `e2e/.local/web-dist` (never `web/dist`) | `VITE_API_URL=http://api.files.localhost:8787`, and Cloudflare's always-pass testing site key from `web/src/lib/config.ts`. |
| The API's public URLs | `PUBLIC_URL=http://files.localhost:8787`, `CDN_URL=http://cdn.files.localhost:8787` | |
| Trust & safety settings | Every API, worker and scanner container | `CSAM_MATCHER=standin` with `FILESGG_DEV_TOOLS=1` (the stand-in matcher refuses to run without it, and the API refuses to boot without a matcher), `ABUSE_HASH_SECRET` and `EVIDENCE_PUBLIC_KEY` from `.env`. The scanner and rescanner also get `CLAMAV_HOST=clamav`, `CLAMAV_PORT=3310`, `S3_BUCKET_EVIDENCE=filesgg-evidence` and the MinIO key as `S3_EVIDENCE_ACCESS_KEY_ID` / `S3_EVIDENCE_SECRET_ACCESS_KEY`. `WEB_RISK_API_KEY` is unset, so Web Risk is `skipped` (it fails open). |

**Generated files:** everything goes in `e2e/.local/`, which is git-ignored:
- `.env`: random secrets, shared by the API and the Worker, including `ABUSE_HASH_SECRET`, `EVIDENCE_PUBLIC_KEY` and the three users' passwords (missing Milestone 4 entries are added to an older `.env`);
- `evidence-private.pem` (mode 600): the X25519 private key of the evidence key pair (milestone-4 §3.6), made with Node's `crypto.generateKeyPairSync('x25519')`. The API only gets the raw 32-byte public key, as base64. Nothing in the stack reads the private key; it's there to open sealed uploader IPs by hand;
- `.dev.vars`: the Worker's secrets;
- `wrangler.json`: the Worker's config;
- `web-dist/`: the web build;
- `wrangler.log`;
- `e2e-user.json`, `e2e-member.json` and `e2e-reporter.json` (id, username, email, token).

**Ports:** override them with `E2E_PORT` (8787), `E2E_API_PORT` (18080) and `E2E_MINIO_PORT` (19000). Use the same values for `up.sh` and `run.mjs`.

**Logs:**
- the Worker: `e2e/.local/wrangler.log`;
- the API, the jobs worker and the scanner: `docker compose -p filesgg-e2e logs -f api worker scanner rescanner clamav`.

**Local differences from production:**
- MinIO has one key, so the Worker reads with the same key the API writes with. In production, the Worker's key is read-only.
- No email is sent: `POSTMARK_SERVER_TOKEN` is unset.
- CSAM matching uses the stand-in matcher and its benign test hashes (`api/tests/fixtures/standin/`), never PhotoDNA. `run.mjs` has no CSAM or NSFW steps: the API suite covers both.
- ClamAV knows only the test signatures, not the official databases.
- The evidence bucket is written with the MinIO root key. In production its key can write and copy into the bucket but not read or delete.

## What `run.mjs` checks

It uses plain `fetch` against the three local hosts. It also runs `docker compose exec postgres psql` twice: once to move a file's expiry into the past, and once to store a raw HTML filename. Test media is made by `ffmpeg` in the jobs worker container. Each run uploads new files, so it can run again on the same stack. Reports are rate-limited to 10 an hour per IP (milestone-4 §7.7) and every run sends one anonymous report from `127.0.0.1`, so about ten runs an hour fit.

**Waiting for scans.** Since Milestone 4 every new upload is `pending` until the scanner is done (§2). Wherever a step uploads and then expects a page or CDN bytes, it first polls the owner's `GET /users/@me/files/<id>` until `safety.state` leaves `pending` (or the upload is rejected with `410 UPLOAD_REJECTED`). Each wait is printed under its step, with a min/median/max summary at the end. Content the stack has seen before (the same test media on a second run) is passed at once.

0. **Setup.** The hosts resolve to loopback, the API answers through the Worker, the viewer CSP names the local CDN and API, and the e2e user signs in with `POST /auth/login` and a Turnstile testing token.
1. **Anonymous single upload** with a Turnstile token. Without one, it's refused. The CDN bytes match (sha256). `files.localhost/<vanity>` returns the shell with a correct `#file-data`, and `&` is escaped as `&`.
2. **Signed-in chunked upload** of 30 MB. Four chunks go up concurrently and out of order, then `complete`, then a poll until `complete`. The CDN bytes match, and a `Range` request across a chunk boundary works.
3. **HTML filename** `</script><script>alert(1)</script>.png`.
   - The API turns `<`, `>` and `/` into `_` on upload. That's long-standing behaviour.
   - The file is a real PNG: an image the scanner can't decode is served as an attachment only (milestone-4 §2.3), and step 7 needs an image.
   - The raw name is then written to the database, and the shell is checked: the JSON escapes it, it adds exactly one `<script>`, `<script>alert(1)` appears nowhere live, the meta tags are escaped, and the CDN's `Content-Disposition` is encoded.
4. **Password.**
   - `PATCH visibility: password` gives the `locked` shell, with no media or name in the meta.
   - The CDN gives 401.
   - Unlock without Turnstile gives `CAPTCHA_INVALID`, and a wrong password gives `WRONG_PASSWORD`.
   - A successful unlock returns a token. The CDN gives 200 with `?t=`, and `/view` and `refresh` work with it.
   - Changing the password bumps `access_version`. The API refuses the old token at once. The CDN refuses it within the Worker's 5 s lookup cache, so the test polls.
5. **Private.**
   - The shell is `missing` (404), for bots too, and the CDN and `/view` give 404 without a token.
   - An owner pass gives 200 on the CDN via `?t=` and on `/view`, and its `url` uses `PUBLIC_URL`.
6. **Expiry.** `expires_at` is set in the past with psql, because the minimum `expires_in` is 1 h. The API forgets the file at once. The shell and the CDN show it as missing after the lookup cache expires, so the test polls.
7. **Bots.**
   - `TelegramBot` on a `link` file is redirected (302) to the CDN.
   - `Discordbot` gets the embed page, whose `og:image` is the CDN URL. Only Telegram is redirected among `*bot` agents, as before.
   - On a password file, neither bot nor `Accept: image/*` is redirected. They get the locked shell, with no media.
8. **Limits.** `GET /users/@me/limits` returns the anonymous and the signed-in values from contract §6, plus `nsfw_allowed` (milestone-4 §13).
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
17. **Reports and moderation** (§7–§9). `e2e-member` uploads a file.
    - It's reported anonymously, with the Turnstile testing token (without it: `CAPTCHA_INVALID`), and by `e2e-reporter` through its URL. The owner can't report it (`CANNOT_REPORT_YOURSELF`). Two `spam` reports are under the threshold, so nothing happens automatically.
    - Staff (`e2e`) find the case in `GET /admin/cases`, claim it, and hide the file with `POST /admin/actions`.
    - Within the 5 s lookup cache (plus 3 s slack), the page is the `removed` shell (410, `no-cache`, reason `review`, no name), the CDN is `410 private, no-store`, and `GET /files/<vanity>` is `410 FILE_REMOVED`.
    - The owner's file is `hidden` (`spam`), with the notice in `GET /users/@me/warnings` and in the badges. The owner appeals, once (a second appeal gets `APPEAL_NOT_ALLOWED`), and acknowledges the notice.
    - Closing the case resolves the reporter's report (`GET /users/@me/reports/<id>`), with a message from staff in its thread.
    - The appeal is a P2 case that needs a second review. `e2e` is the only staff member, so it may grant it, which serves the file again.
18. **`security.txt`** on `files.localhost` and `cdn.files.localhost` matches `web/public/.well-known/security.txt` (`text/plain; charset=utf-8`; the CDN copy has `nosniff`). It's 404 on `api.files.localhost`.
19. **Admin access** (§9.1). `GET /users/@me` shows `e2e` as staff. Staff get the queue and the summary (no stalled scans). For `e2e-member`, `e2e-reporter` and signed-out callers, `/admin/*` answers exactly like an unknown route (404, same body), and `POST /admin/actions` changes nothing.
