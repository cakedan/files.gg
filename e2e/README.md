# Local full stack and end-to-end test

The whole of files.gg on your machine: the API, the jobs worker, Postgres, MinIO standing in for B2, the Cloudflare Worker under `wrangler dev`, and a fresh `web` build. It runs on hostnames that resolve to loopback by themselves, so no `/etc/hosts` edits and no sudo.

## Commands

From the repo root:

```sh
e2e/up.sh          # start everything (first run builds the API image and the web app)
node e2e/run.mjs   # the end-to-end test, against the running stack (about 70 s)
e2e/down.sh        # stop everything and delete its data (volumes, secrets, web build, logs)
```

`up.sh` is safe to run again: it rebuilds what changed and restarts the Worker. It prints the URLs and the e2e user's credentials at the end.

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

`*.localhost` resolves to `127.0.0.1` and `::1` in Chromium, Firefox and curl, and on macOS for Node too. `run.mjs` checks this first.

**Signing in:** the old login page (`/auth/login`) is part of the legacy frontend, which isn't available locally. `up.sh` creates the user `e2e` (email `e2e@files.localhost`) with a random password and prints a line to paste in the browser console on `http://files.localhost:8787/app`:

```js
localStorage.token = JSON.stringify('<token>'); location.reload()
```

The password works with `POST /auth/login` too: `run.mjs` signs in that way. The credentials are kept in `e2e/.local/.env` (`E2E_USER_PASSWORD`) and `e2e/.local/e2e-user.json`.

To make another user, run the dev tool in the API container. It refuses to run without `FILESGG_DEV_TOOLS=1`:

```sh
docker compose -p filesgg-e2e exec -e FILESGG_DEV_TOOLS=1 api \
  python -m tools.create_user --username alice --password 'something-long'
```

## How it's put together

| Part | Where it runs | Notes |
|---|---|---|
| Postgres 19, MinIO, bucket creation, `python -m migrate`, the API (`sanic`, 2 workers), `python -m worker` | Docker, `docker-compose.e2e.yml` (project `filesgg-e2e`) | Named volumes only, no bind mounts. The API is published on `127.0.0.1:18080` and MinIO on `127.0.0.1:19000`, both for the Worker. |
| Mimetypes | `seed/mimetypes.sql`, loaded by `up.sh` | The migrations create the tables empty (production has the rows), and uploads need them. |
| The Worker | `wrangler dev` on `127.0.0.1:8787`, started in the background by `up.sh` | Config generated from `cf-worker/wrangler.toml` without the routes (so `Host` is kept), with `MAIN_HOST`, `CDN_HOST`, `API_HOST` and `PROXY_HOST` set to `files.localhost`, `cdn.files.localhost`, `api.files.localhost` and `proxy.files.localhost`. `API_ORIGIN` points at the API, `S3_ENDPOINT` at MinIO. The GCS fallback is off. |
| The web app | Built by `up.sh` into `e2e/.local/web-dist` (never `web/dist`) | `VITE_API_URL=http://api.files.localhost:8787`, and Cloudflare's always-pass testing site key from `web/src/lib/config.ts`. |
| The API's public URLs | `PUBLIC_URL=http://files.localhost:8787`, `CDN_URL=http://cdn.files.localhost:8787` | |

**Generated files:** everything goes in `e2e/.local/`, which is git-ignored:
- `.env`: random secrets, shared by the API and the Worker;
- `.dev.vars`: the Worker's secrets;
- `wrangler.json`: the Worker's config;
- `web-dist/`: the web build;
- `wrangler.log`;
- `e2e-user.json`.

**Ports:** override them with `E2E_PORT` (8787), `E2E_API_PORT` (18080) and `E2E_MINIO_PORT` (19000). Use the same values for `up.sh` and `run.mjs`.

**Logs:**
- the Worker: `e2e/.local/wrangler.log`;
- the API and the jobs worker: `docker compose -p filesgg-e2e logs -f api worker`.

**Local differences from production:**
- MinIO has one key, so the Worker reads with the same key the API writes with. In production, the Worker's key is read-only.
- The legacy pages (`/auth`, `/dashboard`, …) show "script unavailable": their bundle lives in the production GCS bucket, which the local stack never touches.
- No email is sent: `POSTMARK_SERVER_TOKEN` is unset.

## What `run.mjs` checks

It uses plain `fetch` against the three local hosts. It also runs `docker compose exec postgres psql` twice: once to move a file's expiry into the past, and once to store a raw HTML filename. Each run uploads new files, so it can run again on the same stack.

0. **Setup.** The hosts resolve to loopback, the API answers through the Worker, the viewer CSP names the local CDN and API, and the e2e user signs in with `POST /auth/login` and a Turnstile testing token.
1. **Anonymous single upload** with a Turnstile token. Without one, it's refused. The CDN bytes match (sha256). `files.localhost/<vanity>` returns the shell with a correct `#file-data`, and `&` is escaped as `&`.
2. **Signed-in chunked upload** of 30 MB. Four chunks go up concurrently and out of order, then `complete`, then a poll until `complete`. The CDN bytes match, and a `Range` request across a chunk boundary works.
3. **HTML filename** `</script><script>alert(1)</script>.png`.
   - The API turns `<`, `>` and `/` into `_` on upload. That's long-standing behaviour.
   - The raw name is then written to the database, and the shell is checked: the JSON escapes it, it adds exactly one `<script>`, `<script>alert(1)` appears nowhere live, the meta tags are escaped, and the CDN's `Content-Disposition` is encoded.
4. **Password.**
   - `PATCH visibility: password` gives the `locked` shell, with no media or name in the meta.
   - The CDN gives 401.
   - Unlock without Turnstile gives `CAPTCHA_INVALID`, and a wrong password gives `WRONG_PASSWORD`.
   - A successful unlock returns a token. The CDN gives 200 with `?t=`, and `/view` and `refresh` work with it.
   - Changing the password bumps `access_version`. The API refuses the old token at once. The CDN refuses it within the Worker's 30 s lookup cache, so the test polls.
5. **Private.**
   - The shell is `missing` (404), for bots too, and the CDN and `/view` give 404 without a token.
   - An owner pass gives 200 on the CDN via `?t=` and on `/view`, and its `url` uses `PUBLIC_URL`.
6. **Expiry.** `expires_at` is set in the past with psql, because the minimum `expires_in` is 1 h. The API forgets the file at once. The shell and the CDN show it as missing after the lookup cache expires, so the test polls.
7. **Bots.**
   - `TelegramBot` on a `link` file is redirected (302) to the CDN.
   - `Discordbot` gets the embed page, whose `og:image` is the CDN URL. Only Telegram is redirected among `*bot` agents, as before.
   - On a password file, neither bot nor `Accept: image/*` is redirected. They get the locked shell, with no media.
8. **Limits.** `GET /users/@me/limits` returns the anonymous and the signed-in values from contract §6.
