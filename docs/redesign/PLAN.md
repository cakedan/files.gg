# files.gg redesign plan

Status: **Milestones 1–7 built and committed on `redesign/milestone-3`** (2026-11-25); what's left is the launch itself, in [`LAUNCH.md`](LAUNCH.md). See §0.

Goal: move files.gg's viewer to work like nsb.gg's and its account area to work like notsobot.com's dashboard, while keeping files.gg's own identity: the green, the rounded "F" and `.gg`. Nothing is carried over from the old site (decided 2026-11-25): no data, no old links, no old API shapes; an old link gets the plain missing page.

---

## 0. Progress

| Milestone | Commit | Contract | What it added |
|---|---|---|---|
| 1. Foundations | `0e126d4` | (this plan) | Sanic API on psycopg 3, the hardened CDN Worker, the React app, Postgres 19 with backups, the new logo |
| 2. Storage and uploads | `bb22eed` | [milestone-2](contracts/milestone-2.md) | B2, single and chunked uploads, expiry, limits, link/password/private access, Turnstile, the local e2e stack |
| 3. Media and library | `d9240b5`, `7ed11a4` | [milestone-3](contracts/milestone-3.md) | Previews, players, the text viewer, albums, the file library, signed CDN URLs; the squashed schema, curated file types, executables blocked |
| 4. Trust & safety | `c63ddc3` | [milestone-4](contracts/milestone-4.md) | Scanning gates (PhotoDNA, ClamAV, Web Risk), NSFW, reports, appeals, the admin queue, the security review fixes |
| 6. Accounts | `9c82e0f` | [milestone-6](contracts/milestone-6.md) | Sessions, Discord identities, upload keys, premium, custom domains, view limits |
| 5. Conversion | `181f86e` | [milestone-5](contracts/milestone-5.md) | Conversions on RQ worker pools, document previews, Redis rate limits, guests, upload defaults, the home, changelog and legal pages |
| 7. Rollout | `61fa1ad`, `c839c4c` | [milestone-7](contracts/milestone-7.md) | Production compose, nginx, zero-downtime `ops/deploy.sh`, metrics, Prometheus, Grafana and alerts, the launch gates, [`LAUNCH.md`](LAUNCH.md); Discord sign-in made optional |

Milestone 6 was committed before 5. **Latest full verification** (2026-11-25, after Milestone 7): API 952 passed (1 opt-in network test skipped), web 1,134, Worker 655, e2e 44 steps and 961 checks on a fresh stack, `ops/smoke.mjs --uploads` 304 checks, the load test (404 uploads, no failures), the restore drill, five zero-downtime rollovers with no failed requests, and a browser pass. **Not deployed:** the launch steps are in [`LAUNCH.md`](LAUNCH.md).

The milestone sections below are the record of what each one found while it was being built.

### Milestone 1: foundations (built 2026-11-24, committed `0e126d4`)

| Part | What landed | Verified |
|---|---|---|
| **API** (`api/`) | **Sanic + psycopg 3** (ported from an interim Flask 3 upgrade; Flask, Peewee, gunicorn, gevent and requests are gone). Python 3.15, every dependency pinned, including transitive ones. The app refuses to boot without its secrets. Per-worker async pool, Snowflake lease, httpx client and storage. pydantic validation that keeps the old error shapes. `/openapi.json`. Numbered SQL migrations with an exact baseline. The Snowflake node-id lease fix. The Postgres jobs queue, a sync `worker` and the once-only scheduler. CORS allowlist. `/health`. Raw uploads stream to a temp file. **Client IP is trusted only with the worker's shared secret** (`api/utils/client_ip.py`). **Migration `0003`** (schema fixes 1, 2 and 4): daily view counts with a rotating-key IP hash, `timestamptz` reset columns (dual-write plus a sync trigger for the rollout), and `jobs.queue`. `0004` (dropping `file_views` and the old columns) waits in `migrations/pending/` for the following release. **Email via Postmark** (Mailgun removed). | 204 tests against Postgres 19 in Docker (`docker compose -f docker-compose.test.yml up --build --attach tests --exit-code-from tests`), including **85 golden-response tests** recorded from the Flask version, a real 3-worker server, 200-request concurrency, a 50 MB streamed upload, and IP-spoofing cases. |
| **CDN worker** (`cf-worker/`) | Sandbox CSP and security headers on every `cdn.files.gg` response. `inline` only for images, audio, video and plain text; everything else is `attachment`. HTML and all XML-family types forced to text. Filename cleaning (bidi, zero-width and control characters) with RFC 6266 headers. API requests carry `X-Filesgg-Client-Ip` and the `ORIGIN_SHARED_SECRET` header, and client-sent copies are stripped. CORS: credentialed with an allowlist for the API, `*` for the CDN, and range headers exposed for pdf.js. The proxy secret comes from `PROXY_SECRET` and fails closed, and the proxy no longer forwards its own token to third parties. | **Rebuilt on wrangler 4.168 with the ES module Worker format** (webpack 4, Mithril, `tools/` and `detritus-rest` removed; `cf-worker-router` 0.2.0). **209 tests**: unit, plus integration tests running the real Worker in workerd, and 41 page responses captured from the old build that the new one matches byte for byte (apart from `og:*` → `property=`). |
| **Web app** (`web/`) | Vite + React 19 + TypeScript + Tailwind v4. Viewer entry (≈78 KB gzipped, no dashboard code) with the nsb.gg boot states, the card, the image lightbox and dev fixtures. **PDF viewer** (pdf.js 6.5 in a lazy 145 KB chunk, plus its worker): text and annotation layers, lazy page rendering, search, thumbnails and outline, zoom, rotate, fullscreen, `#page=` deep links, a password prompt and an external-link interstitial. **Album page** (`/a/<vanity>`): grid, list and tracklist layouts, a lightbox carousel with URL sync, and an NSFW gate. Native video and audio renderers. Dashboard entry with the sidebar/drawer layout and placeholder sections, including Albums and Convert, plus a public `/convert` placeholder. Typed API client compatible with the old app's localStorage keys. Brand tokens and favicons. | 210 Vitest tests, typecheck, lint, build. Viewer entry +1.6 KB for all of this. PDF, album grid and tracklist checked in the browser at desktop and 375 px widths. |
| **Deploy** (`docker-compose.yml`, `nginx/`) | One-off `migrate` service, which `api` and `worker` wait on. Secrets are required through `${VAR:?}` (no more empty `SECRET_KEY`), now including `ORIGIN_SHARED_SECRET`. New `worker` service. API healthcheck. nginx overwrites `X-Forwarded-For`. | `docker compose config` with and without secrets. |

### Milestone 2: storage, uploads, expiry, limits, access (built 2026-11-24, committed `bb22eed`)

The exact cross-service formats are in [`contracts/milestone-2.md`](contracts/milestone-2.md).

| Part | What landed | Verified |
|---|---|---|
| **API** | S3 storage (aiobotocore and boto3; MinIO in tests); streaming single uploads; **chunked uploads** to S3 multipart with `finalize_upload`, de-duplication, quota reservations and reapers; **expiry** with read-time "expired = gone" and a reaper; **`get_limits()`** with the decided defaults and `/users/@me/limits`; **access control** (link, password and private, argon2id, generated EFF passphrases, unlock and refresh, `/view`, owner passes, `access_version`, password timing); **Turnstile** replacing reCAPTCHA; the internal lookup for the Worker; reserved vanities; configurable `PUBLIC_URL` and `CDN_URL`; dev tool `tools.create_user` (gated by `FILESGG_DEV_TOOLS=1`). `hash` is removed from every public response. Migrations `0004`, and `0005` (indexes `CONCURRENTLY`). | 249 tests, offline (Turnstile mocked; one opt-in live test). Golden responses unchanged except the deliberate `hash` removal. |
| **Worker** | Serves the new viewer and app from `web/dist` (static assets), with `HTMLRewriter` boot data, meta tags and CSP; SigV4 reads from B2 with a GCS fallback; signed-token checks on protected files (including album tokens through `albums[{id, access_version}]`); locked and missing shells that leak nothing to bots; configurable hosts. | 346 tests (unit, plus integration in workerd with a SigV4-checking mock S3). |
| **Web** | Lock screen (Turnstile, error states, stored and refreshed tokens, `#pw=` auto-unlock, `#t=` owner passes); the **Upload page** (chunked resumable uploads, access, expiry and password-timing pickers, Turnstile for anonymous uploads); a mock API for `npm run dev`. | 327 tests. Viewer entry +250 B. |
| **e2e** (`e2e/`) | A one-command local stack (`e2e/up.sh`: Postgres, MinIO, API, worker, `wrangler dev`, web build) on `*.localhost`, with named volumes only, and `e2e/run.mjs`. | 9 steps and 136 checks green. Also walked through by hand in a browser: anonymous upload with a generated password, then lock screen, wrong password, unlock (token expiry = the 1 h setting), reload via the stored token, the CDN without a token (401, `private, no-store`), and a `#pw=` link auto-unlock with the fragment stripped. |

**Found in the Milestone 2 checks (to do):**
- ~~**Mimetype tables are empty after the migrations.**~~ Fixed by the 2026-11-25 squash: `0002_mimetypes.sql` seeds 228 curated types, and the e2e seed file is gone.
- ~~**Access changes take up to ~30 s to reach the CDN.**~~ Decided in Milestone 3: a 5 s lookup cache.
- ~~**`#pw=` / `#t=` pasted into an already-open tab of the same file** leaves the password visible in the address bar.~~ Fixed on `redesign/milestone-3`: the viewer also handles `hashchange` (`watchFragmentSecrets`), strips the fragment and re-mounts the page with it.
- `test_three_workers_lease…` is flaky: a Sanic shutdown race. It was flaky before Milestone 2.
- Discordbot gets the embed page rather than a redirect to the CDN. That matches the old Worker; only Telegram is redirected, and protected files are never redirected.

**Before the first deploy** (now all in [`LAUNCH.md`](LAUNCH.md), which `ops/check-env.sh` enforces; kept for the record):
- **Check Cloudflare's request-body limit on the real zone** (Milestone 5, 2026-11-25): upload a file of exactly 100,000,000 bytes with an upload key through `api.files.gg`. It must succeed; ShareX and curl are promised 100 MB. If Cloudflare answers 413, its "100 MB" means 10⁸ bytes: set `PROXY_BODY_LIMIT_BYTES=100000000` (the cap becomes 98.95 MB) or move to a plan with a bigger limit.
- Set `SECRET_KEY`, `RPC_KEY`, `DATABASE_URL`, `ORIGIN_SHARED_SECRET` and `VIEW_HASH_SECRET` (compose now refuses to start without them). Generate the last with `openssl rand -hex 32`, and set the **same value** as the worker's `ORIGIN_SHARED_SECRET` binding.
- ~~Set `PROXY_SECRET` on the worker.~~ **`proxy.files.gg` is removed (decided 2026-11-25):** nothing in files.gg used it, and a shared-secret URL fetcher was a needless abuse risk. Delete the `PROXY_SECRET` Worker secret and the `proxy.files.gg` DNS record when deploying.
- Never share a Snowflake lease across a fork: each Sanic worker process leases its own in `before_server_start`.
- Users will notice: direct CDN links to PDFs and other non-media files now download instead of opening, and XML shows as text.

**Follow-ups found while building:**
- ~~Make psycopg2 cooperative under gevent~~: no longer applies after the Sanic and psycopg 3 port.
- ~~Seed the mimetype tables as a migration.~~ `0002_mimetypes.sql`.
- `to_dict` returns `extension: "unknown"` when there is none.
- ~~Evaluate peewee 4~~: Peewee is being removed.
- ~~The worker's npm scripts call `nodejs`~~ / ~~old zone-script upload~~: replaced by wrangler. **Before the first `wrangler deploy`:** remove the old unnamed zone-level Worker and its routes in the Cloudflare dashboard, add `www.files.gg/*` to `routes` if it was routed before, and set the `PROXY_SECRET` and `ORIGIN_SHARED_SECRET` secrets with `wrangler secret put`.
- ~~`files.gg/favicon.ico` and other root files must be routed before vanity matching.~~ Done in Milestone 2: `web/dist` files are served before any vanity lookup.

### Milestone 3: media, albums, library (committed `d9240b5`)

The exact formats are in [`contracts/milestone-3.md`](contracts/milestone-3.md).
| Part | What landed | Verified |
|---|---|---|
| **API** | `probe` / `derive` / `album_collage` on a `media` queue, in a sandboxed child process (rlimits, timeouts, ffmpeg protocol and format whitelists, no secrets). Pillow 13 and pillow-heif in a `worker` image target; the API image has no media tools. Albums, the owner library, bulk actions, album passwords, signed CDN URLs, and one snake_case payload shape. | 230 tests (1 opt-in skip). |
| **Worker** | Signed-URL verification, `/previews/<kind>/<vanity>`, album collage and streaming ZIP, album shells, og tags from previews. The Mithril frontend and every GCS path are removed. | 403 tests, including the signing vectors and ZIPs checked with JSZip and `unzip -t`. |
| **Web** | Players (speed, keep pitch, shortcuts, saved volume), the peaks seek bar, the Shiki text viewer with `#L` anchors, HEIC `display` previews. Dashboard: Files, Albums editor, Overview, upload-to-album. Signed URLs used as given, swapped near expiry. | 514 tests. Viewer entry −0.6 KB gzip. |
| **e2e** | Media made by the worker container's own ffmpeg, previews, path-bound signatures (a signature can't be reused on another path or file), album grants, the ZIP checked with `unzip`, and the library. | 13 steps and 221 checks green. Browser: video page, album pages (public and password via `#pw=`), and the dashboard with signed thumbnails. |

**Found in the Milestone 3 checks (to do):**
- ~~**The Worker's 30 s lookup cache.**~~ **Decided 2026-11-25: 5 s.** Revocation, expiry, deletes and album changes reach the CDN within about 5 s. In exchange, the API sees roughly one lookup per viewed file, per Cloudflare location, per 5 s.
- **One unexplained 503** on the first successful unlock after a fresh stack start. It came through the local Worker proxy, with nothing in the API log, and 90 repeats didn't reproduce it. Watch for it in staging.
- **Bulk change-access can't clear a password expiry** ("Never"). Changing one file at a time can.
- **Overview's "expiring in 7 days"** scans the first 100 temporary files, because the library has no `sort_by=expires`.
- **`app.css` duplicates a few `viewer.css` media classes**, so the two have to be kept in step.
- **An upload that de-duplicates onto a hash at the instant `delete_blob` removes it** fails with a foreign-key error. This needs a row lock shared by finalize and `delete_blob`.
- **`e2e/down.sh` used to fail silently** when `.env` lacked a newly required variable. Fixed: it now tears down by project name and checks that the volumes are gone.

**Milestone 4 follow-ups:**
- The viewer shows all three Web Risk "learn more" links. The API now sends `link_warning_types` (threat types per URL), so it can show just the matched type's link, as Google's warning rules prefer. *(Milestone 7: the links now go to files.gg's own page, `files.gg/help/link-warnings`, a section per threat type; showing only the matched type is still to do.)*
- `lib/reports.ts` and `lib/api.ts` both define the report reasons and DMCA types; unify them.
- The DMCA good-faith and perjury statements in the report and appeal forms need legal review.
- ~~A Terms page at `/legal/terms` is linked from removed-file pages and doesn't exist yet.~~ Planned in Milestone 5 with the Privacy Policy and the changelog ([`contracts/milestone-5.md`](contracts/milestone-5.md) §19), as drafts with placeholders pending legal review.
- ~~Scanner efficiency (found by the security review):~~ *Milestone 7:*
  - ~~each blob is read from B2 about 4 times across scan, probe and derive;~~ each job (scan, probe, derive, document preview, conversion) now reads its blob with one GetObject (boto3's `download_file` split anything over 8 MiB into 8 MiB ranged GETs: 13 requests for 100 MiB, 128 for 1 GiB). The scan, probe and derive jobs still read it once each, in different services;
  - ~~the ONNX model is loaded and re-hashed in every scan child.~~ The sandboxed child preprocesses the images; the scanner process loads the model once and classifies the child's array.
  
  Sharing one local copy across the scan → probe → derive chain would need a scratch volume shared by the `scanner` and `worker` services; not done.
- Security review (2026-11-25) leftovers:
  - ~~**W1:** server-cut Web Risk links rendering live.~~ Fixed: the client reduces links the server's way, and a link is flagged on a match or prefix match, with a host boundary.
  - ~~**W2:** download-confirmation gaps.~~ Fixed: middle-clicks, per-item album links and "Download all" with any warned item ask first, and PDF middle-clicks get the "leaving files.gg" notice.
  - ~~The admin UI has no "retry" for `scan_failing` holds.~~ Fixed: a `retry_scan` action (audited; the usual permission, child-safety and own-content checks) resets the failure count, resolves the `scan_failing` flag and queues a fresh scan; the file detail carries `scan_stuck`, and the admin UI offers "Retry the scan" only then.
  - ~~Bans aren't checked for staff targeting themselves.~~ Fixed: staff can't create or lift a ban on their own device or network (this request's guest and IP, and those on their own uploads and reports), nor one taken from their own upload or report. A staff member sharing a network with an abuser (office, CGNAT) needs a colleague to ban or lift it.
  - ~~The case list still shows cases about a staff member's own content.~~ Fixed: the case list, the summary counts and the staff badges leave them out (opening or acting on them was already refused).

**Decided 2026-11-25:**
1. **No backward compatibility, and a fresh start.** No data from the old databases or storage is migrated. Nothing is kept for old clients:
   - old API response shapes, numeric error codes and the recorded golden tests;
   - the old `/files` list and other legacy routes;
   - the Mithril frontend;
   - the GCS fallback (blobs are copied to B2 by the import);
   - old ShareX configs.
   
   Link formats are ours to choose. With no old data to carry, the migrations can be squashed into one clean schema, dropping the dual-write trigger and the old columns.
2. **Signed URLs instead of `?t=`:** the API signs each CDN URL for one path and an expiry, over the file's (or album's) `access_version`, so a password change still kills them. The browser's unlock token only ever talks to the API.
3. **CDN paths:**
   - `cdn.files.gg/files/<vanity>.<ext>`;
   - `cdn.files.gg/previews/<kind>/<vanity>.<ext>?v=…`;
   - `cdn.files.gg/albums/collage/<vanity>.webp?v=…`;
   - `cdn.files.gg/albums/download/<vanity>.zip`.
   
   The kind comes before the vanity, so a vanity named `thumb`, or one with slashes, can't be misread. No ids in URLs.
4. **Milestone 4 scanning** (`contracts/milestone-4.md` §4.1, §5.2, §5.6): the NSFW model is Marqo's ViT-Tiny 384 (`nsfw-image-detection-384`, Apache-2.0); ClamAV uses its official signatures only; abuse.ch (MalwareBazaar lookups, URLhaus signatures) is noted for the future; and the worker image stays on Python 3.14 until `onnxruntime` ships cp315 wheels.

**Schema squashed (2026-11-25):**
- `api/migrations/` is now `0001_schema.sql` (the whole schema, written cleanly) and `0002_mimetypes.sql` (228 curated types, 456 extensions, with no executables or malware-style types).
- Gone: `file_views`, the users timestamp-sync trigger and its integer columns, `storage_backend`, `file_hashes.width/height/duration` (the probe's `media` holds them), and redundant indexes.
- `varchar(n)` became `text` with CHECKs.
- **The runner refuses a database with a different history** (for example one migrated before the squash), instead of warning and running new code on the old schema. Recreate such databases.
- JSON, notebooks, NDJSON and SRT subtitles open in the text viewer.
- **No executables, by name, type or content** (`api/utils/filetypes.py`, error `FILE_TYPE_NOT_ALLOWED`):
  - the filename's extension (an `.exe` sent as `application/octet-stream` used to be stored as `.bin`);
  - the declared mimetype;
  - the first 64 KiB of the bytes: Windows PE (`MZ` plus a real `PE\0\0` header), ELF, Mach-O, Java class and `.lnk`.
  
  Checked on single uploads, at `POST /uploads`, at chunk 0 (failing the session early), and again at finalize. Executables inside archives are Milestone 4's scanning.
- Earlier sections that mention `0003`, `0004` and so on describe how the schema got here, not files that still exist.
- **Still open:**
  - real MPEG-TS video (`video/mp2t`) is refused, because macOS browsers declare TypeScript `.ts` files as `video/mp2t`;
  - account passwords move to argon2id with Milestone 6.

**Version policy** (decided 2026-11-24: "latest everything"):
- **Everything starts on the latest stable release, pinned exactly:** Docker images by digest with a date comment (as in `notsobot.api`), Python and npm packages by exact version with lockfiles.
- **Current versions:** PostgreSQL 19.0, Python 3.15.2, nginx 1.31, restic 0.20.0, Ofelia 0.3.23, Node 26, wrangler 4.168; the Sanic, psycopg and pydantic lines are all at their newest.
- **Held back, only where the newest release breaks another latest-version dependency:**
  - TypeScript stays on **6.0.3** (7.0.2 is out). `typescript-eslint` 8.74, its latest, only supports TypeScript up to 6.0. Move to 7 when typescript-eslint supports it.
  - `multidict` stays on **6.9.1** (7.2.1 is out), because Sanic 25.12.1, its latest, requires `multidict<7`.
- **Staying current:** bump minor versions and digests regularly; they don't need migrations. Plan major upgrades as they ship. Postgres 19 is supported until 2031-11.

**Also found while building:**
- Hashing during streamed uploads runs on the event loop; move it to an executor, since `hashlib` releases the GIL. Multipart uploads are still held in memory. Milestone 2's chunked uploads replace both.
- Sanic bug: a SIGTERM within about a second of startup can hang the main process (reproduced on a bare Sanic app). Docker's SIGKILL covers it.
- Sanic percent-encodes `@`, so `/users/@me` is matched as `/users/<me>`, and OpenAPI shows it that way.
- `isEvalSupported` was removed in pdf.js 6 (it has no eval path); `enableScripting: false` is still set.
- ~~Restrict the origin to Cloudflare.~~ Milestone 7: Authenticated Origin Pulls in nginx, and a firewall allowing only Cloudflare's ranges (`ops/cloudflare-ips.sh`, `ops/nftables.conf.example`).

**Build order** (as proposed; all done, with Milestone 6 before 5):
1. **Milestone 2: storage and uploads.** B2, streaming and chunked uploads, expiry and limits, and the worker serving the new viewer shell with inlined file and album data. It also includes **access control** (link, password and private, with signed CDN tokens), because it changes how the CDN serves every byte, and is cheaper to build in from the start than to retrofit.
2. **Milestone 3: media.** `probe` / `derive` (thumbnails, posters, covers, waveforms), players and the text viewer, and the album API and dashboard editor.
3. **Milestone 4: trust & safety.** Scanning gates, NSFW, the report system and the admin queue. **Required before public launch.**
4. **Milestone 5: conversion.** It needs the Milestone 3 pipeline and the Milestone 4 scanning.
5. **Milestone 6: accounts.** Discord identities, unique usernames, upload keys and the dashboard Settings page. Also **premium entitlements** (staff-granted for now) and **custom domains**, which need the Milestone 2 Worker viewer shell. This can run alongside Milestones 3–5.
6. **Milestone 7: rollout.** A fresh launch on the new stack: a new database and a new B2 bucket, with nothing carried over from the old site.

## 1. Research findings

### 1.1 nsb.gg (the file viewer)

| Area | What nsb.gg does |
|---|---|
| **Page boot** | The server returns a tiny HTML shell: `<div id="root" data-page="…" data-state="…">`, plus the file's metadata inlined as `<script id="file-data" type="application/json">`. The client reads that JSON straight away, so opening a file never waits for a second API call. |
| **States** | `home` (a centred brand card), `file`, `missing` ("doesn't exist or has expired"), and `unavailable` (the backend can't be reached; it says so instead of showing a 404). |
| **Kinds** | `image`, `video`, `audio`, `text`, `pdf`, and `file` (anything unknown, with a "too large to preview" fallback). |
| **Image** | Checkerboard background for transparency. Click to open a full-screen lightbox, Esc to close. Animated images get frame decoding with an error fallback. |
| **Video/audio** | Custom player: speed from 0.25× to 2×, a "keep pitch" toggle, fullscreen, and h:mm:ss once a file is over an hour. Mute and volume are saved to localStorage (`nsb.muted`, `nsb.volume`). |
| **Layout** | A single centred card: media on top, then the filename, "Uploaded \<relative\>", the expiry if there is one, and **Copy Link** / **Download** buttons. CSS variables `--media-max-width/height` cap the size, and the frame has edge handles to resize it. |
| **Look** | Discord-modern dark greys (`#2b2d31` theme colour), Tailwind v4, lucide icons, React 19. |
| **Embeds** | Full OpenGraph tags rendered on the server in the same response as the shell. |

### 1.2 notsobot.com (the dashboard and uploads)

| Area | What notsobot.com does |
|---|---|
| **Stack** | Vite + React, lazy-loaded per-page chunks, TanStack Query for server state, i18n, `DashboardLayout` (sidebar on desktop, drawer on mobile). |
| **Files list** | `GET /users/@me/files?query&sort_by&temporary&offset&limit=25` returns `{ count, items, size, total: { count, size } }`. The `size`/`total` fields drive the "N files · X MB used" summary, with separate "matched" and overall numbers while you search. |
| **Item shape** | `id`, `filename`, `mimetype`, `metadata { size, width, height, duration }`, `expires_at`. |
| **Table** | Checkbox, thumbnail + name, link (copy), size, uploaded, actions. Select all, "N selected", a clear button, and pagination. |
| **Delete** | Single: `DELETE /users/@me/files/:id`. Bulk: `POST /users/@me/files/delete { file_ids }`. The cache is updated optimistically, so the list and storage totals change right away, then it refetches. |
| **Uploads** | Multipart `FormData` (`file`, plus `name` where needed), 120 s timeout. The server returns typed error codes (`FILE_TOO_LARGE`, `UNSUPPORTED_UPLOAD_TYPE`), which the client maps to friendly messages. |
| **Filters** | Free-text search, sort, and a "temporary" filter for files that will expire. |

> Caveat: I could only read notsobot.com's public JS bundles. The logged-in dashboard sits behind Discord OAuth, so I haven't seen it rendered. A logged-in session in the browser pane would let me confirm the visuals.

### 1.3 files.gg today (gaps that matter for this redesign)

- **Stack.** Flask 1.0 on Python 3.7, Peewee, Postgres, and GCS. The frontend is Mithril 1 with webpack 4 and node-sass. Everything dates from early 2019.
- **Storage.**
  - Content is de-duplicated by hash, which is good.
  - `width`, `height` and `duration` live on `FileHash` (`api/models/__init__.py:101-103`), but `FileHash.create` never sets them (`files.py:271`). Embeds and thumbnails therefore have no dimensions. Probe results belong per hash.
  - Blobs are uploaded with `publicRead` under `files/<hash.id>` (`files.py:281`), and `to_dict` exposes `hash`. A file you "delete" therefore stays reachable straight from the bucket.
- **Delete is a stub** (`api/views/files.py:324`). There's also no rename, search or bulk action, and `SortTypes` in `dashboard.files.js` is unused.
- **Uploads.** The whole file is read into memory (`files.py:262`), and there's no server-side size check (TODO at `files.py:198`).
- **Tokens.**
  - Tokens are invalidated only by a password reset (`api/utils/helpers.py:20-21`), and logout is a no-op (`api/views/auth.py:73-76`).
  - The ShareX config embeds the raw token.
- **There is no `created_at`.** "Uploaded" dates have to come from the Snowflake id.
- **No migration tooling.** `models/__init__.py:168-176` just calls `create_tables` when it is imported.
- **Secrets.** There are hardcoded fallbacks (`SECRET_KEY='extremely-secret'`, the proxy secret `'lol'`), and `werkzeug.contrib` is gone in Werkzeug 1.x.
- **OpenGraph tags.** These are emitted with `name=` instead of `property=` (`cf-worker/worker/domains/stable.js:36`).
- **The API won't build fresh.** Werkzeug is unpinned, so a fresh build pulls Werkzeug 3, which no longer has `werkzeug.contrib`; the import at `app.py:6` then breaks.

### 1.4 Compatibility constraints (must not break)

> **Superseded 2026-11-25:** no backward compatibility and no migrated data (§0, "Decided 2026-11-25"). Items below still apply only where they describe current behaviour (for example multi-segment vanities and reserved paths).

1. **Multi-segment vanities.** ShareX uploads with `vanity: '3-5/3'`, so live URLs look like `files.gg/abcd/xyz.png`. Both routers take everything before the first `.` (`stable.js:208`, `cdn.js:21`), so `<vanity>` and `<vanity>.<anything>` must both keep resolving.
2. **Reserved paths.** `app` and `api` aren't in `blacklisted_ids` (`files.py:106-113`), so a user could already own `files.gg/app/…`. Albums add `a` (`files.gg/a/<vanity>`).
   - Before launch: query `vanity = 'app' OR vanity LIKE 'app/%'` (and the same for `api` and `a`).
   - Add all three to the blacklist.
3. **Bot and embed routing.** `stable.js:218-243` sends these straight to the CDN:
   - ShareX and Telegram clients;
   - requests with no Accept-Language;
   - requests with `Accept: image/*`.

   The new shell must keep this exactly, or every existing embed breaks.
4. **CDN rules:**
   - Keep `?download` and `?force-text` (`cdn.js:35,40`).
   - Keep forcing HTML, SVG and XHTML to `text/plain` (`cdn.js:14-18`). This is the XSS guard.
   - Switch `content-disposition` to `filename*=UTF-8''…`.
5. **Existing ShareX tokens** carry only a user id (`auth.py:69`). `token_version` must treat a missing version as 0, or every `.sxcu` people already have stops working.
6. **localStorage keys** are per-origin, so the beta subdomain won't see them:
   - `token`
   - `fingerprint` (anonymous files!)
   - `savedVolume`
   - `textType`

   Either run the beta on the same origin (for example `files.gg/app` behind a flag), or add a one-time handoff.
7. **Dashboard routes.** `/dashboard`, `/dashboard/files`, `/dashboard/files/:id…` and `/dashboard/configs` (`application.js:81-85`) all need redirects.
8. **Mimetypes are defined in four places that disagree:**
   - the DB tables (no seed in the repo);
   - `frontend/…/utils/mimetypes.js`;
   - `stable.js:198-202`;
   - `cdn.js:14-18`.

   Uploads reject anything missing from the DB, so the new schema needs a curated mimetype seed, with the API as the single source of truth.

---

## 2. Target architecture

```
                 ┌───────────────────── Cloudflare Worker ─────────────────────┐
 files.gg/<v>  → │ stable: HTML shell + inlined file JSON + OG tags (no SPA wait)│
 files.gg/app/*→ │ dashboard SPA (Workers static assets)                         │
 cdn.files.gg  → │ cdn: signed read from B2, edge cache, Range, disposition      │
 api.files.gg  → │ api passthrough                                              │
                 └───────────────┬──────────────────────────────┬───────────────┘
                                 │                              │ read-only key
                        Sanic API (async)              Backblaze B2 (private bucket)
                        Postgres                        files/<hash_id>, thumbs/<hash_id>.webp
                                 └──── write/delete key ────────┘
```

**Frontend (new): React 19, Vite, TypeScript, Tailwind v4, TanStack Query, react-router, lucide.** This matches nsb.gg and notsobot.com, so their patterns carry over directly. It builds two entry points:

- `viewer`: a small bundle for `files.gg/<vanity>`, booted from the inlined JSON in the nsb.gg style.
- `app`: the dashboard, with lazy-loaded routes.

**API: port to Sanic (async), decided 2026-11-24.** Milestone 1 first upgraded Flask in place. Before anything was committed, Dan chose Sanic, because the API is I/O-bound: uploads stream to B2, and most requests are a DB query plus a storage call.
- **Server:** Sanic's own server with N worker processes. No gunicorn or gevent.
- **Database: psycopg 3**, replacing Peewee. It is async in the API (one `AsyncConnectionPool` per Sanic worker) and sync in the `worker` and `migrate` processes, which stay synchronous on purpose: their jobs are CPU-bound. A thin `api/db/` layer (dataclasses plus query functions) replaces the ORM, and the migrations were already plain SQL.
- **Validation:** sanic-ext with pydantic models. Errors keep the existing `ApiError` shape.
- **API description:** OpenAPI is served at `/openapi.json`. It can later generate the `web/` client's TypeScript types.
- **Outbound HTTP:** `httpx` (async).
- **B2 (Milestone 2):** aiobotocore.
- **Compatibility:** routes and response shapes stay byte-identical to the Flask version, enforced by golden-response tests.

### 2.1 Multi-server readiness

Decided 2026-11-24: the API will run on several servers. Everything in this plan must work when any request can land on any server.

1. **Stateless requests.** These are already server-independent, so keep them that way:
   - tokens (signed);
   - OAuth `state` (signed);
   - rate limits and anonymous caps (computed in Postgres);
   - chunked uploads (parts go to B2, metadata to Postgres; see Phase 1).

   No in-process caches or sessions. The only local files allowed are temp files that live within a single request.
2. **Snowflake IDs: fix before running a second server. This bug exists today.**
   - Each process sets its worker id to `os.getpid() & 31` (`api/app.py:42`, `api/utils/generators.py:30`), and the datacenter id is hard-coded to `0` (`app.py:44`).
   - Containers start their process ids at the same low numbers, so two API containers *will* hand out identical worker ids, producing duplicate primary keys and failed inserts.
   - Even the 4 workers on one host collide whenever two process ids differ by a multiple of 32.
   - **Fix:**
     - Treat datacenter + worker (10 bits) as one **node id**, leased per process from Postgres at boot: a `snowflake_nodes` table with a heartbeat, where a lease expires after a few minutes without one.
     - Refuse to start if no node id is free.
     - Also reset `sequence` each millisecond, and wait for the next millisecond when it overflows, instead of letting it wrap.
3. **Background jobs:**
   - A Postgres-backed `jobs` table, claimed with `SELECT … FOR UPDATE SKIP LOCKED`. This needs no new infrastructure, and jobs are retried if a worker dies.
   - Jobs: `finalize_upload`, `probe`, `derive`, `scan`, `delete_blob`. `convert` jobs go on their own `convert` queue, run by a separate **`converter`** service (same image, scaled independently), so heavy transcodes never delay the others.
   - They run in a separate **`worker`** service: the same image with a different command, scaled independently of the web servers. ffmpeg and Pillow load only there.
4. **Scheduled tasks run once, not once per server.** These are:
   - the expiry reaper;
   - blob garbage collection;
   - the abandoned-upload reaper;
   - the `snowflake_nodes` lease cleanup.

   A single scheduler loop in the `worker` service takes a `pg_try_advisory_lock` per task before running it, so extra worker replicas just skip.
5. **Database connections:** Sanic workers × servers × pool size multiplies the number of Postgres connections. Keep each worker's `AsyncConnectionPool` small (for example max 10), and put **PgBouncer** (transaction pooling) in front of Postgres once there are several servers. psycopg 3 needs `prepare_threshold=None` behind transaction pooling.
6. **Health and load balancing:**
   - Rename the existing `/google/health-check` to `/health`, and have it check the database and the B2 credentials.
   - Any round-robin load balancer works, because nothing depends on sticky sessions.
8. **Postgres runs in Docker, next to files.gg, the same way as `notsobot.api`** (decided 2026-11-24; read from `notsobot/notsobot.api`). It replaces Cloud SQL. Built and in `docker-compose.yml`.
   - **Image:** `postgres:19.0`, pinned by digest with a date comment. **PostgreSQL 19 is the latest major** (released 2026-11-19, supported until 2031-11). NotSoBot is on 18.7; files.gg starts on 19 so it won't need a major upgrade for years. Minor releases (19.1, 19.2…) are drop-in: bump the digest, no data migration. The API tests run on it too: 196 passing.
   - **Port:** published on **localhost only** (`${POSTGRES_BIND:-127.0.0.1}`), because Docker bypasses ufw. Set `POSTGRES_BIND` to a private-network address when API servers on other hosts need it, firewall it, and use TLS with `pg_hba.conf` limited to those hosts.
   - **Data and config:** data in `./.data/postgres` (git-ignored); config in `postgres/postgres.conf`, mounted like NotSoBot's.
   - **PgBouncer** runs as a container next to it once there's more than one API server (item 5).
   - **Single primary for now.** A streaming-replication standby is the next step if downtime becomes a concern.
   - **Backups match NotSoBot's `backup-db` exactly** (`backup/`, see `backup/README.md`):
     - **Encryption:** **restic** encrypts everything with `DB_BACKUP_RESTIC_PASSWORD` before upload, so the bucket only ever holds ciphertext.
     - **How:** `pg_dump -Fc -Z0` is streamed straight into restic (nothing touches disk), plus `pg_dumpall --roles-only`. restic deduplicates day to day.
     - **Where:** a **separate B2 bucket in the US** (`S3_BUCKET_DB_BACKUP`), using a **backup-only application key**. The API's key can't read or delete backups. The bucket lifecycle must be set to "keep only the last version", or pruning never frees space.
     - **When:** **`scheduler-ofelia`** runs `backup all` daily at 02:00 and `backup check` (rereads 5% of the stored data) on Sundays at 05:00, from Docker labels on `backup-db`.
     - **Retention:** 14 daily plus 52 weekly, a year (`DB_BACKUP_KEEP_*`; owner, 2026-11-25: "forever" conflicted with the Privacy Policy and GDPR's storage limitation).
     - **Monitoring:** optional healthchecks.io pings (`DB_BACKUP_HEALTHCHECK_URL`).
     - **Verified locally:** a first backup (creating the repository), the snapshot list, restore, `pg_restore` into a fresh database with the data intact, and the weekly check, all against a local restic repository in throwaway volumes.
   - **What this means for recovery:** these are daily logical dumps, not continuous archiving, so a restore can lose **up to 24 h** of database changes. The same trade-off NotSoBot makes. Two consequences:
     - **Stored files aren't in the database backup.** Blob garbage collection must wait **at least 48 h** (`BLOB_GC_GRACE`) before deleting a blob nothing references, so a database restored from yesterday never points at blobs that were already deleted.
     - Uploads made between the last backup and a restore would leave orphaned blobs, which the reaper cleans up.
   - **Ofelia's Docker socket:** Ofelia needs read-only access to the Docker socket to run jobs inside `backup-db`, as in NotSoBot. That socket effectively grants root on the host, so the Ofelia image stays pinned by digest.
9. **Deploys:**
   - Run migrations as a one-off release step before new servers start; never call `create_tables` when a server boots.
   - API servers must tolerate the old and new schemas during a rolling deploy: add columns first, remove them in a later release.

---

## 3. Phases

### Phase 0: Decisions (blocking)

- [x] **Auth: decided 2026-11-24.** Support "Log in with Discord", but **keep users decoupled from it**. A files.gg `User` is its own account. Discord is just one linked *login identity* (see "Accounts and identities" under Phase 1).
- [x] **Storage: decided 2026-11-24.** Move from GCS to **Backblaze B2**, as NotSoBot does. See "Storage on Backblaze B2" under Phase 1.
- [x] **Expiring files: decided 2026-11-24.**
  - Any upload can set its own expiry.
  - Anonymous uploads *always* expire, after **at most 21 days**.
  - See "Expiry" under Phase 1.
- [x] **Storage limits: decided 2026-11-24.**
  - Each user gets a storage limit now.
  - Paid plans come later, so limits are resolved through a single function that plans can plug into. See "Limits" under Phase 1.
- [x] **Frontend: decided 2026-11-24.** Rewrite in **React**, using the stack under §2.

### Phase 1: API foundations

- [x] Upgrade to Python **3.15** (latest). **Pin every dependency.** *(Milestone 1)*
- [x] **Port the API to Sanic and psycopg 3** (see §2). *(Done: 183 tests, 85 golden responses match.)* Done when the 65 Milestone 1 tests are ported and passing, and the golden-response compatibility tests match the Flask version exactly.
- [x] Adopt migrations: a small numbered-SQL runner (`python -m migrate`). `create_tables` no longer runs when the models are imported. *(Milestone 1)*
  - `File`:
    - `expires_at timestamptz NULL`
    - `deleted_at NULL`, for a soft delete that runs before blob garbage collection
    - a denormalised `size`, for sorting by largest
  - `FileHash`:
    - `media jsonb` (probe output), `framecount`, `playable`, `processing_state`
    - `probed_at`, `derived_at`
    - new table `file_hash_assets`: `(hash_id, kind)` as the primary key, plus `key`, `width`, `height`, `size`, `state` (see "Media processing")
  - `User`:
    - `token_version int DEFAULT 0`
    - `storage_limit_override bigint NULL` (see "Limits")
  - New tables for multi-server operation (see §2.1 and "Chunked, resumable uploads"):
    - `upload_sessions`:

      | Column | Type | Notes |
      |---|---|---|
      | `id` | snowflake | |
      | `owner_user_id` | | NULL for anonymous |
      | `owner_guest_id` | | |
      | `filename` | | |
      | `size` | | |
      | `chunk_size` | | |
      | `expires_in` | | |
      | `b2_upload_id` | | the B2 multipart upload id |
      | `status` | | `open` / `processing` / `complete` / `failed` |
      | `file_id` | | NULL until complete |
      | `created_at` | | |
      | `expires_at` | | |

    - `upload_parts`: `(session_id, index)` as the primary key, plus `etag`, `size` and `received_at`.
    - `jobs`: `id`, `queue` (added in `0003`, schema fix 4), `kind`, `payload jsonb`, `run_at`, `attempts`, `locked_by`, `locked_at`, `last_error`, `done_at`.
    - `snowflake_nodes`: `node_id smallint` as the primary key, plus `holder` and `heartbeat_at`.
    - `albums` and `album_files` (see "Albums"), with indexes:
      - `album_files(file_id)`, so deleting a file can find and remove its memberships;
      - `albums(owner_user_id, updated_at DESC)`;
      - a partial index on `albums(expires_at)`.
    - `conversions` (see "File conversion"):

      | Column | Notes |
      |---|---|
      | `id` | |
      | `owner_user_id` / `owner_guest_id` | |
      | `source_file_id` | |
      | `target` | |
      | `options jsonb` | |
      | `recipe_hash` | |
      | `status` | `queued` / `running` / `succeeded` / `failed` / `cancelled` |
      | `progress` | |
      | `output_file_id` | |
      | `error_code` | |
      | `cpu_seconds` | |
      | `created_at` / `started_at` / `finished_at` | |

    - `conversion_cache`: `(source_hash_id, recipe_hash)` as the primary key, plus `output_hash_id`.
    - **Access** (see "Private and password-protected files"), on both `File` and `albums`:
      - `visibility` (`link` / `password` / `private`, default `link`)
      - `password_hash NULL` (argon2id)
      - `access_version int DEFAULT 0`
      - `show_name_when_locked bool DEFAULT false`
      - `unlock_ttl int NOT NULL DEFAULT 3600` (seconds) and `password_expires_at timestamptz NULL` (see "Password timing")
    - `unlock_attempts`: `(target_type, target_id, ip_hash, window_start)` as the primary key, plus `count`, for rate limiting. Old windows are cleaned by the scheduler.
    - `File.derived_from_file_id NULL`, indexed, so a takedown removes derived outputs too.
    - drop `discriminator`, add `display_name NULL` and `needs_username bool`, and add a unique index on `lower(username)` (see "Unique usernames")
    - `email` becomes nullable, and the unique index becomes partial (`WHERE email IS NOT NULL`), so a Discord-only account is valid
    - no `discord_id` column on `User`; identities go in their own table (below)
  - Indexes on `files`:
    - `(user_id, id DESC)`
    - `(guest_id, id DESC)`
    - `(user_id, mimetype_id)`
    - `(user_id, size)`
    - `(hash_id)`
    - a partial index on `(expires_at)`
    - a `pg_trgm` GIN index on `lower(filename)`
- [x] **Schema fixes from the database review** (decided 2026-11-24). *(Fixes 1, 2 and 4 built as `0003`; 196 tests. Fix 3 applies when those tables are created.)* Fixes 1, 2 and 4 change existing tables, so they ship as migration `0003` now. Fix 3 is a rule for tables that don't exist yet.
  1. **Replace `file_views` with daily counts.** Today it has one row per view, numbered with a 32-bit `SERIAL` (it runs out at about 2.1 billion), and it keeps the **raw IP forever**.
     - **New table `file_view_days`:** `(file_id, day)` as the primary key, plus `views` and `unique_views`. One row per file per day, bumped with `INSERT … ON CONFLICT DO UPDATE`.
     - **New table `file_view_seen`:** `(file_id, day, ip_hash)` as the primary key, used only to decide whether a view is unique that day.
       - `ip_hash` is an HMAC-SHA-256 of the IP using a key that **rotates daily** and is never stored with the data, so yesterday's hashes can't be linked to an IP.
       - The scheduler deletes rows older than 2 days.
     - **`files.view_count`** stays as the cached total the API returns (no response change). It counts **unique views per visitor per UTC day**. This was decided 2026-11-24: the old logic counted each IP once ever, and keeping that would need a permanent, linkable per-visitor hash, which is what this fix removes. Returning visitors count again on later days.
     - **Migration:** `0003` fills `file_view_days` from the existing `file_views` rows, grouped by day, and doesn't copy IPs. The API switches to the new tables in the same release. `0004`, one release later, **drops `file_views`**, deleting the stored raw IPs. It's split so a rolling deploy never runs code against a missing table (§2.1 item 7).
  2. **One timestamp style.**
     - Every new column is `timestamptz`.
     - The old plain-number columns move over: `users.last_email_reset` and `users.last_password_reset` gain `…_at timestamptz` twins in `0003`, filled from the old values. The code reads and writes the new columns, and `0004` drops the old ones.
     - `file_views.timestamp` goes away with fix 1.
     - Snowflake ids remain the source for "uploaded at", so no `created_at` is backfilled on `files`.
  3. **Targets get real foreign keys, never `type` + `id`.** Applies to `reports`, `moderation_actions`, `content_flags`, `user_warnings` and `unlock_attempts`.
     - **Instead of `target_type` + `target_id`:** separate nullable FK columns (`file_id`, `album_id`, `user_id`), plus a `CHECK (num_nonnulls(file_id, album_id, user_id) = 1)` so exactly one is set.
     - **Bug reports** have no target, so their check allows zero.
     - **`ON DELETE` choices:**
       - `SET NULL` for `moderation_actions`, which keeps the audit trail, so its check becomes "≤ 1";
       - `CASCADE` for `unlock_attempts`, `content_flags` and `album_files`.
     - **Benefits:** the database guarantees the target exists, joins are plain, and each FK gets its own index.
  4. **Job queues.** `jobs` gains `queue text NOT NULL DEFAULT 'default'`, and its runnable-jobs index becomes `(queue, run_at, id)` for unfinished jobs.
     - Workers claim from a list of queues: `python -m worker --queues default` and, later, the `converter` service with `--queues convert`.
     - `enqueue()` takes a `queue=` argument.
     - The scheduler's marker rows use a `scheduler` queue nobody claims from, so they can never be picked up as work.
- [ ] **Accounts and identities.** Discord is a login method, not the account.
  - New table `user_identities`:

    | Column | Type | Notes |
    |---|---|---|
    | `id` | snowflake PK | |
    | `user_id` | FK → users | |
    | `provider` | text | `'discord'` now; `'github'` or `'google'` later need no schema change |
    | `provider_user_id` | text | the Discord user id |
    | `display_name` | text | cached from Discord, for display only |
    | `avatar` | text | cached from Discord, for display only |
    | `created_at` | timestamptz | |
    | `last_used_at` | timestamptz | |

    Unique constraints: `(provider, provider_user_id)`, and `(user_id, provider)` (one Discord per account).
  - **Store no Discord OAuth tokens.** The `identify` scope is only needed during the callback, so exchange the code, read `/users/@me`, and discard the token.
  - Flows:
    1. **Log in with Discord, identity already linked:** issue a files.gg token for the linked `user_id`.
    2. **Log in with Discord, identity unknown:** create a new files.gg `User` with its own username (pre-filled from the Discord name, but editable and independent). Claim the guest's files as the email signup does.
    3. **Link Discord** from Settings while logged in. If that Discord account is already linked to another files.gg user, refuse; never merge silently.
    4. **Unlink Discord:** allowed only if the account still has another way in (a password with a verified email, or another identity). This avoids locking the user out.
  - The files.gg username, avatar and email never sync from Discord after creation. Renaming yourself on Discord changes nothing on files.gg.
  - `GET /users/@me/identities` lists linked identities, and `DELETE /users/@me/identities/:provider` unlinks one.
  - **CSRF:** the OAuth `state` is a signed, short-lived value bound to the browser, and to the user when linking.
- [ ] **Unique usernames, no discriminators** (decided 2026-11-24).
  - **Rules:**
    - 2–32 characters from `[a-z0-9_.]`, with no leading, trailing or doubled `.`
    - stored lowercase
    - unique index on `lower(username)`
    - a reserved list: `admin`, `api`, `app`, `files`, `support`, `help`, `settings`, `dashboard`, `cdn`, …
  - **New `display_name`:** optional, non-unique, free text. This is where the capitals and emoji go.
  - **Migration is cheap.** `register` has always hard-coded `discriminator = 1` (`api/views/auth.py:90`), and `(username, discriminator)` is unique, so every existing username is already unique. It is only *case-sensitively* unique, though.
    1. **Before migrating:** run `SELECT lower(username), count(*) … GROUP BY 1 HAVING count(*) > 1`, and also find names with invalid characters or reserved names.
    2. **Fix those few:** give each a suffix (`dan` → `dan_2`) and set a `needs_username` flag, so the user is asked to pick a new name at next login. Copy the old name to `display_name` so nothing visibly changes.
    3. **Then:**
       - drop the `discriminator` column and the `(username, discriminator)` index;
       - remove `discriminator` from `User.to_dict` (`api/models/__init__.py:30-35`);
       - in the UI, show `@username`.
  - **Discord signup** pre-fills the username from the Discord username (Discord's new usernames already follow similar rules). If the name is taken, it suggests a suffixed one, and the user can edit it before the account is created.
  - **Renames:**
    - Allowed from Settings, with a cooldown (for example once every 30 days).
    - A released name is held for 30 days before anyone else can take it, so nobody can impersonate the previous owner.
    - Files are tied to `user_id`, never to the username, so renaming breaks nothing.
- [x] Fix the crash when the extension is null *(Milestone 1)* (`models/__init__.py:139-140`) before anything new builds on `to_dict`.
- [ ] Stop exposing `hash` in API responses. The B2 bucket is private (below), and the CDN worker already proxies blobs, so nothing user-facing depends on bucket URLs.
- [ ] Delete and blob garbage collection, in order:
  1. Remove the file's `FileView` rows (there's no cascade).
  2. Soft delete the file.
  3. A reaper deletes a blob only once no `File` references its hash, and only after a grace period (`BLOB_GC_GRACE`, **at least 48 h**). That avoids racing an upload's get-or-create, and means a database restored from the daily backup never points at an already-deleted blob (§2.1 item 8).
  4. Also create the `FileHash` row only *after* the B2 upload succeeds.
- [ ] **Storage on Backblaze B2** (decided 2026-11-24).
  - **Region: US** (decided 2026-11-24). Pick the B2 US region at bucket creation; the database backups bucket goes in the same region.
  - **Bucket:** one **private** bucket. Keep the object layout `files/<hash_id>`, and put thumbnails at `thumbs/<hash_id>.webp`.
  - **Delete really deletes.** B2 keeps old versions by default: an S3 `DeleteObject` only *hides* the object, and hidden versions are still billed. Add a lifecycle rule that permanently deletes hidden files after 1 day.
  - **Keys, with least privilege:**
    - the API gets a key scoped to the bucket with `writeFiles` and `deleteFiles`;
    - the CDN worker gets a separate **read-only** key (`readFiles`).
    - Both live in secrets, never in the repo.
  - **API side:**
    - Use B2's S3-compatible endpoint with **aiobotocore** (async) in the API, and boto3 in the sync `worker` (for example for `finalize_upload`'s server-side copy).
    - Large single-request uploads stream from the hashed temp file as S3 multipart parts.
    - Store `Content-Type: application/octet-stream`; the CDN worker sets the real type when it serves the file.
  - **CDN worker side:**
    - Sign `GET` requests to B2 with SigV4 (for example the `aws4fetch` library), and pass `Range` through so video seeking works.
    - Blobs are content-addressed and never change, so cache them at the edge for a long time, keyed by `hash_id`.
    - This stays safe after a delete: the worker resolves vanity → file through the API *first*, so a deleted or expired vanity 404s before any cached blob is reached.
  - **Egress:** Backblaze and Cloudflare have had a free-egress arrangement (the Bandwidth Alliance). **Verify the current terms** before relying on it for costs.
- [ ] **Expiry** (decided 2026-11-24).
  - **Field:** `File.expires_at` (already in the migration list). `NULL` means the file never expires.
  - **On upload:** optional `expires_in` (seconds), validated against the uploader's limits (below):
    - **Anonymous:** an expiry is **required**. The maximum is **21 days** from upload, and it defaults to 21 days if none is sent. "Never" is rejected with `EXPIRY_NOT_ALLOWED`.
    - **Signed in:** optional, from 1 hour to "never". Plans can later cap the maximum.
  - **Changing it later:** `PATCH /users/@me/files/:id { expires_at }` and a bulk version.
    - Owners can shorten or extend the expiry within their limits.
    - Anonymous uploaders can only shorten it.
  - **Enforcement:**
    - The read path (API metadata, viewer and CDN) treats `expires_at <= now()` as gone **immediately**, showing the viewer's "This file has expired" state.
    - A reaper job runs about every 10 minutes and soft-deletes expired files in batches, which then feeds the normal blob garbage collection. Reads therefore never depend on the reaper being on time.
  - **Claiming on sign-up** (decided 2026-11-24):
    - Files claimed from a guest **keep the expiry they were uploaded with**.
    - The dashboard offers **"Keep forever"**, which clears `expires_at`:
      - per file, and in bulk;
      - plus a one-time banner after sign-up: "N files from before you signed in will expire. Keep them forever?"
    - Kept files count toward the storage limit. If keeping them would go over the limit, the button explains why instead of failing silently.
  - **ShareX:** add an optional `expires_in` argument to the generated `.sxcu`.
  - **Embeds:** Discord and other apps cache their own copy of previews, so files.gg can't remove those after a file expires. Say so in the expiry UI.
- [ ] **Limits** (decided 2026-11-24: per user now, plans later).
  - **One function decides every limit:** `get_limits(user | anonymous) → { storage_bytes, max_file_size_chunked, max_file_size_single, max_expiry, allow_no_expiry }`. Signed-in users get 1 GB chunked and 100 MB single-request; anonymous users get 25 MB either way. `POST /files` checks the single limit, and `POST /uploads` checks the chunked one.
    - Today it reads config defaults plus an optional `User.storage_limit_override` (for manual bumps). The defaults are listed in §4.
    - Later, a `plans` table plugs in here, and no call sites change.
  - **Usage:** `SUM(File.size)` over the user's non-deleted, non-expired files. That is the size the *user* sees, even when the blob is shared through de-duplication, so the meter stays predictable. Start with the indexed query, and add a counter column only if it gets slow.
  - **Upload checks:**
    - before reading the body, using `Content-Length`;
    - again after streaming, using the real byte count.
    - Errors: `FILE_TOO_LARGE` or `STORAGE_LIMIT_REACHED` (HTTP 413), each with `limit` and `used` in the body so the UI can explain.
  - **Anonymous:**
    - a smaller max file size;
    - a rolling 24-hour byte cap per guest *and* per IP (`CF-Connecting-IP`), queried by Snowflake-id time range;
    - plus a Cloudflare rate-limit rule as a backstop.
  - `GET /users/@me/limits` (named like notsobot.com's) returns usage alongside the limits.
- [ ] **Chunked, resumable uploads** (decided 2026-11-24). Today there's no chunking: one multipart POST per file, the whole file held in memory, and nginx's 100 MB cap.
  - **Why it matters beyond resuming:** Cloudflare caps a single proxied request body at 100 MB on the Free and Pro plans. Sending ≤10 MB chunks means file size is limited only by `get_limits()`, never by the proxy, so plans can raise `max_file_size` later without any infrastructure change.
  - **Protocol** (small and custom, in the same `{ code, message }` error style):

    | Request | What it does |
    |---|---|
    | `POST /uploads { filename, size, expires_in? }` | Checks limits **up front** (size is declared), reserves the quota, and returns `{ upload_id, chunk_size, chunk_count, expires_at }`. The session lasts 24 h. |
    | `PUT /uploads/:id/chunks/:index` | Raw bytes. Every chunk is exactly `chunk_size` except the last. Idempotent: re-sending a chunk overwrites it. Rejects wrong sizes, out-of-range indexes and the wrong owner. |
    | `GET /uploads/:id` | `{ received: [indexes], size }`, so the client knows what to resume. |
    | `POST /uploads/:id/complete` | Checks every chunk is present and the total equals the declared `size`, then finishes the B2 multipart upload and queues the `finalize_upload` job. Returns `202 { status: "processing" }`; the client polls `GET /uploads/:id` until it reports `complete` with the `File`, in the same shape `POST /files` returns. |
    | `DELETE /uploads/:id` | Aborts the upload and frees the reserved quota. |

  - **Server storage: chunks go straight to B2, so any API server can take any chunk** (the API will run on several servers):
    - `POST /uploads` starts an S3 `CreateMultipartUpload` on B2 at `staging/<upload_id>`. The B2 multipart `UploadId` is stored in Postgres.
    - Each `PUT …/chunks/:index` is streamed straight to B2 as part `index + 1` (`UploadPart`). Its ETag and size are recorded in `upload_parts`. Nothing is written to the API server's disk, and chunks can arrive in parallel, in any order, on any server.
    - B2's rules fit this protocol: parts must be 5 MB–5 GB (except the last) and there can be up to 10,000 parts. 10 MB chunks therefore allow files up to about 100 GB, far beyond any planned limit.
    - `complete` calls `CompleteMultipartUpload` using the recorded ETags, then queues **`finalize_upload`**. That job runs on whichever worker picks it up:
      1. Read `staging/<upload_id>` back from B2 once, as a stream, computing blake2b, md5 and sha1.
      2. If the hash matches an existing `FileHash`, delete the staging object and point the new `File` at the existing blob (de-duplication).
      3. Otherwise, do a **server-side copy** in B2 from `staging/<upload_id>` to `files/<hash_id>`, then delete the staging object. No re-upload is needed.
      4. Create the `File` and queue the `scan`, `probe` and `derive` jobs.
    - **Hashes are always computed on the server.** De-duplication can't trust a hash sent by the client: someone could claim a known hash and get linked to another person's file without ever having it.
    - **Cost:** finalising reads each large upload back from B2 once. Check that against B2's free-egress allowance. If it becomes a cost, the scaling option at the end of this section avoids it.
  - **Quota reservations:** while a session is open, its declared `size` counts toward usage. That stops several parallel uploads from jointly overshooting the limit.
  - **Abandoned uploads:** a reaper job calls `AbortMultipartUpload` for sessions not completed within 24 h, and deletes their rows and any staging object.
    - B2 bills unfinished large files until they are cancelled, so also set the bucket lifecycle rule `daysFromStartingToCancelingUnfinishedLargeFiles: 2` as a backstop.
  - **Ownership:** a session belongs to the user token, or to the guest for anonymous uploads. Every chunk and `complete` call must come from the same owner. Anonymous rolling caps count reserved bytes too.
  - **Client (Phase 3 Upload page):**
    - Files larger than `chunk_size` use sessions; smaller ones keep the single-request `POST /files`.
    - Up to 3 chunks upload in parallel, each retried with backoff, and the overall progress bar is built from per-chunk progress.
    - Pause and resume buttons.
    - After a page reload, the session is remembered in localStorage by `name + size + lastModified`. Re-picking the same file resumes from the chunks the server reports, because browsers can't keep a `File` across reloads.
  - **Single-request uploads** (`POST /files`) still use a local temp file, but only *within that one request*, so they work on any server unchanged.
  - **Kept as is:** `POST /files` (single request) stays for small files, ShareX and curl. ShareX can't do chunked uploads, so its effective cap stays at the proxy's 100 MB.
  - **Alternative considered:** the **tus** resumable-upload protocol, with the mature `tus-js-client`. It's standard, but on the server it means running `tusd` as an extra service with hooks, or relying on less mature Python servers. The custom protocol above is about five endpoints and fits the existing auth and limits, so tus isn't worth it yet.
  - **Later option:** direct-to-B2 uploads with presigned multipart URLs, which would skip the API's bandwidth entirely. That gives up server-side hashing and de-duplication unless the file is read back after upload, so it's a scaling step, not a launch requirement.
- [ ] **Albums: many files behind one link** (decided 2026-11-24).
  - **What an album is:** an ordered collection of files, like imgur's albums. When every item is audio, it becomes a music **album**: cover art, a tracklist and continuous playback.
  - **Data model.** Albums share no storage with files; they only point at them.

    `albums` table:

    | Column | Notes |
    |---|---|
    | `id` | snowflake |
    | `vanity` | unique, random, 8 characters |
    | `owner_user_id` | NULL for anonymous |
    | `owner_guest_id` | |
    | `title` | ≤ 100 characters |
    | `description` | ≤ 2,000 characters, plain text |
    | `cover_file_id` | NULL means automatic |
    | `layout` | `auto` / `grid` / `list` / `tracklist` |
    | `nsfw` | derived |
    | `expires_at` | |
    | `created_at` / `updated_at` / `deleted_at` | |
    | `moderation_state` | |

    `album_files` table:

    | Column | Notes |
    |---|---|
    | `album_id`, `file_id` | together the primary key |
    | `position` | |
    | `caption` | ≤ 500 characters |
    | `added_at` | |

    - **Same file in several albums:** allowed.
    - **Deleting an album** never deletes its files, unless the owner ticks **"Also delete the files"**.
    - **Deleting a file** removes it from every album.
  - **Ownership.** Only the album owner's own files can be added. Nobody can add someone else's uploads to their album, which keeps moderation and takedowns simple.
  - **URL:** `files.gg/a/<vanity>`, a separate namespace from file vanities. `a` is reserved (§1.4 item 2).
    - Raw items stay at their own file URLs.
    - `files.gg/a/<vanity>/<n>` deep-links to item *n* in the lightbox.
  - **Anonymous albums:** created only from a single multi-file upload, up to 50 files. They follow the anonymous expiry rules: the album expires when its last file does, at most 21 days. Signed-in users can create, edit and reorder albums freely.
  - **Expiry and removal:**
    - Expired, deleted or moderator-hidden files drop out of the public view.
    - An album with no visible files shows the "doesn't exist or has expired" state.
    - The reaper deletes empty albums after 7 days.
  - **Limits** (config, through `get_limits()`):
    - 500 files per album;
    - 1,000 albums per user;
    - anonymous: 50 files, from one upload batch.
  - **API:**

    | Endpoint | What it does |
    |---|---|
    | `POST /albums { title?, description?, file_ids[], layout?, cover_file_id? }` | Create an album |
    | `GET /albums/:vanity` | Public read. Returns the album plus its visible items with `media` and `thumbnail`, cursor-paginated at 100. Inlined into the viewer page, like `file-data`. |
    | `PATCH /albums/:id` | Edit the title, description, layout or cover |
    | `DELETE /albums/:id?delete_files=true` | Delete the album, optionally with its files |
    | `PUT /albums/:id/files { file_ids[] }` | Replace the whole order |
    | `POST /albums/:id/files { file_ids[], position? }` | Add items |
    | `DELETE /albums/:id/files/:file_id` | Remove an item |
    | `PATCH /albums/:id/files/:file_id { caption }` | Set an item's caption |
    | `GET /users/@me/albums` | List your albums: search, sort, paginate |

  - **Upload integration:**
    - Dropping more than one file shows a **"Put these in an album"** toggle, on by default.
    - When the batch finishes, the dashboard calls `POST /albums` and shows the album link alongside the per-file links.
    - ShareX stays one file per request. An optional `album=<vanity>` argument appends the file to one of the user's existing albums.
  - **"Download all":**
    - A ZIP is streamed on the fly by the CDN worker, using *store* mode (no compression, a streaming ZIP writer), so nothing is built server-side.
    - It includes only items that passed scanning.
    - It's capped at 2 GB, after which per-item downloads are offered instead.
  - **Embeds:**
    - `og:title` is "*Title* · N files".
    - `og:image` is a **collage** (a 2×2 grid of the first four visual items, 1200×630), made by a `derive` job that re-runs a few seconds after any change.
    - Audio albums use the cover art instead.
    - NSFW albums get no image (see Trust & safety).
  - **Trust & safety:**
    - An album is NSFW if any visible item is. Titles, descriptions and captions are user text, so they're shown as plain text with links as `rel="nofollow ugc noopener"`. URLs in them go through the same Web Risk check as text files.
    - Albums can be reported (see "Report system"). A hidden album shows the "removed" state.
  - **Privacy:** the owner's username is **not** shown on an album unless they turn on "Show my name on albums" in Settings (off by default).
- [ ] **Human verification and upload keys** (decided 2026-11-24): the website uses human verification, and ShareX and other tools use their own keys instead.
  - **The website** uses **Cloudflare Turnstile**, replacing Google reCAPTCHA (today's login and register, `api/utils/recaptcha.py`), in Turnstile's *managed* mode, which is invisible for most people.
    - **Where it's required:**
      - register, log in and forgot password;
      - every **anonymous** upload, both single-request and chunked (the token goes on `POST /uploads` and `POST /files`);
      - anonymous conversions and anonymous reports;
      - **every** password unlock, on files and albums (decided 2026-11-24), including automatic `#pw=` link unlocks.
    - **Where it's not:** signed-in uploads from the website. The login is the proof, and the limits still apply.
    - **Server-side:** the API checks every Turnstile token with Cloudflare's `siteverify` endpoint (`TURNSTILE_SECRET`). It also checks that the action name matches (`upload`, `login`, `report`…) and that the token was issued for files.gg, so a token from one form can't be replayed on another. A failure is `CAPTCHA_INVALID`.
    - **Reference:** `TURNSTILE_SITE_KEY` is public, in the web app's config.
  - **ShareX, scripts and apps** can't solve a human check, so they use **upload keys** instead:
    - **Signed-in users** create a key in **Dashboard → Integrations**.
    - **Scope:** a key can only upload and add to albums. It can't log in, change settings, delete files or create other keys. Each key has its own rate limits.
    - **Format:** keys look like `fgg_<random>`. Only a SHA-256 hash and the first 8 characters are stored. The full key is shown once, and can be revoked at any time.
    - **New table `upload_keys`:** `id`, `user_id` FK, `name`, `prefix`, `key_hash`, `scopes`, `created_at`, `last_used_at`, `revoked_at` (FKs and `timestamptz` per schema fixes 2 and 3).
    - **Requests:** they send `Authorization: Key fgg_…`.
    - **Anonymous tool uploads** (no key and no Turnstile token) are **refused** with `UPLOAD_KEY_REQUIRED`: "Create a free account to upload with ShareX". Without this, the human check on the website could simply be bypassed through the API.
    - **Existing ShareX configs:** today's `.sxcu` files send the full login token, and must keep working (§1.4 item 5). That token is still accepted for uploads but marked *legacy*, and Integrations shows a "Replace your ShareX config" banner. Removing legacy login tokens from uploads is a later, announced step.
- [ ] **Private and password-protected files and albums** (decided 2026-11-24).
  - **Access levels** (`visibility`), per file and per album:

    | Level | Who can open it | Anonymous uploads |
    |---|---|---|
    | `link` (default, today's behaviour) | Anyone with the link | yes |
    | `password` | Anyone with the link **and** the password | yes |
    | `private` | Only the signed-in owner (and staff handling a report) | no, because it needs an account |

    Later option: `people`, shared with specific files.gg users.
  - **Passwords: set your own, or generate one.**
    - **Your own:** 6–128 characters, with a client-side strength meter (zxcvbn-ts) that warns on weak passwords.
    - **Generated:** a 4-word passphrase from a large word list, about 50+ bits (for example `amber-tunnel-oxide-violet`). Shown **once**, with a copy button. files.gg stores only an **argon2id** hash, so nobody (staff included) can show it again; the owner can only reset it.
    - **"Copy link with password":** produces `files.gg/<vanity>#pw=<password>`. The part after `#` is never sent to any server (not in logs, not in the `Referer` header). The viewer reads it, unlocks automatically, then removes it from the address bar with `replaceState`.
  - **It locks the bytes, not just the page.** Every way in is gated:
    - **Unlocking:** `POST /files/:vanity/unlock { password, turnstile_token }` (and `/albums/:vanity/unlock`) returns a short-lived **signed access token**: an HMAC over `{ target_id, scope, unlocked_at, access_version, exp }` with a key shared by the API and the CDN worker (`CDN_TOKEN_SECRET`).
      - **A Turnstile token is required on every unlock** (decided 2026-11-24). It's checked with `siteverify` and action `unlock` *before* the password is compared, so automated guessing is blocked up front and a wrong-but-human attempt costs nothing extra. Without a valid Turnstile token the response is `CAPTCHA_INVALID`, and the password isn't checked.
      - In the viewer, Turnstile runs in managed mode inside the lock screen, invisible for most people. A `#pw=` link waits for the invisible check to pass, then unlocks automatically.
      - The token's lifetime follows the file's **Stay unlocked for** setting (default 1 h), and the viewer refreshes it while it's open, never past that limit. Refreshes don't need a new Turnstile check.
      - **Owner passes** skip Turnstile: the owner is already signed in on files.gg.
    - **CDN:** the viewer asks for `cdnUrl?t=<token>`; images, `<video>`, pdf.js and range requests all carry it. The CDN worker resolves vanity → file *before* serving anything, checks the visibility, the token's signature, expiry and `access_version`, and only then streams the blob.
      - Protected responses get `Cache-Control: private, no-store`.
      - The blob may still sit in the worker's own edge cache, but only after the check has passed.
    - **Derived assets** (thumb, poster, hover clip, cover, waveform, PDF first page, album collage) need the same token. **Otherwise thumbnails would leak the content.**
    - **Without access:**
      - `private` returns **404** ("doesn't exist"), so its existence isn't revealed;
      - `password` returns 401 on the CDN, and the lock screen in the viewer.
    - **Embeds and bots** (§1.4 item 3 routes ShareX and Telegram straight to the CDN):
      - protected files expose **nothing**: no `og:image`, no `og:video`, and a generic title ("Password-protected file · files.gg");
      - the filename is hidden unless the owner turns on "Show name on lock screen";
      - the CDN never serves protected bytes to a bot without a token.
    - **"Download all" ZIPs** for albums include protected items only when the album token covers them.
  - **Password timing is customisable** (decided 2026-11-24). There are two settings per file and per album, kept separate on purpose:
    1. **Stay unlocked for** (`unlock_ttl`): how long a visitor who entered the password can keep viewing without re-entering it.
       - Choices: 10 minutes, **1 hour (default)**, 1 day, 7 days or 30 days.
       - The unlock token's expiry is `unlocked_at + unlock_ttl`. Background refreshes keep a token alive while the viewer is open, but **never past that limit**: the token carries `unlocked_at`, and refreshes keep its cap.
       - The token is kept in that browser's storage for the site, for that one file, until it expires, so reopening the link inside the window doesn't ask again.
    2. **Password works until** (`password_expires_at`): after this date and time the password no longer unlocks anything.
       - Unlock tokens are capped at it too, so nobody stays unlocked past it.
       - The file then behaves like `private` (only the owner) until the owner sets a new password, moves the date, or changes access. Visitors see "This link's password has expired".
       - This is separate from **file expiry**, which deletes the file. A password can expire while the file stays.
       - Choices: never (the default), 1 day, 7 days, 30 days, or a custom date.
    - **Limits:** anonymous uploads have no "never" (the file expires within 21 days anyway), and `unlock_ttl` can't go beyond the file's own expiry.
    - **API:** `PATCH /users/@me/files/:id { unlock_ttl, password_expires_at }` (and the same for albums and the bulk access endpoint), plus upload parameters `unlock_ttl` and `password_expires_in`.
    - Shortening either value bumps `access_version`, so it applies at once. Lengthening needs no bump.
  - **Changing access revokes access.**
    - Changing visibility or the password bumps `access_version`, so every outstanding token and every `#pw=` link stops working at once.
    - Making a file `private` also stops the CDN serving it, even to people who had it open.
  - **Albums:**
    - The album has its own `visibility` and password.
    - Unlocking an album issues a token covering its items, *within that album*.
    - `private` items never appear to non-owners in any album.
    - A `password` file that appears in an unlocked album is visible there: the owner chose to put it in.
    - Opening an item by its own link still follows the file's own access level.
  - **Brute-force protection:**
    - argon2id cost tuned to about 50 ms;
    - per file and per IP: 5 attempts a minute, then exponential backoff;
    - Turnstile on **every** attempt (see "Unlocking");
    - per file overall: 100 failures an hour across all IPs locks the file's unlock for 15 minutes and notifies the owner.
    - The lock screen shows "Too many attempts, try again in N minutes" without hinting whether the password was close.
  - **Not end-to-end encryption, and why:**
    - A password here is **access control**, not encryption. Files are stored as uploaded (with B2's server-side encryption at rest) so files.gg can preview, convert and **scan** them.
    - **Protected files are scanned exactly like public ones.** CSAM hash-matching, malware and NSFW all run on the bytes at upload, whatever the visibility. Privacy features must never become a scanning blind spot.
    - Moderators can open protected files when handling a report, and every access is logged in `moderation_actions`.
    - The hot-file circuit breaker still applies: password-protected archives are a classic way to spread malware.
    - A true end-to-end "vault" (the key only in the URL fragment, so the server can never read the file) would rule out previews, conversion and scanning, and the scanning conflicts with the legal duties in Trust & safety. It's not planned.
  - **Upload and API:**
    - Upload parameters (multipart, raw, chunked sessions and ShareX): `visibility`, `password`, `generate_password=true`. With a generated password, the response includes `password` **once**, plus `url_with_password`, so ShareX can copy the `#pw=` link straight away.
    - `PATCH /users/@me/files/:id { visibility, password? | generate_password? }` and the same for albums, plus a bulk `POST /users/@me/files/access`.
    - `GET /files/:vanity` for a protected file returns only `{ vanity, protected: "password" | "private" }` (plus the name if the owner opted in) until the caller has access.
  - **Interaction with other features:**
    - **De-duplication:** access is checked per `File`, never per blob. A private file that shares a blob with someone's public file stays private, because hashes are never exposed.
    - **Conversion:** converting a protected file needs access to it, and the output is `private` by default.
    - **Expiry:** works the same as for any file.
- [ ] **Custom domains (premium)** (decided 2026-11-24). Users serve their files from their own domain, for example `i.example.com/abc123`, instead of `files.gg/abc123`.
  - **How: Cloudflare for SaaS (Custom Hostnames).** The customer points a CNAME at a files.gg target (`domains.files.gg`). Cloudflare validates the hostname, issues and renews its TLS certificate, and sends its traffic to files.gg's Worker through the SaaS **fallback origin**. No certificate handling on our side.
    - **Cost:** 100 custom hostnames are included free, then **$0.10 per hostname per month**, up to 50,000.
    - **Hostnames count from the moment they're created, even while pending.** So pending ones are deleted after 72 h without DNS, and removed domains are deleted from Cloudflare immediately.
    - **Confirm while building:** the exact Worker setup for SaaS traffic (a Worker route on the fallback origin, or a `*/*` route on the SaaS zone). It's checked against Cloudflare's docs when this is built.
  - **Subdomains only** (`i.example.com`, `cdn.example.com`). A bare root domain (`example.com`) needs Cloudflare's apex proxying, a separate configuration whose availability and cost aren't confirmed. Revisit if customers ask.
  - **Premium only**, through `get_limits()` → `custom_domains` (free: 0, premium: 5; decided 2026-11-25).
    - Plans don't exist yet. Until they do, staff grant it per user with `User.storage_limit_override`'s sibling, `User.custom_domains_override`, from the admin pages.
    - Once paid plans ship, they set the limit, and the plan system replaces the manual grant with no change elsewhere.
  - **What a custom domain serves** mirrors files.gg plus its CDN:

    | Path on the custom domain | Serves | Same as |
    |---|---|---|
    | `/<vanity>` (and `/<vanity>.<anything>`) | the viewer page, with the same bot and embed routing (§1.4 item 3) | `files.gg/<vanity>` |
    | `/files/<vanity>.<ext>` | raw bytes, with the full `cdn.files.gg` hardening (sandbox CSP, `nosniff`, `attachment` rules) | `cdn.files.gg/files/<vanity>.<ext>` |
    | `/a/<vanity>` | albums | `files.gg/a/<vanity>` |
    | `/` | a minimal landing card: "Files hosted with files.gg" and a Report link | none |

  - **"Only my files" setting, on by default** (decided 2026-11-24). Each domain has a `scope` setting:
    - **`own` (the default): only the domain owner's files.** `i.example.com/<vanity>` for someone else's file returns **404**. Nobody's uploads appear under another person's domain, and every file there is clearly attributable for takedowns.
    - **`any` (opt-in):** the domain works as an alias for every public files.gg link, so `i.example.com/<anyone's vanity>` resolves too.
      - Turning it on shows a warning: "Other people's files will be viewable on your domain."
      - Reports about files reached through the domain still go to each file's own uploader.
      - Staff can force a domain back to `own` if it's being abused.
    - `private` files never appear to *other people* on custom domains under either setting (the owner can open them with an owner pass; see "Owner passes").
    - Stored as `custom_domains.scope` (`own` / `any`, default `own`), returned by the Worker lookup and cached with it, so changing it takes effect within the 60 s cache window.
  - **Access levels:**
    - `link` and `password` files work on custom domains: unlock tokens are per-origin, and `#pw=` links work.
    - **`private` files:** never shown to others on custom domains. The owner's login lives on files.gg, not on their domain, so the owner opens them through an **owner pass** (below).
  - **Owner passes** (decided 2026-11-24): how the owner opens their own files where their login doesn't reach.
    - **Why it's needed:** a custom domain is a different site from files.gg, so it can't read the files.gg login, and with "domain-only" mode on (below) even files.gg links stop working for the public.
    - **How it works:** the dashboard on files.gg, where the owner is logged in, mints a short-lived **signed access token**. It's the same HMAC token the CDN already checks for password unlocks (`CDN_TOKEN_SECRET`, `{ target_id, scope, access_version, exp }`), with a new `owner` scope and a 1 h expiry. Because the CDN checks a signature, not a login, the token works on any of the owner's domains.
    - **"Open on i.example.com"** in the Files table, the viewer drawer and the album editor sends the owner to `i.example.com/<vanity>#t=<token>`. The fragment never reaches a server or a log. The viewer uses the token for its media requests, refreshes it through files.gg while open, and strips it from the address bar.
    - **Dashboard previews** (thumbnails, drawer, album editor) use the same owner tokens, so the owner always sees their files on files.gg even when domain-only mode hides them from the public.
    - Changing a file's access or turning domain-only mode on or off bumps `access_version`, which invalidates every outstanding owner token at once.
    - **Signing in on custom domains** (a files.gg → custom-domain login handshake, so plain links work for the owner) was considered and left for later: more surface (per-domain sessions and logout) for little gain over owner passes.
  - **Domain-only mode: "Only show my files on my domain"** (decided 2026-11-24). An account setting for users with at least one **active** custom domain.
    - **When it's on:**
      - `files.gg/<vanity>`, `files.gg/a/<vanity>` and `cdn.files.gg/files/<vanity>.*` for that user's files and albums return the normal **"doesn't exist"** (404), exactly like a missing file, so the files.gg links don't even confirm they exist.
      - The files open only on the user's own active custom domains.
    - **Who still sees them on files.gg:** the owner (dashboard previews with owner tokens) and staff handling reports or moderation (logged in `moderation_actions`). Scanning, reports and takedowns are unaffected: the Report link and every protection works on the custom domain.
    - **Turning it on** shows how many existing files.gg links will stop working: "142 files have files.gg links that will stop working, including links already shared in Discord". The user has to confirm. New links already use the default domain.
    - **If no domain is active** (DNS check failing for 3 days, staff disabled it, or premium lapsed), the files would become unreachable everywhere. Instead the mode **pauses automatically**: files.gg serves them again, and the owner is notified ("Your domain isn't working, so your files are showing on files.gg again"). It resumes when a domain is active again. This is a branding feature, not a privacy one (for privacy, use `password` or `private`), so availability wins.
    - **Independent of the per-domain "Only my files" (`scope`) setting:** that controls *which files a domain shows*; domain-only mode controls *whether files.gg shows them*.
    - **Data:** `users.domain_only bool DEFAULT false`. The API's file metadata gains `served_on: "files.gg" | "custom"` (the effective value, so a pause is already reflected). The Worker checks it for files.gg and cdn.files.gg requests, after vanity → file lookup and before serving or caching.
    - **Premium:** it comes with custom domains.
  - **Links:**
    - In Settings, users pick a **default domain**, and it's used for every link the dashboard copies and every upload response (`url`, `url_with_password`).
    - Each **upload key** can pin a domain, so a ShareX config returns `i.example.com/…` links.
    - `files.gg/<vanity>` always keeps working too.
  - **Taking over abandoned domains:**
    - Ownership is proven with a **TXT record**: `_filesgg-verify.<hostname>` = a per-domain random token. This is *in addition* to Cloudflare's own validation.
    - The point: if someone leaves a dangling CNAME pointing at files.gg after removing the domain, nobody else can claim it, because they can't set that TXT record.
    - A daily `domain_check` job re-checks the CNAME and TXT records and Cloudflare's status. If they stop matching for 3 days in a row, the domain is turned off and the owner is notified.
  - **Abuse:**
    - Clean custom domains are attractive for phishing and malware, so every existing protection applies unchanged (scanning, the hot-file breaker, reports, NSFW handling).
    - Staff can **disable a domain** from the admin pages, which stops all serving on it at once and is logged in `moderation_actions`.
    - Adding a domain requires a verified email and an account older than 7 days.
    - The Report link works on the domain's landing card and in the viewer.
  - **Security upside:** a custom domain is a different registrable domain from files.gg, so user content on it is fully isolated from files.gg's cookies and storage. The `cdn.files.gg` hardening still applies to it.
  - **Worker lookup:**
    - For any hostname that isn't `files.gg`, `cdn.files.gg` or `api.files.gg`, the Worker asks the API (`GET /internal/domains/:hostname`, authenticated with `ORIGIN_SHARED_SECRET`) for `{ owner_user_id, status }`.
    - It caches the answer for 60 s with the Cache API, and caches unknown or disabled hostnames negatively. Then it serves as above with an owner filter.
  - **API:**

    | Endpoint | What it does |
    |---|---|
    | `GET /users/@me/domains` | List your domains |
    | `POST /users/@me/domains { hostname }` | Add a domain: validates it as a subdomain, punycodes it, checks the limit, creates the Cloudflare custom hostname, and returns the CNAME and TXT records to add |
    | `POST /users/@me/domains/:id/verify` | Re-check now |
    | `PATCH /users/@me/domains/:id { default, scope }` | Set or unset as the default domain; switch between "only my files" (`own`) and every public file (`any`) |
    | `DELETE /users/@me/domains/:id` | Remove: deletes the Cloudflare hostname too |

    The Cloudflare API token is scoped to Custom Hostnames on the files.gg zone and lives in the API's secrets.
  - **Table `custom_domains`:**

    | Column | Notes |
    |---|---|
    | `id` | |
    | `user_id` | FK |
    | `hostname` | unique, lowercase, punycode |
    | `cf_hostname_id` | |
    | `status` | `pending_dns` / `pending_cert` / `active` / `failed` / `disabled` |
    | `verify_token` | |
    | `is_default` | |
    | `scope` | `own` (default) / `any`: see the "Only my files" setting |
    | `verified_at` | `timestamptz` |
    | `last_checked_at` | `timestamptz` |
    | `disabled_reason` | |
    | `created_at` | `timestamptz` |

    Plus `upload_keys.domain_id NULL` (FK).
- [ ] **File conversion** (decided 2026-11-24). Convert a file to another format, and get the result as a normal files.gg file with its own link.
  - **Reuses the media pipeline:** the same sandboxed worker image (ffmpeg, libvips/Pillow, poppler), the same jobs queue, and the same "output is a normal upload" path (B2 → `FileHash` → `probe` / `derive` / `scan`). Build it **after** "Media processing".
  - **Formats, v1:**

    | From | To | Options |
    |---|---|---|
    | **Image**: png, jpg, webp, avif, gif (first frame), heic, tiff, bmp, psd (flattened), svg (rasterised with **resvg**: no scripts, no external references) | png, jpg, webp, avif, gif, ico | quality, max width/height (keeping the aspect ratio), background colour for formats without transparency, **strip metadata** (on by default: removes EXIF including GPS location) |
    | **Animated**: gif, apng, animated webp | mp4, webm, animated webp, gif | fps, width, trim, loop. GIF → MP4 is usually 5–20× smaller. GIF output uses `palettegen`/`paletteuse` for quality. |
    | **Video**: mp4, mov, mkv, webm, avi… | **mp4** (H.264 + AAC, plays everywhere), webm (VP9 + Opus), gif, **audio only** (mp3 / m4a / ogg / wav) | max resolution (1080/720/480), trim, mute, **target size** (presets such as "Discord free upload limit", or custom MB; uses two-pass bitrate). A video with `playable: false` shows **"Convert to MP4 to play in browser"** right in the viewer. |
    | **Audio**: mp3, m4a, ogg, opus, flac, wav, aac… | mp3, m4a, ogg (Opus), flac, wav | bitrate, trim, **normalise loudness** (ffmpeg `loudnorm`), keep tags and cover art (on by default) |
    | **Documents**: docx, xlsx, pptx, odt, ods, odp, rtf | **PDF** | LibreOffice headless, sandboxed, with macros disabled (macro documents are blocked at upload anyway) and no network access |
    | **PDF** | **png / jpg per page** | dpi and page range. Multi-page output becomes an **album**, or a zip. |
    | **Images** (several, or an album) | **PDF** | page size, margins, order (the album order) |

    Later candidates: CSV ↔ JSON ↔ XLSX, Markdown → PDF, archive repacking, OCR to text.
  - **Who can convert:**
    - Anyone can convert a **public** file, even one they didn't upload; the output belongs to whoever converted it.
    - Owners can also convert their private or unlisted files.
    - Anonymous conversions are allowed (decided 2026-11-24), with smaller limits, Turnstile and lower queue priority. The full table is in §4 item 11.
  - **Provenance:**
    - Each output records `derived_from_file_id` and the recipe.
    - **If the source is removed by moderation, every output derived from it is removed too.** That stops conversion being used to launder content that was taken down.
    - Outputs inherit the source's NSFW mark.
    - Outputs are still scanned: cheap, and it catches converter edge cases.
  - **Conversion cache:**
    - A `conversion_cache` table maps `(source hash_id, recipe hash)` to the output `hash_id`.
    - Converting the same file with the same options again is instant and free, and just creates a new `File` pointing at the cached blob.
    - Cache entries are deleted when their output blob is garbage-collected.
  - **Running conversions:**
    - The `convert` jobs run in their **own queue and service** (`converter`): the same image as `worker`, scaled separately, so long video transcodes never delay upload finalising, scans or thumbnails.
    - Each node runs a fixed number of jobs at once (for example its CPU count ÷ 2).
    - Each job has a time limit (for example 10 minutes; plans can raise it).
    - The sandbox rules from "Media processing" apply unchanged: non-root, no network except Postgres and B2, CPU and memory limits, ffmpeg's `-protocol_whitelist file,pipe`.
  - **Progress:**
    - ffmpeg's `-progress pipe:1` (and per-page counts for documents) updates `conversions.progress` about once a second.
    - ~~Server-Sent Events woken by `LISTEN/NOTIFY`.~~ **Polled, notsobot.api style** (owner, 2026-11-25): `POST /conversions` waits up to 2 s, then the page polls `GET /conversions/<id>` for queue position, stage, progress and time limit.
  - **Conversions and document previews run on RQ + Redis, as notsobot.api's jobs do** (owner, 2026-11-25): `rq worker-pool` services by tier with their own `cpus` and `cpu_shares`, a forked work horse per job killed at its timeout, structured errors and failure reasons. The upload pipeline stays on the Postgres queue. Details in [`contracts/milestone-5.md`](contracts/milestone-5.md) §3.1 and §3.3.
    - This replaces "`convert` jobs go on their own `convert` queue" in the jobs section below.
  - **Rate limits move to Redis too** (owner, 2026-11-25): notsobot.api's moving-window limiter, with a global limit and per-route limits, replacing `safety_rate_limits` and `unlock_attempts`. Brute-force limits fail closed. See [`contracts/milestone-5.md`](contracts/milestone-5.md) §18.
  - **Limits**, added to `get_limits()`:
    - max input size;
    - conversion CPU-seconds per day;
    - concurrent conversions;
    - max pages for PDF → images.

    The starting defaults are in §4.
  - **API:**

    | Endpoint | What it does |
    |---|---|
    | `GET /conversions/formats` | The matrix above as data: for each source kind, the targets and a JSON schema of their options. The UI builds its forms from this, so adding a format needs no frontend change. |
    | `POST /conversions { file_id, target, options }` | Start a conversion: `202 { id }`. Uploading a new file first goes through the normal upload, then this call. |
    | `GET /conversions/:id` | Status, progress, output file, error code |
    | `DELETE /conversions/:id` | Cancel a queued or running conversion |
    | `POST /conversions/batch { file_ids[] or album_id, target, options }` | One conversion per item. "PDF → pages" and "images → PDF" are single-output jobs. |
    | `GET /users/@me/conversions` | History |

  - **Typed errors:**
    - `UNSUPPORTED_CONVERSION`
    - `CONVERSION_TOO_LARGE`
    - `CONVERSION_LIMIT_REACHED`
    - `CONVERSION_TIMEOUT`
    - `CONVERSION_FAILED`, with a short, safe reason and never raw ffmpeg output
    - `SOURCE_UNAVAILABLE` (removed or expired)
  - **Expiry of outputs:**
    - Signed-in users get their default expiry, which they can change.
    - Anonymous outputs follow the anonymous rules (at most 21 days).
  - **Client-side fast path (later):**
    - Simple image conversions (png ↔ jpg ↔ webp, resize) can run in the browser with `OffscreenCanvas` or WebCodecs: instant, private, and no server cost.
    - The result is then uploaded like any file.
    - Kept out of v1 so there's only one code path to get right first.
- [ ] **Accepted file types: almost anything, except executables and malware-style types** (decided 2026-11-24).
  - **notsobot.com** only takes images, video and audio ("That file type isn't supported. Use an image, video or audio file").
  - **files.gg should be much wider:** documents, archives, code, fonts, 3D models, data files, and anything unknown. Only executable and other malware-style types are blocked.
  - **Today it's both too strict and spoofable.**
    - Too strict: an upload is rejected unless its mimetype is in the DB tables (`InvalidMimetype`, `api/views/files.py:213-219`).
    - Spoofable: that mimetype is whatever the client *declares* (`storage.mimetype` / `request.mimetype`, `files.py:186,192`), and the bytes are never checked. An `.exe` sent as `image/png` gets through.
    - `Mimetype.flags` exists (`models/__init__.py:64`), but the `# check flags` step (`files.py:229`) was never written.
  - **New rule: detect the type from the bytes, and check the declared type and the extension too.**
    1. Sniff the real type from the first bytes with libmagic (`python-magic`).
    2. Block the upload if **any** of these is on the blocklist: the sniffed type, the declared type, or the extension. That stops an `.exe` renamed to `.png`, and a PNG renamed to `.exe`.
    3. Otherwise accept it. Unknown types are stored as `application/octet-stream`, with `kind: "file"` and the original extension kept.
    4. The `Mimetype`/`MimetypeExtension` tables become **descriptive** (labels, icons, preferred extension, `kind`), not an allowlist. Their `flags` column gains a `BLOCKED` bit, so the blocklist is data that can be changed without a deploy.
    5. A rejection is `BLOCKED_FILE_TYPE` ("This file type isn't allowed on files.gg: executables and installers can carry malware"), naming the type that matched.
  - **Blocklist (v1):**

    | Group | Blocked | Detected by |
    |---|---|---|
    | Native executables | Windows PE (`MZ`), ELF, Mach-O | magic bytes, whatever the extension |
    | Windows executables and scripts | `.exe .dll .scr .com .pif .cpl .msi .msp .msix .appx .appxbundle .bat .cmd .ps1 .psm1 .vbs .vbe .jse .wsf .wsh .hta .lnk .reg .inf .msc .chm .scf .url .application .gadget` | extension and magic |
    | Installers and packages | `.apk .xapk .aab .ipa .dmg .pkg .mpkg .app` (zipped bundles) `.deb .rpm .appimage .snap .flatpakref` | extension and magic |
    | Java | `.jar .jnlp .class` | extension and magic. Note that Mach-O's `CAFEBABE` magic is shared with Java class files: block both. |
    | Disk images used to get around Windows' "downloaded from the internet" warning | `.iso .img .vhd .vhdx` | extension and magic |
    | Macro-enabled Office | `.docm .dotm .xlsm .xltm .xlam .pptm .potm .ppam` | extension, and an OOXML `vbaProject.bin` part even in a plain `.docx`/`.xlsx`. Legacy `.doc .xls .ppt` with VBA macros are blocked by olevba/oletools detection. |

  - **Not blocked: text and source code**, for example `.js .ts .py .sh .rb .php .c .go .rs`.
    - Sharing code is a core use: files.gg's text and paste feature. These are served as `text/plain` and only download when asked.
    - The CDN's existing forced-text rule for HTML, SVG and XHTML stays.
    - The Windows script types in the table above (`.bat .cmd .ps1 .vbs .wsf .hta`…) stay blocked, because Windows runs them on double-click.
  - **Archives** (`.zip .7z .rar .tar .gz .tgz .xz .zst`) are **allowed but inspected**, because zipping executables is the most common way around a blocklist.
    - The `scan` job reads the archive's **file listing** without extracting it, with caps on entries (10,000), nesting depth (3) and expansion ratio, to stop zip bombs.
    - It rejects the archive if any entry matches the blocklist.
    - ClamAV scans the contents.
    - **Password-protected archives can't be scanned:**
      - anonymous uploads: rejected;
      - signed-in uploads: allowed, with a "This archive is encrypted and couldn't be scanned" warning on the download page.
    - The viewer shows the archive's **file listing** as a file tree. That's a nice extra over notsobot.
  - **Timing:** blocklist checks run in `finalize_upload` (single-request uploads check before the blob is stored). Archive inspection runs in `scan`, so an archive stays `scan_state = pending` (not public) until it passes, using the same gate as CSAM scanning.
  - **Serving rules:** see "Hardening cdn.files.gg" below. Decided 2026-11-24: keep the `cdn.files.gg` name and lock it down, instead of moving user content to a separate domain.
- [ ] **Hardening `cdn.files.gg`: keep the name, block every route a malicious file could take** (decided 2026-11-24).
  - **Why a separate domain is the textbook answer.** `cdn.files.gg` is same-*site* with `files.gg`, so a file that manages to run code there could:
    1. read or set cookies scoped to `.files.gg`;
    2. send same-site requests that carry `SameSite` cookies;
    3. host convincing phishing pages on a trusted name;
    4. get the *whole* domain flagged by Google Safe Browsing.
  - **Keeping the name means closing each of those routes directly:**

  **A. Nothing uploaded can ever run as a page on `cdn.files.gg`.**
  - **Sandbox every response.** Every CDN response, whatever its type, gets:

    ```
    Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg
    ```

    `sandbox` without `allow-scripts` or `allow-same-origin` makes any document an **opaque origin**: no scripts, no forms, no cookies, no storage, and it can't navigate the top window. Even if something slips past the type rules, it can't touch `files.gg`.
  - **Every response also gets:**
    - `X-Content-Type-Options: nosniff`
    - `Cross-Origin-Opener-Policy: same-origin`
    - `Referrer-Policy: no-referrer`
    - `Cross-Origin-Resource-Policy: cross-origin`, so images and video can still be hot-linked and embedded elsewhere.
  - **`inline` only for an allowlist of passive types:**
    - images, except SVG, which stays `text/plain`;
    - audio and video;
    - plain text, including HTML, SVG, XHTML and XML forced to `text/plain` (kept from today).

    Everything else is `Content-Disposition: attachment`, including PDFs. **Today the CDN serves everything `inline` by default (`cf-worker/worker/domains/cdn.js:39-46`).**
  - **PDFs** open in the files.gg viewer through **pdf.js**, with `isEvalSupported: false` and PDF scripting off. pdf.js fetches the bytes from the CDN; the browser's own PDF plugin never renders them on `cdn.files.gg`.
  - **Host roles stay strictly separate:**
    - `cdn.files.gg` serves **only** user bytes and derived assets: no app JS, no login, no API.
    - The app's JS and CSS come from `files.gg`.
    - The API stays at `api.files.gg`.

  **B. No cookies or credentials a file could reach.**
  - **Auth stays header-based.** The API token lives in `files.gg`'s localStorage (origin-scoped, so `cdn.files.gg` can't read it) and is sent in `Authorization`. That's true today; keep it.
  - **No auth cookie, ever.** The API never authenticates from a cookie, so a same-site request from `cdn.files.gg` carries nothing useful (no CSRF surface).
  - **Any cookie `files.gg` does set** (for example the Phase 5 rollout flag) uses the **`__Host-` prefix**: `Secure`, `Path=/`, no `Domain`. The browser then refuses to let `cdn.files.gg` set or overwrite it.
  - **Tighten CORS.** Today the API and the worker send `access-control-allow-origin: *` with `allow-credentials` (`api/app.py:69-72`, `cf-worker/worker/index.js:19-22`).
    - Authenticated API routes: allow only `https://files.gg`, plus the app origin used during the rollout.
    - Public read-only routes can stay `*`, without credentials.
  - **On `files.gg` itself:** a strict CSP (`script-src 'self'` plus the Turnstile host), `frame-ancestors 'none'` (except the viewer embeds that need it), and HSTS with `includeSubDomains` and preload.

  **C. Stop malware before it's stored, and keep looking afterwards.**
  - **Upload time:**
    - The type blocklist works on the actual bytes (above).
    - ClamAV runs with the **unofficial signature feeds** for wider coverage, plus **YARA** rules for common droppers.
    - ~~A **hash reputation** lookup against abuse.ch MalwareBazaar.~~ Not in Milestone 4 (decided 2026-11-25: ClamAV official signatures only); kept as a future option in `contracts/milestone-4.md` §5.6.
    - Avoid VirusTotal's free API: its terms forbid commercial use.
  - **Document checks:**
    - **Office:** oletools (`olevba`, `oleid`) blocks macros and DDE or external-template links.
    - **PDF** (pdfid-style keyword scan):
      - *block* `/Launch`, embedded executables (`/EmbeddedFile` of blocked types) and `/RichMedia`;
      - *flag for review* `/JavaScript` and `/OpenAction` (pdf.js won't run them anyway).
  - **Rescanning:** a file that was clean at upload can be detected later, once signatures update. The `scan` job re-runs on every file at **24 h and 7 days** after upload, and on every file whenever a high-severity signature update lands.
  - **Links inside files:** URLs extracted from text, Markdown and PDF uploads are checked against **Google Web Risk** (the commercial-use version of Safe Browsing). A hit puts the file up for review and blocks the "open link" affordance in the viewer.

  **D. Filenames can't trick anyone.**
  - Strip Unicode bidi controls, such as U+202E: the "right-to-left override" trick that shows `invoice‮fdp.exe` as `invoiceexe.pdf`.
  - Strip zero-width characters and control characters.
  - Collapse whitespace runs, and cap the length.
  - The *real* extension is always shown in the UI and is what `Content-Disposition` uses: `filename*=UTF-8''…`, RFC 6266.
  - A double extension like `photo.jpg.zip` is shown in full, never truncated to hide the end.

  **E. Catch active campaigns, not just bad bytes.**
  - **Hot-file circuit breaker.** A file from an anonymous or new account (under 7 days old) that suddenly gets many downloads from many IPs (for example over 500 distinct IPs in an hour) is **automatically held** (`scan_state = review`) and goes to the moderation queue. This is what a malware or phishing campaign using files.gg as a host looks like. Thresholds live in config.
  - **Download interstitial.** Archives and other non-previewable files from anonymous uploaders (or accounts under 7 days old) link to a files.gg **download page**, not straight to the CDN. The page shows the uploader type, the scan result and "Only download files from people you trust".
    - A direct CDN hit on such a file redirects to that page, unless it carries a short-lived signed `?d=` token that the page issues.
    - Images, video and audio are never affected, so hot-linking keeps working.
  - **New-account limits:** accounts under 7 days old get the anonymous limits for archives and executable-adjacent types.

  **F. Protect the domain's reputation.**
  - Verify `files.gg` and every subdomain in **Google Search Console**, so a Safe Browsing flag alerts staff at once.
  - Subscribe to Google's Safe Browsing alerts and Cloudflare's abuse notifications. All of them route into the P0/P1 moderation alerts.
  - Publish `/.well-known/security.txt` and an `abuse@files.gg` address that creates a report automatically. A takedown within hours is what keeps a flag on one path from spreading to the whole host.
  - **Accepted trade-off:** with user content on a subdomain, a Safe Browsing flag on `cdn.files.gg` can still hurt `files.gg` more than a separate domain would. Parts C, E and F exist to keep that from ever happening. If it does happen repeatedly, the fallback is to move raw bytes to a separate domain *behind* `cdn.files.gg` links, with a redirect, without breaking any URL.
  - **Viewer coverage for the wider set:**
    - Markdown rendered with sanitising, with a "View source" toggle.
    - CSV/TSV as a table (first 1,000 rows).
    - JSON pretty-printed and collapsible.
    - Fonts as a type specimen.
    - Archives as a file tree.
    - **Later:** 3D models (glTF, STL, OBJ) with a three.js viewer, and Office documents through a first-page thumbnail from the `derive` job (LibreOffice in the sandboxed worker).
    - Everything else gets the generic download card.
- [ ] **Media processing: metadata, thumbnails, posters, cover art** (decided 2026-11-24). This brings files.gg to parity with what nsb.gg's viewer and notsobot.com's tiles show.
  - **What the frontends expect, from their bundles:**
    - **nsb.gg's viewer reads `thumbnail: {url, type}`:**
      - video uses it as the `poster`;
      - audio shows it as artwork, large when `type === "cover"` and as a shorter strip otherwise;
      - with no thumbnail, audio falls back to a music icon.
    - It also reads `width`, `height`, `duration` (ms) and `framecount`.
    - **notsobot.com's 64px tiles:**
      - use a thumbnail when one exists;
      - otherwise show the image itself;
      - a video plays muted and looped on hover, with a ▶ badge;
      - audio shows a music icon.
  - **Per content, not per file:** processing is keyed by `FileHash`, so a de-duplicated upload is processed only once.
    - Outputs live in B2 under `derived/<hash_id>/<kind>.<ext>`.
    - They're listed in a `file_hash_assets` table, and blob garbage collection deletes them along with the blob.
  - **Two jobs** run in the `worker` service (§2.1):
    - **`probe`** is fast: it fills the metadata, so the viewer gets real dimensions within seconds.
    - **`derive`** is slower: it creates the images and previews.
    - The upload returns immediately. Until processing finishes, the viewer and the dashboard fall back gracefully, as nsb.gg does: icons, plus `aspect-ratio` once `probe` lands.

  | Kind | `probe` stores | `derive` creates |
  |---|---|---|
  | **Image** (png/jpg/webp/avif…) | `width`, `height` (after EXIF rotation), format, has-alpha | `thumb` webp at 320 px and 640 px (2×) for dashboard tiles. Skipped when the original is already small. |
  | **Image not supported by browsers** (HEIC, TIFF, PSD…) | the same | also a full-size `preview` webp, so the viewer can show it; Download still serves the original |
  | **Animated** (gif, apng, animated webp/avif) | `framecount`, total `duration`, loop count | a static `thumb` from the first frame, plus a small muted mp4 `hover` clip of up to 3 s for tiles. That's cheaper than playing a large GIF in a 64 px tile. |
  | **Video** | `width`/`height` (respecting the rotation tag), `duration`, fps, video and audio codecs, `has_audio`, and **`playable`**: does the codec/container play in browsers? | a **`poster`** webp at ≤1280 px, picked with ffmpeg's `thumbnail` filter from the first ~10% (capped) so it isn't a black first frame; the 320 px `thumb`; and the 3 s muted `hover` clip. Not browser-playable (for example HEVC in mkv): the viewer shows the poster and Download instead of a broken player. Transcoding is a possible later feature. |
  | **Audio** | `duration`, codec, bitrate, sample rate, channels, and tags (title, artist, album) | **`cover`**: the embedded album art, extracted with ffmpeg (the attached picture stream). With no embedded art, a **`waveform`** image (`showwavespic`) instead, which drives nsb.gg's non-cover strip. Also a `peaks` JSON (~1,000 points), so the player can draw a waveform seek bar. |
  | **PDF** | page count, page size | `thumb` of the first page (poppler `pdftoppm`) |
  | **Text/code** | line count, detected language | a `snippet` of the first ~12 lines (≤1 KB) stored in metadata for dashboard tiles; no image |
  | **Other** | none | none; the tile shows a type icon by extension |

  - **Serving.** Never expose hashes: derived assets go through the CDN worker *by vanity*, for example `cdn.files.gg/files/<vanity>/poster.webp`, `…/cover.webp`, `…/thumb.webp` and `…/hover.mp4`. The worker resolves vanity → hash → B2 key, and the assets are cached long (immutable per hash).
  - **API and viewer contract.** File objects and the viewer's inlined `file-data` gain:
    - `media`: `{ width, height, duration, framecount, playable, has_audio, codecs, tags, pages, lines }`;
    - `thumbnail`: `{ url, type: "thumb" | "poster" | "cover" | "waveform", width, height }`;
    - `hover_url`;
    - `processing: true` until `derive` finishes.

    `thumbnail` picks the best asset for the file's kind: the poster for video, cover then waveform for audio, otherwise thumb.
  - **Security: untrusted media goes into the parsers we know are risky.**
    - The worker runs as non-root, with network access only to Postgres and B2, and a per-job CPU, memory and wall-clock limit (for example 60 s).
    - Pillow's decompression-bomb pixel limit stays on.
    - ffmpeg runs with `-protocol_whitelist file,pipe` so a crafted file can't make it fetch URLs.
    - No ImageMagick.
    - A job that fails or times out marks the asset `failed`, and the file still works, just without previews.
- [ ] **Trust & safety: illegal-content blocking, NSFW labelling, reports and moderation** (decided 2026-11-24 to build this).
  - Today there's no scanning or reporting at all; the only protection is forcing HTML and SVG to `text/plain`. Anonymous public file hosting attracts abuse quickly, so this ships **with** the relaunch, not after it.
  - notsobot.com has the same building blocks: content flags with `needsHumanReview` and `autoConfirmed`, a reports queue, and an NSFW flag that blurs its tiles.
  - **Get legal advice before launch.** The items below are an engineering plan, not legal advice.

  **1. Child sexual abuse material (CSAM): zero tolerance, hash-matched before anything is public.**
  - **Gate publication.** A new image, video or animated file starts as `scan_state = pending`. Until it passes, the CDN and the viewer serve it to **no one**, uploader included, and show "Processing…".
    - The hash check is fast (usually under a second), so normal uploads barely notice.
    - If the scanning service is down, files stay pending and the job retries. Fail closed, never open.
  - **Use established industry hash-matching. Never build your own CSAM detector or train anything on such material.**
    - **Cloudflare's CSAM Scanning Tool.** Free for Cloudflare customers, and files.gg is already behind Cloudflare. It matches images served through Cloudflare's cache against known-CSAM hash lists and blocks matching URLs at the edge. Turn it on as the day-one baseline.
    - **Pre-publication matching inside `scan`.** This catches content before it is ever served, which the edge tool can't. Options:
      - Microsoft **PhotoDNA** Cloud Service: free for qualifying services, but needs an application.
      - Thorn **Safer**: paid. It covers video too, adds a classifier for previously unseen material, and has a built-in reporting workflow.
    - Videos are matched on sampled frames.
  - **On a match:**
    1. Block the file immediately; it never becomes public.
    2. Suspend the uploader (account, guest and IP).
    3. Add the hash to `blocked_hashes`, so re-uploads are rejected in `finalize_upload`.
    4. Restrict the evidence to a locked-down preservation store, with no moderator viewing. Do **not** just delete it: US law (18 U.S.C. § 2258A, as extended by the 2024 REPORT Act) requires providers to report apparent CSAM to NCMEC's CyberTipline and to preserve it for a set period (currently one year).
    5. File the report through the vendor's integration or NCMEC's ESP registration.
    - Hash-matched material is never shown to moderators.
  - **Other countries:** with UK and EU users there are further duties (for example under the UK Online Safety Act and the EU Digital Services Act). Part of the legal review.

  **2. Other prohibited content** (in the Terms, enforced through reports plus the checks below):
  - **Non-consensual intimate imagery:** match against **StopNCII.org**'s hash list (platforms can partner with them).
  - **Terrorist content:** Tech Against Terrorism's free **TCAP** alerts. GIFCT's hash-sharing database needs membership; consider it later.
  - **Malware:**
    - ClamAV scans executables, archives and Office or PDF documents in the `scan` job.
    - A detection shows a warning page instead of downloading, or blocks the file outright, depending on the signature class.
    - HTML and SVG stay forced to `text/plain`.
  - **Near-duplicates:** store a **PDQ** perceptual hash (Meta's open-source image hash; TMK+PDQF for video) alongside the exact hashes. Re-uploads that were re-encoded or resized then also hit `blocked_hashes`.

  **3. NSFW labelling (legal adult content).**
  - **Classifier:** run a self-hosted open NSFW image model in the `worker` service, on CPU, over the derived images:
    - the image `thumb`;
    - the video `poster` plus about 8 frames sampled evenly through the video;
    - a few frames of animated images;
    - audio `cover` art.

    Self-hosting keeps costs and privacy under control. Hosted APIs (Google Cloud Vision SafeSearch, AWS Rekognition moderation labels, Hive, Sightengine) are the fallback if the open models' accuracy isn't good enough.
  - **Fields:** `File.nsfw` plus `nsfw_score` and `nsfw_source` (`auto` / `uploader` / `moderator`).
    - The automatic mark applies at score ≥ 0.85.
    - Uploaders can mark their own files NSFW at upload time or later. They can't un-mark a file the classifier flagged; they can ask for review instead.
    - Moderators can override either way.
  - **Viewer:** an interstitial ("This file may contain sensitive content", with a **Show** button), plus a per-viewer "Always show sensitive media" setting stored in localStorage.
  - **Dashboard:** tiles are blurred, with an icon, as notsobot.com does.
  - **Embeds:** NSFW files get **no `og:image` or `og:video`**, just a text card saying "Sensitive content", so Discord never shows the media inline.
  - **Policy (decided 2026-11-24): adult content is allowed, and always marked NSFW.**
    - Only **signed-in** users may upload it. An anonymous upload the classifier scores as NSFW is rejected with `NSFW_REQUIRES_ACCOUNT`, which says "Sign in to upload sensitive media".
    - The Terms require uploaders to mark adult content themselves. The classifier is the safety net, not the only gate.
    - A signed-in user whose files keep getting flagged when they didn't mark them gets a warning, then upload restrictions.
    - The legal review in §4 must confirm whether hosting marked adult content triggers age-verification duties where files.gg has users (for example the UK Online Safety Act, and US state laws).

  **4. Reports and moderation.**
  - **Reporting:** see part 5, "Report system" (decided 2026-11-24 as a full system, not just a button).
  - **Admin section** (staff only, through a `User.flags` role bit), modelled on notsobot.com's admin pages:
    - a reports queue;
    - a content-flags queue (classifier and scanner hits needing review);
    - user and file lookup;
    - actions: hide, remove, block hash, mark NSFW, suspend user, ban guest/IP.
  - **Moderator safety:** media in the queue is blurred and greyscale by default, and revealed one item at a time. Hash-matched CSAM is never displayable.
  - **Audit log:** every action is written to an audit log. This is a `moderation_actions` table: actor, action, the target as nullable `file_id` / `album_id` / `user_id` / `report_id` FKs (`ON DELETE SET NULL`, so the trail survives deletions; schema fix 3), reason and `created_at timestamptz`. The never-created `FileAuditLog` model went away with Peewee.
  - **What visitors see:** removed files show "This file was removed for violating the Terms" (HTTP 410) instead of a 404.
  - **Copyright (US DMCA):**
    - Register a DMCA designated agent with the US Copyright Office to get safe-harbour protection.
    - Add a takedown form and a counter-notice flow.
    - Adopt a repeat-infringer policy (for example, suspend after 3 upheld notices).
  - **Anonymous uploads** are the riskiest source. Beyond the stricter limits, consider requiring a Turnstile challenge on anonymous uploads.
  - **Schema:**
    - `File`: `scan_state`, `moderation_state` (`visible` / `hidden` / `removed`), `nsfw`, `nsfw_score`, `nsfw_source`
    - `FileHash`: `pdq`, `blocked`
    - new tables: `blocked_hashes`, `content_flags`, `moderation_actions`, plus the report tables in part 5
  - **Legal pages:** update the Terms (prohibited content, NSFW rules, enforcement, repeat infringers) and the Privacy policy (scanning, third-party scanning vendors, report handling). Both pages already exist in the frontend.

  **5. Report system** (modelled on notsobot.com's, from its bundles).
  notsobot.com has:
  - statuses `open`, `resolved` and `dismissed`;
  - a reason picker;
  - anonymous reports at `/reports/anonymous` with a Turnstile token, and a "sign in to hear back" prompt;
  - a "My reports" page with message threads, an unread count and reopening;
  - errors `CANNOT_REPORT_YOURSELF`, `MAX_REPORTS` and `CAPTCHA_INVALID`;
  - a warnings list that users acknowledge (`/users/@me/warnings`).

  files.gg adapts each piece.

  - **What can be reported:**
    - a **file** (from the viewer, a dashboard drawer or a vanity URL);
    - an **album**: its title, description or captions, or the album as a whole. Reports on a specific item still target that file;
    - a **user**, from their profile or admin pages, for patterns of abuse;
    - a **bug** in files.gg itself, which goes to a separate queue.
  - **Where:**
    - a **Report** button in the viewer footer and in the ⋯ menu on shared files;
    - a "Report" link in embed descriptions (`files.gg/<vanity>/report`), so people who only saw the file in Discord can report it;
    - a public **report form** at `files.gg/report` that takes any files.gg or cdn.files.gg URL.

    You can't report your own files (`CANNOT_REPORT_YOURSELF`); delete them instead.
  - **Reasons:**

    | Reason | Priority | Automatic effect |
    |---|---|---|
    | Child sexual abuse material | P0 | The file is hidden immediately and the CSAM flow in part 1 starts. The reporter sees "Thank you. This has been escalated", nothing more. |
    | Non-consensual intimate imagery | P0 | Hidden immediately until reviewed. |
    | Violence, terrorism or credible threats | P1 | Hidden after 2 reports from distinct reporters. |
    | Malware or phishing | P1 | Hidden after 2 distinct reports, or at once if ClamAV agrees. |
    | Unmarked adult content | P2 | Auto-marked NSFW after 2 distinct reports; the moderator confirms. |
    | Copyright (DMCA) | P2 | Goes to the DMCA form, which needs the formal notice fields (identification, good-faith statement, signature). Not auto-hidden: a valid notice gets a prompt takedown and a counter-notice option. |
    | Harassment or private information | P2 | Hidden after 3 distinct reports. |
    | Spam | P3 | Hidden after 3 distinct reports. |
    | Other | P3 | none |

    "Distinct" means different accounts, or different guest and IP pairs. Thresholds live in config.
  - **Reporter flow:**
    1. Pick a reason.
    2. Add details: required for "Other" and DMCA, optional otherwise, max 2,000 characters.
    3. Optionally add a contact email if not signed in.
    4. Submit.

    Rules:
    - **Anonymous reports** need a Turnstile token (`CAPTCHA_INVALID`).
    - **Rate limits:** per account, guest and IP (for example 10 an hour), with `MAX_REPORTS` once exceeded. One open report per reporter per file; a duplicate adds to the existing report.
    - **Confirmation:** "Report sent". Signed-in reporters see it in **Dashboard → My reports**. Anonymous reporters get the "Sign in to hear back" hint, and a status email if they gave an address.
  - **"My reports"** (dashboard section, signed in only):
    - a list with status, filters and search;
    - a message thread with staff;
    - an **unread badge** in the sidebar;
    - **Reopen** on a dismissed report, once and within 14 days, as notsobot.com allows;
    - closes automatically 30 days after resolution.
  - **The other side: notices and appeals** for the uploader:
    - When a moderator hides or removes a file, marks it NSFW or restricts an account, the uploader gets a **warning** in **Dashboard → Notices**, with an unread badge and an **Acknowledge** button (as notsobot.com does). It says what happened, which rule applied, and when.
    - Each notice has an **Appeal** button (once per action). The appeal opens a thread in the moderation queue for a *different* moderator where possible.
    - CSAM actions are excluded: no notice detail and no appeal path that could interfere with the report to law enforcement.
    - Warnings build up for the repeat-offender rules: for example 3 upheld warnings in 90 days means uploads are restricted, and the next means suspension.
  - **Admin queue** (part 4's admin section, in detail):
    - Columns: priority, age, reason, target, reporter count, current file state, assigned moderator.
    - Sorted P0 first, then by age.
    - Filters: status, reason, assignee, "needs second review".
    - Moderators **claim** a report, so two people don't work the same one.
    - Bulk actions across reports for the same file.
    - Canned responses for the reporter and uploader messages.
    - "Translate" on non-English messages, as notsobot.com has.
    - Every decision records `resolved` (with the action taken) or `dismissed` (with a reason). The reporter gets a short, neutral update, without naming the uploader or the details of the action.
    - **Everything stays on the website** (decided 2026-11-24): no Discord channel or outside alerting.
      - Staff see new reports in the admin section: an unread badge in the dashboard sidebar, a P0 banner on every admin page, and optional **browser notifications** (the Web Notifications API while a staff tab is open, or Web Push if the staff member opts in).
    - **Promise less** (decided 2026-11-24):
      - The public copy makes **no time-bound promises**. It says "We review every report. Child-safety reports are prioritised."
      - **The real protection is automatic:** P0 reports hide the file immediately, and P1 reports after 2 distinct reporters, without waiting for a human.
      - Internal goals, shown only to staff: P0 reviewed within 24 h, everything else within 7 days. The admin overview shows how many are past those goals.
      - Even with loose targets, apparent CSAM must still be reported to NCMEC "as soon as reasonably possible" once someone at files.gg actually knows about it (see Trust & safety part 1). That duty is legal, not a service promise, so P0 still sorts to the top.
  - **API:**

    | Endpoint | What it does |
    |---|---|
    | `POST /reports` | Signed-in report |
    | `POST /reports/anonymous` | Anonymous report (needs `turnstile_token`) |
    | `GET /users/@me/reports` | List your reports (`?status&query&offset&limit`) |
    | `GET /users/@me/reports/:id` | One report |
    | `GET` / `POST /users/@me/reports/:id/messages` | Read or add messages in the report's thread |
    | `PATCH /users/@me/reports/:id { status: "open" }` | Reopen |
    | `GET /users/@me/reports/unread` | Unread count |
    | `GET /users/@me/warnings` | Your notices |
    | `POST /users/@me/warnings/acknowledge { ids }` | Acknowledge notices |
    | `POST /users/@me/warnings/:id/appeal` | Appeal a notice |
    | `/admin/reports` (and related) | Staff only; `User.flags` role bit |

  - **Schema:**
    - `reports`:

      | Column | Notes |
      |---|---|
      | `id` | |
      | `kind` | `file` / `album` / `user` / `bug` |
      | `file_id` / `album_id` / `user_id` | real FKs. A `CHECK` requires exactly one for file, album and user reports, and none for bug reports (schema fix 3). |
      | `reason` | |
      | `priority` | |
      | `status` | `open` / `resolved` / `dismissed` |
      | `reporter_user_id` | NULL for anonymous |
      | `reporter_guest_id` | |
      | `reporter_ip_hash` | hashed, never the raw IP |
      | `contact_email` | NULL if none given |
      | `details` | |
      | `assignee_id` | |
      | `resolution_action` | |
      | `created_at` | |
      | `resolved_at` | |
      | `reopened_at` | |

    - `report_messages`: `report_id`, `author_user_id`, `is_staff`, `body`, `created_at`.
    - `report_reads`: unread tracking.
    - `user_warnings`: `user_id`, `action_id` → `moderation_actions`, `rule`, `message`, `acknowledged_at`, `appeal_state`.
  - **Privacy:**
    - Reporter identity is never shown to the uploader.
    - IPs are stored only as salted hashes, for rate limits and distinct-reporter counting.
    - Report records are kept for a retention period set in the Privacy policy, except CSAM evidence, which follows the legal preservation rules in part 1.
- [ ] Add `app` and `api` to the vanity blacklist (see §1.4).
- [x] Remove the hardcoded secret fallbacks *(Milestone 1; the proxy secret is now the `PROXY_SECRET` binding. Still to do: rotate it when setting it)*: fail at boot if `SECRET_KEY` or `RPC_KEY` is missing. Rotate the proxy secret.
- [ ] Tokens: add a `token_version` on `User`, bump it on logout or "reset token", and let users regenerate their API/ShareX tokens.
- [ ] Uploads:
  - [ ] Stream to a temp file while hashing, instead of reading the whole file into memory.
  - [ ] Enforce `get_limits()` (max file size, storage, expiry); see "Limits".
  - [ ] Queue the `probe` and `derive` jobs once the file is stored (see "Media processing" below).
- [ ] New endpoints, shaped like notsobot.com's:
  - [ ] `GET /users/@me/files?query&sort_by&type&temporary&offset&limit` returns `{ count, items, size, total:{count,size} }`.
  - [ ] `DELETE /users/@me/files/:id` (actually deletes; garbage-collect the blob when its last `File` reference goes).
  - [ ] `POST /users/@me/files/delete { file_ids }` for bulk delete.
  - [ ] `PATCH /users/@me/files/:id { filename }` to rename. It changes the name only: the extension stays tied to the mimetype.
  - [ ] `GET /users/@me/limits` for storage used, counts by type, and the limits from `get_limits()`.
  - [ ] `PATCH /users/@me/files/:id { expires_at }` and `POST /users/@me/files/expiry { file_ids, expires_at }` (see "Expiry").
- [ ] Return typed error codes in a consistent `{ code, message }` body.
- [ ] Count views once per real viewer IP, using the trusted client IP (§2.1) and the daily, privacy-preserving view tables from schema fix 1, not once per worker lookup.
- [ ] Keep the old `/files` routes working until the old frontend is retired.

### Phase 2: Viewer (nsb.gg style), `files.gg/<vanity>`

- [ ] Worker `stable.js`:
  - [ ] Render the shell with `data-page`/`data-state` and inline the file JSON in `<script id="file-data">`.
  - [ ] Switch the OG tags to `property=`.
  - [ ] Add `og:image:width`/`og:image:height` and video dimensions now that the API probes them.
  - [ ] Use the derived assets in embeds:
    - video gets the **poster** as `og:image`, alongside `og:video`;
    - audio gets the **cover** or waveform;
    - images that browsers can't show (HEIC, TIFF…) get the `preview`.
    - Files marked NSFW get no image in their embed (see "Trust & safety").
- [ ] States: file / missing / unavailable / home card, each with a files.gg-branded empty state.
- [ ] Image: checkerboard background, click-to-zoom lightbox, Esc to close, GIF/APNG/WebP animation. Formats that browsers can't show (HEIC, TIFF, PSD) display the derived `preview`.
- [ ] Media from the pipeline:
  - video uses the `poster` and shows "Can't play in browser" with a Download button when `playable` is false;
  - audio shows the `cover` (large) or the `waveform` strip, a waveform seek bar from `peaks`, and the tag line "Artist: Title";
  - while `processing` is true, fall back to icons, as nsb.gg does.
- [ ] Video/audio player:
  - [ ] Port and modernise `media/playable`: speed 0.25× to 2×, keep-pitch toggle, fullscreen, and keyboard shortcuts (space, ←/→, m, f).
  - [ ] Save volume/mute to `filesgg.volume`/`filesgg.muted`.
- [ ] Text/code, using a **Shiki** read-only viewer as nsb.gg does (see Appendix A):
  - [ ] Monaco stays only as an optional "open in editor" mode.
  - [ ] `#L5-L9` line anchors, and keep `?line=` working as a redirect to them.
  - [ ] A "too large to preview" fallback.
- [x] **PDF display** (decided 2026-11-24). *(Viewer built in `web/src/viewer/pdf/`. Still needed: the `probe` page count and the first-page `thumb` from Milestone 3.)* The CDN serves PDFs as downloads (`attachment`), so the files.gg viewer renders them itself with **pdf.js**, never the browser's plugin.
  - **Loading:**
    - pdf.js and its worker form a lazy chunk, fetched only for `kind: "pdf"`.
    - The worker script is served from `files.gg` (`worker-src 'self'`).
    - Document fetches use CDN range requests (`rangeChunkSize` 64 KB; the CDN exposes `Content-Range`), so page 1 shows before the whole file downloads.
  - **Safety settings:**
    - `isEvalSupported: false`
    - `enableScripting: false`: PDF JavaScript never runs.
    - Links in the annotation layer open through a **"You're leaving files.gg"** interstitial showing the full URL, plus the Web Risk result when a link was flagged at scan time.
  - **Rendering:**
    - A canvas per page at the device pixel ratio, with a **text layer** (select, copy) and an **annotation layer** (links, form fields read-only).
    - Pages render lazily as they scroll into view: the visible pages plus 2, with far-off canvases released, so 500-page documents stay smooth.
  - **Controls:**
    - page `n / total` with a jump box;
    - zoom: fit width (the default), fit page, 50–400%, Ctrl/⌘ + wheel or pinch;
    - rotate;
    - fullscreen;
    - **search** (Ctrl/⌘-F inside the viewer, with next/previous and highlights, using pdf.js's find controller);
    - a **page thumbnail sidebar** on desktop, virtualised and collapsible;
    - **outline** (bookmarks) when the PDF has one;
    - Download / Raw.
  - **Keyboard:** ←/→ or PgUp/PgDn for pages, Home/End, +/− to zoom, `f` for fullscreen, Ctrl/⌘-F to search.
  - **Deep links:** `#page=N` (and `#page=N&zoom=…`), kept in sync with `replaceState` as you scroll.
  - **Password-protected PDFs:** a password prompt, decrypted in the browser only. The password never leaves the page.
  - **Fallbacks:** a malformed or unsupported PDF shows "Can't preview this PDF" with Download. In the footer, `media.pages` from `probe` shows as "12 pages".
  - **Card sizing:** per Appendix A, `min(62.5rem, --media-max-width)` wide and the full `--media-max-height`. Fullscreen fills the viewport.
  - **Elsewhere:** the dashboard drawer reuses the same component. Embeds use the first-page `thumb` as `og:image`.
- [x] **Album page** (`files.gg/a/<vanity>`) *(viewer built in `web/src/viewer/album/`; the album API and the worker injection come in Milestones 2–3)*, sharing the viewer bundle and booting from inlined `album-data` JSON, the same way files use `file-data`:
  - **Header:** title, description, item count and total size, expiry, **Copy link**, **Download all**, **Report**.
  - **Layouts:**
    - **`auto` / `grid`:** a responsive justified grid of thumbnails at their aspect ratio. Video tiles show the poster, a ▶ badge and the hover clip. Audio shows its cover. PDFs show their first page. Other files show a type tile. Captions appear under items.
    - **`list`:** one item per row at full card width, each rendered with its normal viewer renderer. Good for screenshots and comics.
    - **`tracklist`:** used automatically when every item is audio. A large cover (the album cover or the first track's art), artist and album from tags, and numbered tracks with durations. Clicking plays, playback continues to the next track, and there's a persistent player bar with prev, next, shuffle and repeat.
  - **Lightbox:**
    - Clicking an item opens a full-screen carousel.
    - Navigation: ←/→, swipe on touch, Esc to close.
    - Shows the item's own viewer (image zoom, video and audio player, PDF, text) and its caption, `n / total`, and per-item Download, Raw and Copy link.
    - The URL updates to `/a/<vanity>/<n>`.
  - **NSFW:** one interstitial for the whole album, not one per item.
- [ ] Card footer: filename, size, dimensions or duration, "Uploaded \<relative\>", expiry, and buttons for **Copy link**, **Download** and **Raw**.
- [ ] If you are the owner: **Rename** and **Delete** inline.

- [ ] **Lock screen** for `password` files and albums:
  - **Shown:** the files.gg card with a lock icon, "This file is password protected", a password field (with a show toggle) and **Unlock**.
  - **Hidden:** the filename, type, size and preview, unless the owner opted to show the name.
  - **Errors** say how long to wait when rate-limited.
  - **Auto-unlock** from a `#pw=` fragment, which is then stripped from the URL.
  - **After unlocking,** the normal viewer renders with token-signed media URLs, refreshed in the background.
  - **`private` files** show the normal "doesn't exist" state to everyone except the signed-in owner.

### Phase 3: Dashboard (notsobot.com style), `files.gg/app`

Sidebar sections:

1. **Overview.**
   - Storage meter (used vs. the limit from `/users/@me/limits`). It turns amber at 80% and red at 95%; at 100% it explains why uploads are blocked.
   - Counts by type, an "expiring soon" list (next 7 days), a recent uploads strip, and a quick-upload dropzone.
2. **Files.**
   - Table view by default, with a grid view toggle.
   - Columns: ☐, thumbnail + name, link (copy), type, size, uploaded, expires (relative time, amber when under 24 h), ⋯ actions.
   - **Thumbnails** follow notsobot.com's tiles:
     - images show their `thumb`;
     - videos show the poster with a ▶ badge and play the muted `hover` clip on hover;
     - audio shows the cover, or a music icon;
     - PDFs show the first page, and text shows its `snippet`;
     - NSFW files are blurred, with an icon.
   - Row and bulk actions: **Set expiry…** (1 hour / 1 day / 7 days / 21 days / custom / never) and **Keep forever**.
   - **Access column:** an icon for link, password (lock) or private (eye-off), with a filter for it.
   - **Change access…** (row and bulk), with:
     - the three levels;
     - a password field with **Generate**, which shows the passphrase once, with copy and "Copy link with password";
     - **Stay unlocked for** (10 min, 1 h, 1 day, 7 days, 30 days) and **Password works until** (never, 1 day, 7 days, 30 days, custom);
     - "Show name on lock screen";
     - a warning that changing access breaks existing password links.
   - Search (debounced), sort (newest, oldest, largest, name), type filter chips (image/video/audio/text/other) and a "temporary" filter.
   - Pagination at 25 per page; page, sort and filter live in the URL search params.
   - Multi-select with shift-click ranges, select all, a "N selected · X MB" bar, bulk delete behind a confirmation dialog, and optimistic updates.
   - Clicking a row opens the viewer in a side drawer that reuses the Phase 2 components.
3. **Upload.**
   - Drop anywhere on the page, paste from the clipboard, or use a file picker; supports multiple files.
   - An **access picker** next to the expiry picker:
     - **Anyone with the link** (the default);
     - **Password**: type one, or **Generate**;
     - **Only me** (signed in only).

     A generated password is shown once in the batch summary, with "Copy link with password" on each result.
   - An **expiry picker** above the queue:
     - signed in: Never (the default), 1 hour, 1 day, 7 days, 21 days, or custom;
     - anonymous: 1 hour, 1 day, 7 days, or 21 days (the default), with the note "Anonymous uploads are deleted after at most 21 days. Sign in to keep files."
   - The client checks file sizes against `/users/@me/limits` before uploading, so a too-big file fails right away instead of after a long upload.
   - Each file gets a queue row with a progress bar (XHR `upload.onprogress`), cancel and retry buttons, and the typed error message if it fails.
   - Large files upload in chunks (see "Chunked, resumable uploads" in Phase 1). Their queue rows add **Pause** and **Resume**, and an interrupted upload offers "Re-select *name* to resume" after a reload.
   - When a file finishes, show its copyable link and an "Uploaded N files" toast.
   - Text tab: paste text, pick a filename and syntax (keeps the current feature).
4. **Integrations.**
   - **Upload keys** (see "Human verification and upload keys"):
     - a list of your keys showing name, the first few characters of the key, the last time it was used, and when it was created;
     - **Create key**: the full key is shown **once**, alongside a ready-made ShareX `.sxcu` download and a curl snippet;
     - **Revoke** for each key.
   - Each `.sxcu` uses its own upload key, never your login token. That fixes the current config, which embeds the full login token (`dashboard.configs.js:46-57`).
   - An iOS Shortcut too, if wanted.
5. **Settings.**
   - **Domains (premium):**
     - add a domain;
     - a setup card with the exact CNAME and TXT records and copy buttons;
     - live status (waiting for DNS → issuing certificate → active);
     - **Set as default** and **Remove** for each domain;
     - an **Only my files** switch for each domain, on by default. Turning it off asks for confirmation;
     - an account-wide **Only show my files on my domain** switch (domain-only mode). Turning it on shows how many files.gg links will stop working, and needs confirmation;
     - for non-premium users, a short explanation of the feature instead of the form.
   - Profile: files.gg username and avatar, owned by files.gg.
   - Login methods: email and password (add or change); a "Connected accounts" list with Link/Unlink Discord, where Unlink is disabled when it is the last login method.
   - Default text editor and data export.
6. **My reports.** Reports you've sent, with status, staff message threads, an unread badge and Reopen. See "Report system" in Phase 1.
7. **Notices.** Moderation actions on your files or account, with Acknowledge and Appeal buttons. These show as a banner on every dashboard page until acknowledged.
8. **Albums.**
   - **List:** a grid of album cards (collage, title, count, updated).
   - **Editor:**
     - title and description;
     - layout picker;
     - cover picker;
     - drag-to-reorder grid (keyboard reorder too);
     - inline captions;
     - **Add files**: a picker over your library with search and type filters;
     - remove item;
     - delete album, with an "Also delete the files" checkbox.
   - **Files table:** multi-select offers **Add to album…** (an existing or new album).
9. **Convert** (also public at `files.gg/convert`, where anonymous visitors use the same page without the history).
   1. **Pick a source:** drop or paste a file, or choose one from your library or an album.
   2. **Pick a target:** the type is detected, and the available formats show as chips. Common goals are shown first: **"Make it play everywhere (MP4)"**, **"Shrink for Discord"**, **"Extract audio"**, **"GIF → MP4"**, **"Remove photo location data"**.
   3. **Options:** a form generated from `/conversions/formats`, with a size estimate where possible (for example target-size video).
   4. **Convert:** a live progress bar (SSE) with Cancel.
   5. **Result card:** a preview using the viewer renderers, the size before and after, Copy link, Download, "Convert again", and "Add to album".
   - **History:** source, target, status, size change and output link, with re-run and delete.
   - **Batch:** in the Files table or an album, multi-select → **Convert…** shows one combined progress list.
   - **Entry points elsewhere:**
     - a **Convert** button in the viewer footer (any public file);
     - the "Convert to MP4 to play in browser" prompt on videos that can't play;
     - "Convert all" in the album header.

- [ ] Anonymous uploads keep working: the guest flow (the old app's fingerprint, renamed in milestone-5 §20) stays, and anonymous files are claimed on login as they are today.
- [ ] Mobile: the sidebar collapses to a drawer, the table becomes a list of cards, and the upload button floats.

### Phase 4: Brand refresh

- [x] **Logo picked: F2 "Folded tile f."** (2026-11-24): a rounded green tile with a page-fold corner, a lowercase f and the dot from `.gg`. The fold sets it apart from the generic "f in a rounded square" outline (Facebook). Every asset is generated by `python3 branding/build.py`; see `branding/README.md`.
- [x] Final vector work:
  - [x] the mark;
  - [x] the wordmark, drawn from strokes so it doesn't depend on a font;
  - [x] favicons at 16, 32 and 48 px, plus `apple-touch-icon` 180 and an SVG favicon;
  - [x] the OG default image (1200×630).
- [x] Design tokens as CSS variables *(Milestone 1, `web/src/styles/theme.css`)* in the Tailwind v4 `@theme`. Proposed starting values:

  | Token | Value | Note |
  |---|---|---|
  | `--gg-green` | `#3DEB7E` | the bright green from the current logo |
  | `--gg-green-600` | `#2CC47A` | |
  | `--gg-green-800` | `#1B7945` | |
  | `--bg` | `#1E1F22` | |
  | `--surface` | `#2B2D31` | |
  | `--surface-2` | `#313338` | |
  | `--line` | `#3F4147` | |
  | `--text` | `#F2F3F5` | |
  | `--muted` | `#B5BAC1` | |
  | `--danger` | `#F04747` | |
  | `--warn` | `#FAA61A` | |
  | `--theme-color` (meta) | `#3DEB7E` | |

- [ ] Light theme as a stretch goal: the dark theme stays the default, as on nsb.gg.

### Phase 5: Rollout

- [x] Before adding a second API server, ship the Snowflake node-id fix *(Milestone 1; it still has to be deployed)* (§2.1 item 2).
- [ ] **Safety gates before launch:**
  - Cloudflare CSAM Scanning Tool enabled;
  - pre-publication hash matching live, failing closed;
  - NCMEC reporting path registered and tested end to end with the vendor's test hashes (never real material);
  - the report system live: file, user and bug reports (signed in and anonymous), My reports, Notices and appeals, the admin queue with on-site P0 banners and browser notifications;
  - Terms and Privacy updated;
  - DMCA agent registered;
  - **`cdn.files.gg` hardening verified with a test suite:**
    - upload HTML, SVG, a PDF with `/JavaScript`, a polyglot (an image that is also a zip or HTML), a renamed `.exe`, an archive containing an `.exe`, an encrypted archive, a macro `.docx`, and a bidi-trick filename;
    - assert each one is blocked, forced to text or sandboxed;
    - check the CDN's response headers with securityheaders.com;
    - confirm a page on `cdn.files.gg` can't set a `__Host-` cookie for `files.gg`;
  - Search Console set up, and `security.txt` and the `abuse@` mailbox live.
- [ ] Load-test the streaming and chunked uploads with **two or more API servers** behind the load balancer. Spread the chunks of one session across servers on purpose, and run several `worker` replicas to confirm each scheduled task runs once.
- [ ] Launch the new stack on `files.gg`, `cdn.files.gg` and `api.files.gg`: a new database and a new B2 bucket. The old site and its data are retired, not migrated.
- [x] Remove the old Mithril frontend and the legacy `/files` list route. *(The route in Milestone 3; `frontend/` itself in Milestone 7.)*
- The launch runbook, every step that's an account, a form or a setting: [`LAUNCH.md`](LAUNCH.md).

---

## 4. Open questions for Dan

1. ~~Discord login?~~ **Yes, as a linked identity decoupled from the account.** ~~Discriminators?~~ **No: unique usernames plus an optional display name.** Both decided 2026-11-24.
2. ~~GCS or R2?~~ **Backblaze B2.**
3. ~~Should files expire?~~ **Uploads can choose an expiry. Anonymous uploads expire automatically, after at most 21 days.**
4. ~~Quotas or plans?~~ **A storage limit per user now; plans later.**

Items 2–4 were decided 2026-11-24. These follow-ups are still open:

- ~~Default limits?~~ **Starting defaults accepted (2026-11-24); tune them later in config:**

  | | Signed in | Anonymous |
  |---|---|---|
  | Storage | 10 GB | n/a (files expire instead) |
  | Max file size | **1 GB with chunked uploads** (the website); **100 MB with single-request uploads** (ShareX, curl, upload keys). Decided 2026-11-24. | 25 MB |
  | Rolling cap | none | 500 MB per 24 h, per guest and per IP |
  | Expiry | optional, 1 h to never | required, at most 21 days (default 21 days) |

- ~~Claimed files on sign-up?~~ **They keep their expiry, and a "Keep forever" button counts toward the storage limit** (decided 2026-11-24; see "Expiry" in Phase 1).

Open, from "Trust & safety" (Phase 1):

6. ~~Adult content policy?~~ **Allowed, always marked NSFW, signed-in uploaders only** (decided 2026-11-24). The age-verification question is part of the legal review (item 8).
7. ~~**CSAM hash-matching vendor?**~~ **PhotoDNA** (decided 2026-11-25): free, needs an application, covers images. Built behind a vendor-neutral interface. Cloudflare's tool is on regardless.
   - PhotoDNA: free, needs an application.
   - Thorn Safer: paid, covers video and unseen material, includes reporting.
8. **Legal review before launch:**
   - NCMEC reporting registration;
   - DMCA designated agent;
   - the Terms and Privacy updates;
   - UK/EU obligations;
   - whether hosting marked adult content requires age verification anywhere files.gg has users.
   - *Decided 2026-11-25 (Dan; the lawyer confirms): the operator is in the US (so an EU legal representative), adult content is hidden from the UK instead of age checks, and the minimum age is 13, or 16 in the EU and EEA. Details and what to build: [`LAUNCH.md`](LAUNCH.md) "Decisions".*
9. ~~Turnstile on anonymous uploads?~~ **Human verification on the website, upload keys for ShareX and tools** (decided 2026-11-24; see "Human verification and upload keys").
10. ~~Separate user-content domain?~~ **No: keep `cdn.files.gg` and harden it** (decided 2026-11-24; see "Hardening cdn.files.gg").
11. ~~Should anonymous visitors convert?~~ **Yes, with smaller limits** (decided 2026-11-24). Starting defaults, in config through `get_limits()`:

    | | Signed in | Anonymous |
    |---|---|---|
    | **Allowed conversions** | everything in the format table | images, animated (GIF ↔ MP4/WebM), audio, **short video**, PDF → images. **Documents → PDF is signed-in only** (LibreOffice is the heaviest and riskiest converter). |
    | **Max input size** | 500 MB | 50 MB |
    | **Video length** | 30 min | 60 s, output capped at 720p |
    | **PDF → images** | 200 pages | 20 pages |
    | **Images → PDF** | 200 images | 20 images |
    | **Processing time per day** | 30 CPU-min | 3 CPU-min, per guest *and* per IP |
    | **Conversions per day** | 200 | 10, per guest *and* per IP |
    | **At once** | 3 | 1 |
    | **Batch convert** | yes (Files table, albums) | no, one file at a time |
    | **Turnstile** | no | yes, on every conversion |
    | **Queue priority** | normal | lower. When the `converter` queue is busy, signed-in jobs run first, and anonymous jobs that wait over 10 min are cancelled with "Busy, try again or sign in". |
    | **Output expiry** | your default (can be never) | at most 21 days (anonymous rules), default 21 days |
    | **Output access** | any level | link or password |

    When an anonymous visitor hits a limit, the error explains which one, and offers "Sign in for bigger conversions".
12. ~~Where does Postgres run, and how is it backed up?~~ **Postgres 19.0 (latest major) in Docker, with restic + Ofelia backups to B2, matching `notsobot.api`'s setup** (decided 2026-11-24; built; §2.1 item 8).
    - ~~**Still open:** where the API and worker servers themselves run.~~ **One dedicated server for the whole stack** (decided 2026-11-25, [`contracts/milestone-7.md`](contracts/milestone-7.md) decision 1).
13. ~~Backblaze region?~~ **US** (decided 2026-11-24).
14. ~~Email provider?~~ **Postmark** for sending (decided 2026-11-24; built). Cloudflare Email Routing (free) for receiving `abuse@`, `support@` and `dmca@`.
    - `api/utils/email.py` sends over Postmark's HTTP API.
    - Messages are rendered in code (`api/utils/email_templates.py`, HTML plus plain text, usernames escaped). Open and link tracking are off, because the emails carry one-time links.
    - Failures return a generic 503 and log Postmark's reason for staff only.
    - Mailgun's mailbox check at sign-up is replaced by an MX-record check (`api/utils/email_domain.py`, dnspython). It allows sign-up if DNS itself is down, since the verification email is still required.
    - **Config:** `POSTMARK_SERVER_TOKEN` (required in compose) and `EMAIL_FROM` (default `files.gg <noreply@mail.files.gg>`).
    - **Before launch:** add `mail.files.gg` as a Postmark sender domain with DKIM, a custom Return-Path, SPF and DMARC (`p=none` first), and send tests to Gmail, Outlook and iCloud.
15. ~~Google reCAPTCHA or Turnstile?~~ **Turnstile everywhere on the website** (decided 2026-11-24).
16. ~~Signed-in max file size?~~ **1 GB chunked, 100 MB single-request** (decided 2026-11-24).
17. ~~Who handles reports, and how fast?~~ **Everything stays on the website (no Discord channel); no public time promises** (decided 2026-11-24; see "Report system").
18. ~~Custom domains?~~ **Yes, as a premium feature, using Cloudflare for SaaS, subdomains only** (decided 2026-11-24; see "Custom domains"). Still open:
    - ~~how many domains premium includes?~~ **5** (decided 2026-11-25);
    - whether root domains are worth Cloudflare's apex proxying later.
19. ~~Email provider?~~ **Postmark**: see item 14.
5. ~~Logo direction?~~ **F2 "Folded tile f."** (decided 2026-11-24).

---

## Appendix A: nsb.gg viewer spec

This is reverse-engineered from nsb.gg's public `viewer.js` and `viewer.css`. Treat it as a reference for behaviour, not a copy of their design: files.gg keeps its own colours and logo.

**Boot payload** (`<script id="file-data" type="application/json">`):

| Field | Type | Used for |
|---|---|---|
| `kind` | string | Picks the renderer: `image`, `video`, `audio`, `text`, `pdf` or `file`. |
| `mimetype`, `extension` | string | Shown as "Type"; used for syntax-language detection and for ImageDecoder. |
| `filename` | string | Title, alt text, the `download` attribute. |
| `size` | bytes | "Size", and the text size gates. |
| `width`, `height` | px | "Dimensions" (W×H), and the `aspect-ratio` set before the media loads. |
| `duration` | ms | "Duration"; also the player's fallback before metadata loads. |
| `framecount` | int | When above 1, the image is animated: the custom canvas player is used and a "Frames" row appears. |
| `thumbnail` | `{url, type}` | Video poster or audio cover art; `type:"cover"` gives a larger art box. |
| `uploadedAt`, `expiresAt` | ms epoch | "Uploaded 3 days ago" with the full date as a tooltip. Expiry shows as amber "Expires in…", or red "Expired" once past. A 30 s timer keeps these labels current. |
| `cdnUrl` | url | `src`. Download is `?download=true`; Raw opens in a new tab. |

**Boot states.** `data-page="home"` renders the landing card. `data-state="unavailable"` shows a Retry button. A null payload means `missing`.

**Layout:**
- **CSS variables:** `--footer-height: 13.5rem`, `--media-max-width: min(90vw, 100vw - 1.5rem)`, `--media-max-height: calc(90dvh - var(--footer-height))` and `--media-min-width: min(25rem, 100vw - 1.5rem)`.
- **Media width:** `min(Wpx, --media-max-width, --media-max-height × W/H)`, with `aspect-ratio: W/H`.
- **Width caps by type:** text 75rem, PDF 62.5rem, audio 35rem.
- **Card:** 8px radius, 1px border, `0 9px 30px rgba(6,6,7,.3)` shadow. The media well is darker than the card. Footer padding is `px-4 pt-3 pb-3.5`.
- **Checkerboard background:** `repeating-conic-gradient(#26282c 0 25%, #1e2023 0 50%) 0 0 / 16px 16px`.
- **Resize handles:** only when the pointer is a mouse or similar (`pointer: fine`). They are mirrored, so a drag moves both sides by twice the delta. Size is clamped to 280px…(viewport − 24) wide and 180px…(viewport − 64) high. Double-click resets the size.

**Player.** The same player is used for video, audio and animated images.
- **Bar:** 40px high. It overlays video and images with a gradient, and sits as a solid bar under audio.
- **Controls, in order:** play/pause/replay, `mm:ss / mm:ss` (hours appear once a file is an hour or longer), seek, volume (a vertical popover), speed, fullscreen.
- **Auto-hide:** after **2500 ms**, the controls and cursor hide. They stay visible while paused or while a control is being used.
- **Seek bar:** 6px tall (8px while dragging), shows the buffered range, has a hover time tooltip, and uses pointer capture.
- **Speed:** 0.25× to 2× in 0.25 steps, plus a "Keep Pitch" toggle (`preservesPitch`).
- **Persistence:** volume and mute are saved on `volumechange`. This plan uses `filesgg.volume` and `filesgg.muted`, with every `localStorage` call wrapped in try/catch.
- **Keyboard** (ignored when Alt, Ctrl or Meta is held):

  | Key | Action |
  |---|---|
  | Space or `k` | Play/pause |
  | ← / → | Seek 5 s |
  | `j` / `l` | Seek 10 s |
  | ↑ / ↓ | Volume ±5% |
  | Home / End | Jump to start / end |
  | `0`–`9` | Jump to that tenth of the file |
  | `m` | Mute |
  | `<` / `>` | Speed down / up |
  | `,` / `.` | Step one frame (animated images only) |
  | `f` | Fullscreen |

  Improvement over nsb.gg: only handle these keys while the player has focus, or when it is the only media on the page.
- **Fullscreen:** calls `requestFullscreen` on the container, falling back to `webkitEnterFullscreen` for iOS video. Double-click also toggles it.
- **Not included:** there is no PiP or loop toggle. Both are cheap wins we could add.

**Animated images** (only when `framecount > 1` and the browser has `ImageDecoder`):
- The CDN response is streamed into `ImageDecoder` and drawn to a `<canvas>` on a requestAnimationFrame clock.
- Frames of 10 ms or less are clamped to 100 ms, matching browser GIF behaviour.
- `repetitionCount` is respected.
- An invisible `<img>` is laid over the canvas so right-click "save image" still works.
- Fallback is a plain `<img>`.

**Text:**
- Over 10 MiB: no preview.
- Over 2 MiB: plain `<pre>` with no line numbers.
- Shiki highlighting (`github-dark-dimmed`, lazy-loaded languages) only runs for files of 512 KiB or less and 20,000 lines or fewer.
- Language is picked from the extension, then an alias map (h→c, mjs→javascript, svg→xml, …), then the MIME type.
- Line-number gutter: click to select `#L5`, shift-click to select `#L5-L9`. The selection uses `replaceState` and scrolls into view, centred.

**Analytics:** an Umami `before-send` hook rewrites every URL to `/:file/<kind>`, so file IDs never reach analytics. **Copy this.** The only events are `Download{kind}` and outbound clicks.

**Easter egg:** hovering the logo swaps it for a random effect image from a shuffled bag (no repeats until every image has been shown). It would be a fun fit for the files.gg mark.
