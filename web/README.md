# files.gg web

The files.gg frontend: React 19, Vite, TypeScript, Tailwind CSS v4, react-router, TanStack Query and lucide. It replaces the old Mithril app outright, with nothing kept for it (milestone-3 contract §0). The spec is `docs/redesign/PLAN.md` (Phase 2, Phase 3, Phase 4 and Appendix A).

It builds three entry points:

| Entry | Served at | What it is |
|---|---|---|
| `viewer.html` | `files.gg/`, `files.gg/<vanity>[.<ext>]`, `files.gg/a/<vanity>[?item=<n>]`, `files.gg/convert`, and the report pages `files.gg/report`, `files.gg/report/<vanity>` and `files.gg/report/a/<vanity>` | The file viewer and album page. A small bundle that boots from data the worker inlines into the HTML, with no API call. The PDF viewer, the album page, the video/audio player, the text viewer (with Shiki), the lock screen and the report form are lazy chunks. |
| `app.html` | `files.gg/app` and `files.gg/app/*` | The dashboard SPA. Every page is its own lazy-loaded chunk. |
| `challenge.html` | `files.gg/challenge` (milestone-6 §10.10) | The Turnstile frame for custom domains. No React and no API calls: it renders the widget and posts each token to the one custom-domain origin it was served for. About 4 KB of JavaScript (2 KB gzipped). |

The viewer also serves **custom domains** (`i.example.com/<vanity>`, milestone-6 §10.8–§10.11): the same bundle, told by the Worker that it's on a customer's domain. See [Custom domains](#7-custom-domains-milestone-6) below.

The viewer never imports dashboard code, react-router, TanStack Query or the API client. ESLint enforces this (`no-restricted-imports` on `src/viewer/**` and `src/components/**`), and each entry has its own CSS file that only scans its own sources. Two lazy chunks do talk to the API: the lock screen (`src/viewer/locked/`) and the report form (`src/viewer/report/`). On files.gg they go through `lib/api`; on a custom domain through `src/viewer/locked/hostApi.ts`, which calls `api.files.gg` without credentials and rehosts the URLs it gets back.

## Running it

Needs Node 24+ (developed on Node 26, npm 11).

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs to web/dist
npm run preview    # serves web/dist
npm run typecheck
npm run test
npm run lint
npm run fixtures   # regenerates web/fixtures/ (dev-only sample media)
```

The dashboard and the files.gg viewer call the API **same-origin at `/api`** (milestone-6 §13.1), the Worker's `files.gg/api/*` passthrough, so the session cookie goes with them. `VITE_API_URL` overrides the base only for unusual local setups (see `.env.example`).
- **Builds** use `/api`.
- **`npm run dev`** mounts the in-memory **mock API** (below) at `/api` unless `VITE_API_URL` is set, for example to a local API in `.env.local`.
- **The real stack locally:** `e2e/up.sh` builds this app (into `e2e/.local/web-dist`, not `dist`) against the local API and serves it through the Worker on `http://files.localhost:8787`. See `e2e/README.md`.

**Turnstile:** set `VITE_TURNSTILE_SITE_KEY` for production builds, which warn when it's missing. Dev and tests use Cloudflare's documented testing key `1x00000000000000000000AA` (always passes; https://developers.cloudflare.com/turnstile/troubleshooting/testing/). It issues the dummy token `XXXX.DUMMY.TOKEN.XXXX`, which the mock accepts the way the testing secret keys do. All five testing site keys and three testing secrets are in `src/lib/config.ts`.

In dev and preview, `/app` and `/app/*` serve `app.html`, `/challenge` serves `challenge.html`, and `/`, `/convert`, `/a/<vanity>` and `/report/…` serve `viewer.html`. In dev, a bare vanity such as `/private123` does too. The same rewrites happen in production (see below).

### Mock API (dev only)

`mock-api.ts` is a Vite middleware mounted same-origin at `/api` (like the production `files.gg/api/*` passthrough) that implements the Milestone 2, 3, 4 and 6 contracts in memory, so the whole flow works with no backend. It's never part of a build. `mock-api.test.ts` covers it, including the contract's token, PKCE, state and sign-up token vectors.

**Signing in:** open `/app/login` and use one of the seeded accounts below with the password `mock-password` (Turnstile uses the always-pass testing key). The session is an HttpOnly cookie, `filesgg_session` (the contract's plain-http dev name, milestone-6 §3.2), which JavaScript never sees. Writes need `X-Filesgg-Csrf: 1`, as in production. Signed out, the dashboard works for anonymous uploads through `X-Fingerprint`, and signing in claims them.

| Email | Account |
|---|---|
| `mock@example.com` | `mockuser`, admin with child safety, owns the seeded library, Discord linked, two upload keys, a ready data export, renamed 10 days ago (so the 30-day hold shows) |
| `modmary@example.com` | moderator |
| `member@example.com` | free account with an unverified email |
| `restricted@example.com` / `suspended@example.com` | upload-restricted / suspended |
| `premium@example.com` | `priya`, premium, with domains in every status: `i.priya.example` (active, default), `cdn.` (pending DNS), `img.` (pending certificate), `old.` (failing), `dead.` (failed), `bad.` (disabled by staff, with a notice and an open domain case) |
| `leaving@example.com` | deletion requested, 9 days left: signing in shows Keep my account |
| none | `discordonly` has no email or password; sign in with the mock Discord |

**Emails:** verify and reset links are printed in the dev server's console (`[mock-api] email to …`). Open them to finish verification or a password reset.

**Discord:** Continue with Discord goes to a mock consent page (`/api/__discord/authorize`) that lists accounts: `mockuser` and `discordonly` (linked), `newdiscord` (verified email, signs up with it), `unverifieddiscord`, `noemaildiscord` (sign up without an email) and `takendiscord` (its email belongs to `member`, so sign-up is refused). Cancel returns `error=access_denied`. State, PKCE (S256) and the sign-up token are checked as in milestone-6 §5.

**Domains:** a domain added as `priya` moves from pending DNS to pending certificate after 20 s and becomes active after 40 s. Check now works once a minute.

**Upload keys:** create one in Integrations, then `curl -H "Authorization: Key fgg_…" -F file=@photo.png localhost:5173/api/files`.

**Endpoints:**
- `GET /auth/fingerprint`, `GET /users/@me` and `GET /users/@me/limits`. Signed out you get the anonymous values (by `X-Fingerprint`).
- `POST /files`, with a multipart parser.
- The chunked `POST /uploads`, `PUT …/chunks/<i>`, `GET`, `complete` (moves to `complete` after 1.5 s) and `DELETE`.
- `POST /access/unlock/{files|albums}/<vanity>`, `POST /access/refresh/…` and `GET /access/view/…` (milestone-6 §20.1: the vanity is always last; the old `/{files|albums}/<vanity>/unlock|view` paths are 404).
- `POST /users/@me/{files|albums}/<id or vanity>/pass`, for owner passes.
- Milestone 3 (contract §6):
  - the owner library: `GET /users/@me/files` (search, sort, type, access and temporary filters, paging, totals), `PATCH` and `DELETE /users/@me/files/<id>`, and the bulk `POST …/files/delete`, `…/files/expiry` and `…/files/access`;
  - albums: `POST` and `GET /users/@me/albums`, `GET`/`PATCH`/`DELETE …/albums/<id>`, and `PUT`/`POST …/<id>/files`, `DELETE`/`PATCH …/<id>/files/<file id>`;
  - the public `GET /albums/<vanity>` (locked payload for password albums), and album unlock, refresh and view;
  - `album=<vanity>` on uploads.
- Milestone 4 (milestone-4 §6–§9):
  - owner safety: `safety`, `nsfw`, `warnings` on owner files and upload responses; `GET /users/@me/files/<id>` (with `410 UPLOAD_REJECTED` for 24 h), `PATCH … { nsfw }`, `POST …/files/nsfw`, `POST …/<id>/nsfw-review`, and `PATCH /users/@me/albums/<id> { nsfw }`; albums hide items that aren't `ok` or `flagged`;
  - `GET /users/@me/badges`; reports (`POST /reports`, `POST /reports/anonymous`) and My reports (list, detail, thread, reply, reopen); notices (`GET /users/@me/warnings`, acknowledge, appeal with the copyright counter-notice);
  - restrictions and bans (`403 UPLOADS_RESTRICTED`, `ACCOUNT_SUSPENDED`, `BANNED`), and `FILE_PENDING`, `FILE_REMOVED`, `ALBUM_REMOVED` on unlock and the public album;
  - every `/admin/*` endpoint: summary, cases (claim, release, messages, close, appeal, CyberTipline, second review), actions, bans, audit, lookup, file, album and user detail with staff-signed URLs (`staff=…&expires=…&sig=…`, §10.3), rescans and the staff list. Non-staff get the 404 of an unknown route.

- Milestone 6 (milestone-6 §2–§11): `GET /auth/config`, `GET /auth/session`, login, register, logout, verify and resend, forgot and reset, re-auth, Discord (`/auth/discord/authorize`, `…/callback`, `…/signup`, with a mock consent page at `/api/__discord/authorize`); `GET`/`PATCH /users/@me`, the username (`PUT`, `…/check`), identities and unlinking, sessions, email and password, data exports and deletion with its 14-day lock; upload keys (and `Authorization: Key fgg_…` on the upload endpoints, `401 UPLOAD_KEY_REQUIRED` for tool uploads without one); domains, domain-only and its preview; premium limits; and the admin entitlements, domain cases and actions, `GET /admin/domains[/<id>]`, and the new user actions.

- View limits (milestone-6 §19): `view_limit` and `view_limit_action` on `POST /files`, `POST /uploads` and `PATCH /users/@me/files/<id>` (`400 VIEW_LIMIT_TOO_LOW { views_used }`, `403 FORBIDDEN` for anonymous edits, `400 PRIVATE_REQUIRES_ACCOUNT` for an anonymous `private`); `POST /access/open/files/<vanity>` (Turnstile, rate limit, the file's own access with `401 UNLOCK_REQUIRED` for password files, then counting); a password file's unlock counts as its view. Viewers are counted once per IP (`cf-connecting-ip`, standing in for the abuse IP hash); the owner and staff never count. At the limit, `expire` keeps the file for the last viewer's hour and `private` hides it and bumps `access_version`; anyone new gets `404`. View-limited files are hidden in albums (`hidden_reason: "view_limit"` in the editor).

**Seeded library:** signed in, you start with about 30 files of every kind (images, a HEIC with a `display` preview, a GIF, playable and unplayable videos, tagged audio, PDFs, text with snippets, archives), some password-protected, private, temporary or still `processing`, and three albums (one with a hidden password item, a tracklist, and a password album). It belongs to `mock@example.com` (`mockuser`); the other accounts start empty; the password for protected seed files and albums is `files.gg`.
- `assets` point at generated SVG placeholders (data: URLs) or the `web/fixtures/` media. There's no hover clip, since nothing can generate an MP4 here.
- Text files are served from `/api/raw/<vanity>`, standing in for the CDN.
- New uploads join the uploader's library, stay `pending` (scanning) for `MOCK_SCAN_MS`, then `processing` for `MOCK_DERIVE_MS`, then get placeholder assets.
- **Milestone 4 seed:** your own files in every state (an uploader-marked and a classifier-marked NSFW photo, a hidden meme, a removed video, a blocked archive, an encrypted archive with its warning, and a file still being checked that passes after 90 s), notices for them (one appeal already denied), six reports you sent (open with an unread staff reply, dismissed and reopenable, resolved, closed, a bug, an escalated CSAM report), and other people's content so the admin queue has a case of each kind: file, album, account, hash match (child safety, never displayable), bug and an appeal of a removal you made (so deciding it as Mock User gives `SAME_MODERATOR`).
- **Scan results by filename** (new uploads): `eicar` or `malware` → blocked (malware), `badtype` → blocked type, `blocked` → blocked hash, `held` → held for review, `nsfw` → classified adult, `encrypted` → encrypted archive warning, `pua` → flagged unwanted software. Anonymous uploads that end blocked, NSFW or encrypted are rejected (`410 UPLOAD_REJECTED`).

**Behaviour:**
- Payloads follow milestone-3 §4: snake_case, times in epoch seconds, preview kinds `thumb`, `thumb-2x`, `display`, `poster`, `cover`, `waveform`, `peaks` and `hover`.
- Protected files' and albums' http(s) URLs are signed like the API signs them (milestone-3 §3: `expires` and `sig` over the path, `album=` on album items), with the contract's test secret: until the unlock expires for unlock, view and refresh, and for 1 h in owner payloads. The dev server ignores the query, so the fixtures still load; `data:` placeholders stay unsigned. `mock-api.test.ts` checks the signatures against the contract's test vectors.
- Unlock tokens keep the milestone-2 §1 format (checked against those vectors too); they only travel between the browser and the API.
- Turnstile, rate limits (5 a minute), expiry and the size limits follow the contract.
- Every §7 error code the uploads can hit is reproducible, and so are the album codes (`INVALID_ALBUM_FILES`, `ALBUM_FULL`, `ANONYMOUS_ALBUM_NOT_ALLOWED`, …).

**Knobs (env):** `MOCK_CHUNK_DELAY_MS` (default 400), `MOCK_CHUNK_FAIL_RATE` (default 0, which exercises retries), `MOCK_PROCESSING_MS`, `MOCK_SCAN_MS` (default 2500) and `MOCK_DERIVE_MS` (default 6000).

**View limits:** the seeded `limited-photo.png` (`limited1`, limit 3, 1 used), `limited-notes.pdf` (`limitedpw`, password `files.gg`, limit 5, 2 used, private at the limit) and `burned-after-reading.png` (its private action already fired). `limited-photo.png` is also in the Lisbon album, hidden there with the view-limit note.

**Owner pass:** signed in, `POST /api/users/@me/files/private123/pass` (with `X-Filesgg-Csrf: 1`) returns a `#t=` URL; open `/private123?fixture=private#t=<token>`.

### Viewer fixtures (dev only)

With no backend, the viewer has nothing to boot from. In `npm run dev`, add `?fixture=` to inject sample boot data. It goes into the DOM the same way the worker will, so the real parsing path runs:

| URL | Shows |
|---|---|
| `/viewer.html?fixture=image` | An image file (1200×630) with an expiry 5 hours away. |
| `/viewer.html?fixture=file` | A `.zip`, which gets the generic download card. |
| `/viewer.html?fixture=missing` | A `null` payload: "This file doesn't exist or has expired." |
| `/viewer.html?fixture=unavailable` | `data-state="unavailable"`, with a Retry button. |
| `/viewer.html?fixture=home` | `data-page="home"`, the landing card. |
| `/viewer.html?fixture=pdf` | An 8-page PDF with selectable text, an outline, an internal link, an external link and a landscape page. |
| `/viewer.html?fixture=pdf-password` | The same PDF, encrypted. The password is `files.gg`. |
| `/viewer.html?fixture=convert` or `/convert` | The Convert placeholder. |
| `/viewer.html?fixture=album-grid` or `/a/<anything>` (`?item=<n>` opens item n) | A grid album: images, an unplayable HEVC video with a poster, a PDF and a zip, with captions. |
| `/viewer.html?fixture=album-list` | The list layout. |
| `/viewer.html?fixture=album-tracklist` | An all-audio album (tagged tones with covers), shown as a tracklist. |
| `/viewer.html?fixture=locked` | A password file (`locked1234`), named on the lock screen. The password is `files.gg`, and `#pw=files.gg` unlocks it automatically. |
| `/viewer.html?fixture=locked-short` | A password PDF whose mock `unlock_ttl` is 90 s, to watch the refresh run out and the lock screen return. |
| `/viewer.html?fixture=locked-expired` | `password_expired: true`: "This link's password has expired". |
| `/viewer.html?fixture=locked-album` | A password album (`lockedalbum`, password `files.gg`). Every item, a `link` file included, comes back signed with the album grant (`album=lockedalbum`). |
| `/private123?fixture=private` | A private file: "doesn't exist", unless the URL has a `#t=` owner pass. |

**Milestone 3** (contract §7). Previews in these fixtures are local files with a `?v=` (production URLs are `https://cdn.files.gg/previews/<kind>/<vanity>.<ext>?v=…`); text files, the peaks file and the video clip are `blob:` URLs made in the browser by `src/viewer/fixtureMedia.ts`, so `web/fixtures/` is unchanged. URLs that are never fetched use the real shapes (`/albums/collage/<vanity>.webp`, `/albums/download/<vanity>.zip`):

| URL | Shows |
|---|---|
| `/viewer.html?fixture=video` | The video player with a poster. The clip is a 3 s WebM recorded from a canvas when the page loads (a WAV stands in where `MediaRecorder` is missing). |
| `/viewer.html?fixture=video-unplayable` | `playable: false` (HEVC in MKV): "This video can't play in the browser" with Download. |
| `/viewer.html?fixture=processing` | A video still `processing`: no poster yet, so the type icon holds the space. |
| `/viewer.html?fixture=audio-cover` | Audio with cover art, the "Artist: Title" line and a peaks waveform seek bar. |
| `/viewer.html?fixture=audio-waveform` | Audio without art: the waveform strip (a stand-in image) and peaks. |
| `/viewer.html?fixture=audio-unplayable` | `playable: false` (WMA): Download instead of a player. |
| `/viewer.html?fixture=image-heic` | A HEIC image, shown from `assets.display`. |
| `/viewer.html?fixture=text` | Python, language from `media.language`. Add `#L5-L9` to select lines. |
| `/viewer.html?fixture=text-typescript`, `text-rust`, `text-json`, `text-markdown` | Other languages (TypeScript from the extension alone). |
| `/viewer.html?fixture=text-plain` | Plain text: no Shiki, long lines for the wrap toggle. |
| `/viewer.html?fixture=text-huge` | 3 MB: "Too large to preview" without fetching. |
| `/viewer.html?fixture=text-lines` | 25,000 short lines: "Too large to preview" once fetched. |
| `/viewer.html?fixture=album-huge` | An album over 2 GB: Download all offers per-item downloads. |

**Milestone 4** (milestone-4 contract §2.4, §4.6, §5.7, §7, §11.1):

| URL | What it shows |
|---|---|
| `/viewer.html?fixture=pending`, `pending-album` | "Checking this file…" (or album). The page reloads itself after 2, 3, 5, 8 and 13 s, then every 15 s, and after 2 minutes shows "Still checking" with Retry. |
| `/viewer.html?fixture=removed-review`, `removed-terms`, `removed-copyright`, `removed-malware`, `removed-album` | The removed card for each public reason, with a link to the Terms. |
| `/viewer.html?fixture=blocked` | CSAM-blocked content: exactly the missing card (`missing` + `null`). |
| `/viewer.html?fixture=nsfw` | The sensitive-content interstitial before an image. "Always show sensitive media" sets `filesgg.showSensitive`; clear it in devtools to see the gate again. |
| `/viewer.html?fixture=album-nsfw`, `album-nsfw-item` | The album interstitial: a marked album, and an unmarked album with one NSFW item. |
| `/viewer.html?fixture=warning-encrypted`, `warning-unwanted`, `warning-partial` | Scanner warning banners. The first two ask before Download and Raw. |
| `/viewer.html?fixture=download-only` | An image with `serve_inline: false`: the download card, no preview. |
| `/viewer.html?fixture=pdf-link-warning` | The sample PDF with its external link flagged: clicking it shows the Copy-only warning with Google's attribution. |
| `/viewer.html?fixture=text-link-warning` | A text file with two flagged links, listed in a banner above it. |
| `/viewer.html?fixture=album-link-warning` | Flagged URLs in an album description and caption: plain text with a warning icon, plus the banner in the header. |
| `/viewer.html?fixture=report` or `/report` | The public report form, which asks for a link first. `?url=` prefills it. |
| `/viewer.html?fixture=report-file`, `report-album`, or `/report/<anything>`, `/report/a/<anything>` | The report page for a file or an album (the album one has the part picker). |

Report buttons open the dialog on every file and album fixture. Sending needs the mock API's `/reports` endpoints (`mock-api.ts`). The form asks `GET /auth/session` when it opens (milestone-6 §13.1): signed in, it sends `POST /reports` with no Turnstile; signed out (or if the call fails), it runs Turnstile with the always-pass testing key and sends `POST /reports/anonymous`.

**Milestone 6** (milestone-6 §8.8, §10.8–§10.11, §13.4). Add `&host=custom` to **any** fixture to simulate a custom domain: the page gets `data-host="custom"` and `#host-data` (`host` is this dev server, `main_origin` too, `api_origin` the dev API), and the boot data's URLs are rehosted the way the Worker does it. Unlocks and reports then go credential-less to the dev API, and Turnstile runs in this dev server's `/challenge` frame.

| URL | What it shows |
|---|---|
| `/viewer.html?fixture=domain-home` | A custom domain's `/`: "Files hosted with files.gg" and Report, which reports the domain (always on a simulated custom host). |
| `/viewer.html?fixture=locked&host=custom` | The lock screen with the challenge frame instead of the widget (password `files.gg`). |
| `/viewer.html?fixture=report-file&host=custom` | The report form on a custom domain: no session call, no sign-in links, Turnstile through the frame. |
| `/viewer.html?fixture=locked&host=custom&challenge=error` | The frame reports a failure at once: "Open on files.gg to continue" and Retry the check. |
| `/viewer.html?fixture=locked&host=custom&challenge=silent` | The frame never answers: the same fallback after 15 s, rather than hanging. |
| `/viewer.html?fixture=owner-deleting` | A locked file whose owner's account went pending deletion: unlock answers `404` (password `files.gg`), so the page shows missing, never removed. Works with `&host=custom` too. |
| `/viewer.html?fixture=limited` | A view-limited file (`limited1`): "This file has a view limit. Opening it uses one of its 2 remaining views." Open file runs Turnstile (action `view`) and `POST /access/open/files/limited1`, then the photo with "N views left". The mock counts once per IP, so it opens again without counting. Works with `&host=custom` (the frame asks for `action=view`). |
| `/viewer.html?fixture=limited-password` | A view-limited password PDF (`limitedpw`): the lock screen says unlocking uses one of its 3 remaining views (password `files.gg`). |
| `/challenge?host=localhost:5173&action=unlock` | The frame page on its own. Outside a frame it refuses: "This check only runs inside a page hosted with files.gg." |

`album-grid` also has a `thumb`/`thumb-2x` item (`srcset`) and an item that's still processing.

Add `/<n>` to an album path, for example `/a/demo1234/3?fixture=album-grid`, to open item 3 in the lightbox.

Fixtures live in `src/viewer/fixtures.ts`. They are imported behind `import.meta.env.DEV`, so production builds leave them out.

The media they point at lives in `web/fixtures/`, generated by `scripts/make-fixtures.mjs` with no downloads:
- the PDFs are written by hand, and the protected one uses RC4-128 standard security;
- the PNGs are encoded with zlib;
- the WAV tones are 8 kHz;
- the zip uses store mode.

The dev server serves that folder at `/fixtures/` with Range support. It isn't in `public/`, so none of it ships in a build.

## Worker contract (viewer boot data)

The Cloudflare worker (`cf-worker/worker/domains/stable.js`) renders the viewer shell. The client side is `src/viewer/boot.ts`, which has tests. **The payload formats live in the contract, not here:** [`docs/redesign/contracts/milestone-3.md`](../docs/redesign/contracts/milestone-3.md) §3 (CDN and signed URLs), §4 (the file and album payloads) and §5 (the Worker's internal lookups), plus [`milestone-2.md`](../docs/redesign/contracts/milestone-2.md) §4–§5 for the locked shell and unlock flow. Where they disagree, milestone-3 §0 and §3–§5 win.

### 1. Routing

Handle these in this order, before any vanity lookup:

1. **Static files from `web/dist`**, served as they are:
   - `/assets/*`: hashed JS, CSS and source maps, plus `/assets/brand/*.svg`. Cache them as immutable for a year. `assets` is already in the API's `blacklisted_ids`.
     - This includes the pdf.js worker, `/assets/pdf.worker.min-<hash>.mjs`. Serve `.mjs` as `text/javascript`, or module workers refuse to start.
     - It also includes `/assets/pdfjs/<version>/{cmaps,standard_fonts,wasm,iccs}/*`. Serve `.wasm` as `application/wasm`. These paths are versioned, so they can be cached as immutable too.
   - Root files: `/favicon.ico`, `/favicon.svg`, `/favicon-16.png`, `/favicon-32.png`, `/favicon-48.png`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/og-image.png` and `/.well-known/security.txt` (milestone-4 §10.4; renew its `Expires` yearly). Match these **exact paths** first. Otherwise the vanity router reads `files.gg/favicon.ico` as the vanity `favicon`.
2. **`/app` and `/app/*`** serve `dist/app.html` with `Cache-Control: no-cache`. The plan (§1.4 item 2) still needs `app` and `api` added to `blacklisted_ids`.
3. **`/`** serves `dist/viewer.html` with the `home` state, and **`/convert`** serves it with `data-page="convert"`. `convert` needs to be reserved like `app`.
4. **`/a/<vanity>`** serves `dist/viewer.html` with the album state (below), whatever the query. `a` is reserved (§1.4 item 2). The lightbox item is `?item=<n>` (milestone-6 §20.2), which the client reads, so the worker returns the same album page for every `?item`. Nothing comes after the vanity: `/a/<vanity>/<n>` is missing.
5. **`/<vanity>[.<anything>]`** serves `dist/viewer.html` with the `file`, `missing`, `locked` or `unavailable` state. The bot, ShareX, Telegram and `Accept: image/*` redirects to the CDN happen before the shell is rendered.

The HTML shell must be served with `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-cache` (or `private, no-store` for `unavailable`), because the hashed asset names inside it change on every deploy.

### 2. The `#root` element

`dist/viewer.html` contains a bare `<div id="root"></div>`. Use `HTMLRewriter` on `#root` to set these attributes:

| Case | `data-page` | `data-state` | Script tag | HTTP status |
|---|---|---|---|---|
| `/` | `home` | (omit) | (omit) | 200 |
| File found and not expired | `file` | `file` | `#file-data`: the file payload | 200 |
| Password file | `file` | `locked` | `#file-data`: `{ vanity, protected: "password", filename?, password_expired? }` | 200 |
| Unknown, deleted, expired or private | `file` | `missing` | `#file-data`: `null` | 404 |
| API unreachable, timed out or 5xx | `file` | `unavailable` | (omit) | 503 |
| `/convert` | `convert` | (omit) | (omit) | 200 |
| `/a/<vanity>` with at least one item to show | `album` | `album` | `#album-data`: the album payload | 200 |
| Password album | `album` | `locked` | `#album-data`: `{ vanity, protected: "password", title? }` | 200 |
| Album unknown, deleted, expired, private, or with nothing to show | `album` | `missing` | (omit) | 404 |
| Album API unreachable | `album` | `unavailable` | (omit) | 503 |
| File `pending` (milestone 4) | `file` | `pending` | `#file-data`: `{ vanity, pending: true }` | 200, `private, no-store` |
| File hidden or removed | `file` | `removed` | `#file-data`: `{ vanity, removed: "review" \| "terms" \| "copyright" \| "malware" }` | 410 |
| File blocked (CSAM included) | `file` | `missing` | `#file-data`: `null` | 404 |
| Album with nothing shown yet but items pending | `album` | `pending` | `#album-data`: `{ vanity, pending: true }` | 200, `private, no-store` |
| Album hidden or removed | `album` | `removed` | `#album-data`: `{ vanity, removed: "<reason>" }` | 410 |
| `/report`, `/report/<vanity>`, `/report/a/<vanity>` | `report` | (omit) | `#report-data`: `{ type: "any" }` or `{ type: "file" \| "album", vanity }` | 200 |
| A custom domain's `/` (milestone 6) | `domain-home` | (omit) | (omit) | 200 |

**On a custom domain** (milestone-6 §10.8, §13.4), every row above also gets `data-host="custom"` on `#root` and a `#host-data` script: `{ "host": "i.example.com", "main_origin": "https://files.gg", "api_origin": "https://api.files.gg" }`. An optional `"cdn_origin"` overrides the CDN origin, which otherwise is `https://cdn.` plus the main host. Invalid values fall back to the production origins; `http:` is accepted only for local development hosts.

The milestone-4 rows follow milestone-4 §10.1, which wins where this table and it differ.

The client checks them in this order:

1. `data-page="home"` shows home, `data-page="domain-home"` the custom domain's landing card, and `data-page="convert"` the Convert placeholder. `data-page="report"` shows the report page when `#report-data` is valid, and missing otherwise.
2. `data-state="unavailable"` shows unavailable.
3. `data-state="missing"` shows missing. `data-state="pending"` and `data-state="removed"` show those cards when the script tag holds their shape, and missing otherwise.
4. `data-state="locked"` shows the lock screen when the script tag holds a valid locked payload, and missing otherwise.
5. `data-page="album"` shows the album when `#album-data` holds a valid album with at least one unexpired item, and missing otherwise.
6. A valid file payload shows the file.
7. Anything else shows missing: a `null` payload, no script tag, invalid JSON, or a payload without `filename` or `cdn_url`.

`unavailable` must never be served for a file that really is missing. It tells the user the file still exists.

### 3. The `#file-data` and `#album-data` scripts

Insert them right after `#root`, with `element.after(html, { html: true })`:

```html
<script id="file-data" type="application/json">{"kind":"image",...}</script>
```

**Escape the JSON before inlining it.** Run `JSON.stringify(payload)`, then replace `<` with `\u003c`, `>` with `\u003e`, `&` with `\u0026`, U+2028 with `\u2028` and U+2029 with `\u2029` (each written as those six ASCII characters). Filenames, titles and captions are user input, so none of them may be able to close the tag with `</script>`. The output is still valid JSON.

**The payloads are the API's, passed through as they are** (milestone-3 §4): the file payload for `#file-data`, the album payload (items are file payloads plus `position` and `caption`) for `#album-data`. The parser reads that one shape only, snake_case with times in epoch seconds (`cdn_url`, `uploaded_at`, `expires_at`, `hover_url`, `download_url`, `total_size`, `next_cursor`); camelCase and ISO dates are ignored. Unknown preview kinds, invalid items and expired items (`expires_at <= now`) drop out, and items are sorted by `position`. What the viewer uses from it:
- `kind` picks the renderer (unknown kinds fall back to `file`); `width`/`height` reserve the media's `aspect-ratio`; `processing` shows type icons;
- `cdn_url` is the `src`, Raw and, with `download=true` appended, Download;
- `assets` (`thumb`, `thumb-2x`, `display`, `poster`, `cover`, `waveform`, `peaks`, `hover`) and `thumbnail` drive tiles, posters, cover art, the waveform and the HEIC/TIFF/PSD stand-in;
- `media` (`playable`, `tags`, `pages`, `lines`, `language`) drives the players, the tracklist, the PDF footer and the text viewer;
- `url` is what Copy link copies (else `origin + pathname`); albums also use it for Report;
- `download_url` is Download all (no button without it); `collage` is for embeds;
- `nsfw` shows the sensitive-content interstitial first (milestone-4 §4.6); `warnings` show banners (`unwanted_software` and `encrypted_archive` also confirm Download and Raw); `link_warnings` (files and albums) are links the viewer never opens; `serve_inline: false`, if it arrives, forces the download card and drops previews.

**URLs are used exactly as they arrive.** The client never builds, signs or changes a CDN URL, apart from appending `download=true`. Public (`link`) files and albums have plain URLs; anything protected arrives signed (`expires=…&sig=…`, plus `album=` on album items).

### 4. Protected files and albums (lazy `src/viewer/locked/`)

**Loading:**
- `data-state="locked"` shows the lock screen for a password file or album. A private file is plain `missing`.
- On boot, `#pw=` and `#t=` are read and immediately stripped from the address bar with `replaceState`.

**Order of attempts:**
1. **A `#t=` owner pass:** `GET /access/view/{files|albums}/<vanity>` with `X-Filesgg-Access`. There's no unlock call and it's never stored. It refreshes through `/access/refresh/…` like an unlock, capped at 12 h from minting.
2. **A stored unlock token** (`localStorage["filesgg.access.<kind>.<vanity>"]`, kept until it expires): the same view call. `401` drops the token.
- **`404` from view, unlock or refresh means missing,** for password and private content alike: the API answers it for unknown content and for an owner whose account is pending deletion (milestone-6 §8.8), which is never shown as removed. The stored token is dropped.
3. **Otherwise the lock screen:** a password field with a show toggle, managed Turnstile (action `unlock`) on every attempt, a `#pw=` password tried once automatically, and messages for `WRONG_PASSWORD`, `TOO_MANY_ATTEMPTS` (with a live countdown), `PASSWORD_EXPIRED` and `CAPTCHA_INVALID`.

**After unlocking:**
- Unlock, view and refresh all return the payload with URLs signed for this visitor, plus `token` and `expires_at`. The token is only for the API; it never goes into a URL.
- The token refreshes 5 minutes before expiry (or at half-life if less is left), and stops once the server stops extending it (its cap). `UNLOCK_EXPIRED`, or reaching expiry, returns to the lock screen.
- Each refresh brings fresh URLs, but the page keeps the ones it shows until they're about to expire (2 minutes before their `expires`), then swaps to the newest payload. A refresh never reloads an image, restarts a video or reopens a PDF (`lib/signedUrls.ts`, `useSignedValue`).

**View limits (milestone-6 §19, `locked/LimitedPage.tsx`, lazy):**
- `data-state="limited"` with `#file-data` = `{ vanity, view_limited: true, views_remaining }` shows "This file has a view limit. Opening it uses one of its N remaining views." with **Open file**. A `#t=` owner pass opens it through the view route instead (owners never count).
- Open file runs managed Turnstile (action `view`; the files.gg `/challenge?action=view` frame on a custom domain), then `POST /access/open/files/<vanity>` (same-origin with the session cookie, so the owner and staff aren't counted; credential-less `api.files.gg` on a custom domain). The file then renders normally, and the footer shows "N views left" from `view_limit.remaining`.
- The URLs from open last 1 h (or until the file expires); 5 minutes before that the page opens again with a fresh Turnstile token (the same viewer never counts twice) and swaps URLs the same way as unlock refreshes. If the check needs a click, a small panel shows it.
- `CAPTCHA_INVALID` shows the message and Retry the check; `TOO_MANY_ATTEMPTS` counts down; `UNLOCK_REQUIRED` switches to the lock screen; `404` is the normal missing card, never "limit reached".
- A view-limited password file stays `locked` with the same two fields (`limited` with `protected: "password"` is read the same way): the lock screen adds "This file has a view limit. Unlocking it uses one of its N remaining views.", and the unlock is the view.

### 5. Meta tags

`viewer.html` wraps its default meta tags in `<!-- filesgg:meta:start … -->` and `<!-- filesgg:meta:end -->`. Replace everything between the two markers with the file's own tags: `description`, `og:title`, `og:description`, `og:url`, and `og:image` / `og:video` with their dimensions. Use `property=` and not `name=` (§1.3). For albums, `og:title` is "*Title* · N files" and `og:image` is the collage (PLAN.md "Embeds"). NSFW albums get no image. Leave the default tags in place for `home`, `convert`, `missing` and `unavailable`. The client sets `document.title` itself.

### 6. CSP for the viewer

The PDF viewer needs these directives:
- `worker-src 'self'`, for the pdf.js worker asset;
- `connect-src 'self' https://cdn.files.gg`, for range requests and the same-origin pdf.js data files;
- `img-src` and `media-src` allowing `https://cdn.files.gg`, plus `blob:` and `data:` for pdf.js images;
- `script-src 'self'` and `'wasm-unsafe-eval'`, for the pdf.js wasm decoders.

PDF JavaScript never runs. pdf.js 6 has no `eval` code path; the loader still passes `isEvalSupported: false`. The annotation layer gets `enableScripting: false`, and the scripting sandbox is never loaded.

**Turnstile** (lock screen, and anonymous uploads in the dashboard) adds `script-src https://challenges.cloudflare.com` and `frame-src https://challenges.cloudflare.com`. The script is loaded on demand from Cloudflare, never bundled or proxied (Cloudflare warns that breaks updates). There's no official npm package for the browser widget.

On a custom domain the viewer uses milestone-6 §10.11's `viewerCsp`: `connect-src 'self' https://api.files.gg https://cdn.files.gg` and `frame-src https://files.gg` (the challenge frame) instead of the Turnstile host.

### 7. Custom domains (milestone 6)

The contract is [`milestone-6.md`](../docs/redesign/contracts/milestone-6.md) §10.8–§10.11 and §13.4. What the viewer does with `data-host="custom"` (`src/viewer/host/`):
- **API calls** (unlock, view, refresh, open, anonymous reports) go to `api_origin` with `credentials: "omit"` and no `X-Fingerprint` or CSRF header; view sends `X-Filesgg-Access`. There's never a session on a custom domain, so the report form doesn't ask for one.
- **Rehosting** (`host/rehost.ts`, the §16.5 vectors in `rehost.test.ts`): every `url` and `*_url` value in those responses that starts with the CDN or main origin gets this page's origin instead, with the rest of the string untouched, so path-only signatures still verify. The Worker does the same for the boot data.
- **Copy link** is built on `location.origin`. Titles end with the domain, links to files.gg pages (Terms, "Go to files.gg") go to `main_origin`, and there are no sign-in, upload or dashboard links.
- **Owner passes** (`#t=`) work as on files.gg, redeemed at `api_origin`. Unlock tokens live in the custom domain's own storage, so unlocking on one host never unlocks the other.
- **Turnstile** runs in an iframe of `<main_origin>/challenge?host=<host>&action=unlock|report|view` (`host/useChallengeFrame.ts`). The page accepts a message only when its origin is exactly `main_origin`, its source is that iframe, and it's `{ type: "filesgg:turnstile", token }` (or the frame's `-error` and `-expired` messages). Each token is used once, then the frame reloads for the next. If the frame reports an error or sends nothing for 15 s (Turnstile in a cross-origin frame is unverified, §18), the lock screen and report form show **Open on files.gg to continue**, linking to the same file, album or report page on files.gg, plus **Retry the check**.

**The frame page** (`challenge.html`, `src/challenge/`) reads `#challenge-data` = `{ host, action }`, which the Worker inlines after its domain lookup (query parameters are ignored outside development). It answers only when it's framed, the host is a plain hostname that isn't files.gg or one of its subdomains, and `location.ancestorOrigins` (where the browser has it) names `https://<host>`. It posts with `targetOrigin` `https://<host>`, so the browser drops the message for any other parent, and it never listens for messages. Turnstile runs in managed mode with `appearance: "always"`, `action`, and `cData` = the host with `.` as `_` (Turnstile allows only `[A-Za-z0-9_-]` there). The Worker serves it with the `frame-ancestors https://<host>` CSP from §10.10; it needs no `connect-src` and no `img-src`.

## Layout

```
src/
  app/          dashboard: routes, DashboardLayout (sidebar / mobile drawer), lazy pages
  viewer/       viewer: boot parsing, fixtures, state cards, file card, renderers/
    components/ state cards, file view (NSFW gate, warning banners, download confirmation), Report button
    report/     lazy report chunk: the dialog, the full report page, the form logic (formLogic.ts, tested), sending (send.ts)
    host/       custom domains: host context, rehosting, the challenge frame hook and its fallback, the domain landing card
    links/      Web Risk link warnings: the Copy-only dialog, the banner, Google's attribution
    pdf/        lazy PDF chunk: pdf.js loader, pdfState.ts (pure, tested), viewer, pages, sidebar
    album/      lazy album chunk: layouts, justified grid, lightbox, tracklist, URL sync, Download all
    media/      lazy video/audio player: controls, keyboard, saved volume, peaks seek bar
    text/       lazy text viewer: limits, line anchors, languages; Shiki in a further chunk
  components/   shared by both entries and viewer-safe: Button, CopyButton, Brand (lockup/mark)
    locked/     lazy chunks: lock screen, unlock / view / refresh, owner passes, the view-limit card and open; hostApi.ts routes them by host
  challenge/    files.gg/challenge: the Turnstile frame for custom domains (no React), and its message protocol
  lib/          api client, TanStack Query client and hooks, storage, time and format helpers
    access.ts   unlock tokens: storage, refresh timing, #pw= / #t= fragments
    signedUrls.ts  reading signed URLs' expiry; useSignedValue keeps on-screen URLs until they near expiry
    upload/     chunk scheduler, upload task, resume store, picker rules, error messages, limits check
  styles/       theme.css (tokens), viewer.css and app.css (one per entry)
  test/         Vitest setup
```

### Viewer renderers

`src/viewer/renderers/index.ts` maps `kind` to a component, and anything without an entry gets a generic download card:
- `image`: checkerboard, a click-to-zoom lightbox, Esc to close, and in the album carousel a click toggles fit and actual size;
- `pdf`: pdf.js, lazy;
- `video` and `audio` (`media/`, lazy): the custom player (below);
- `text` (`text/`, lazy): the Shiki viewer (below).

`renderers/assets.ts` picks previews from the payload (never building URLs): `display` for images browsers can't show (HEIC, TIFF, PSD, …), the poster, cover and waveform, and `thumb`/`thumb-2x` for tiles. `FileCard`, album lists and the album carousel wrap renderers in `<Suspense>` with a fallback that holds the media's size. A renderer gets a `context` prop:
- `card`: the single-file page, which may own page-wide keys and `#page=N`;
- `list`: an album's list layout;
- `lightbox`: the album carousel, which owns ←/→ and Esc.

It also gets an optional `onOpen`, so albums can open their own lightbox.

### PDF viewer

`src/viewer/pdf/` is a lazy chunk with pdf.js 6 and its own small viewer. It doesn't use pdf.js's `PDFViewer`, so the render window and the state logic stay ours and testable.

- **Loading.** Documents load through range requests (64 KB chunks, streaming and auto-fetch off). The worker and data files are same-origin.
- **Rendering.** Pages render a canvas at the device pixel ratio, capped near 8.4 MP, plus the text and annotation layers.
  - The visible pages plus 2 hold canvases.
  - A page further than 6 from the visible range releases its canvas.
  - While zooming, the old canvas stretches until the new one is drawn.
- **Controls:**
  - page `n / total` with a jump box;
  - zoom: fit width (the default), fit page, 50–400%, Ctrl/⌘ + wheel and touch pinch. Fit modes may go below 50% on phones;
  - rotate and fullscreen. iPhone has no element fullscreen, so there it fills the viewport instead;
  - search, with next/previous and highlights in the text layer;
  - a collapsible thumbnail sidebar, virtualised, with an Outline tab when the PDF has one;
  - Download and Raw.
- **Keyboard:** ←/→, PgUp/PgDn, Home/End, +/−, `f` and Ctrl/⌘-F.
  - On a single-file page, these work when focus is in the viewer or on nothing.
  - In an album, they work only when focus is inside the viewer.
  - They never fire while typing in an input.
- **Links.**
  - `#page=N&zoom=…` stays in sync through `replaceState`, and editing the hash jumps there.
  - Links in the PDF go through the "You're leaving files.gg" dialog, which shows the full URL.
  - A link in the file's `link_warnings` gets no real `href`; its dialog shows the Web Risk warning and Google's attribution, with Copy link only.
  - Password-protected PDFs prompt for the password and decrypt in the browser.
- **Fallback:** a broken PDF shows "Can't preview this PDF" with Download.

### Album page

`src/viewer/album/` is a lazy chunk:
- **Header:** title, plain-text description with safe links, count and size, expiry, Copy link, Download all and Report (the report dialog, with a part picker).
  - URLs in `link_warnings` are never links: in the description and captions they show as text with a warning icon, which opens the Copy-only dialog, and a banner in the header lists them.
  - **Download all** uses the payload's `download_url` as it is (signed for a protected album), and isn't shown without one. It sends a `HEAD` first (or skips it when the album is known to be over 2 GiB): on `413` it shows "This album is too large to download as one file" with per-item downloads, instead of letting the browser save the JSON error. Any other answer, or a failed check, downloads as usual.
- **Layouts:**
  - a justified grid (`layout.ts`, `justifyRows`), with video, audio, PDF and file tiles, captions under the items, and hover clips. Tiles use `thumb` with `thumb-2x` in `srcset` when derived, and a type icon while an item is processing;
  - a list, where each item uses its normal renderer at full width;
  - a tracklist: cover, tag artist and album, numbered tracks, and a bottom player bar with prev, next, shuffle and repeat on a plain `<audio>` element.
- **Lightbox:** a carousel with ←/→, swipe and Esc, plus per-item Download, Raw, Copy link and Report (which reports that file).
  - The open item is `?item=<n>` (milestone-6 §20.2), written with `history.replaceState` on open, move and close, so the rest of the query and a `#pw=` or `#t=` fragment stay as they are and no history entries are added. Loading `/a/<vanity>?item=<n>` opens item n.
  - The URL logic is `useAlbumLightbox`.
- **NSFW:** one interstitial for the whole album (the shared `components/NsfwGate`), when the album is marked or any item is NSFW. "Always show sensitive media" (`filesgg.showSensitive`) skips it.

### Video and audio player

`src/viewer/media/` is a lazy chunk shared by both renderers:
- **Controls:** play/pause, seek with the buffered range (a native range input over a drawn track, so it's keyboard- and screen-reader-friendly), time, mute and volume, speed 0.25×–2× with a "Keep pitch" toggle (`preservesPitch`), and fullscreen (video; iOS falls back to `webkitEnterFullscreen`).
- **Video:** the poster from a `poster` thumbnail (else `assets.poster`). Controls overlay the bottom and hide after 2.5 s without movement while playing. A click toggles play; a double-click toggles fullscreen.
- **Audio:** the cover as large art, else the `waveform` strip, then "Artist: Title". `assets.peaks.url` is fetched and drawn as a waveform seek bar, with a plain bar while it loads or if it fails.
- **Keyboard** (`keys.ts`): Space or `k`, ←/→ (5 s), `m`, `f`. On a single-file page they work when focus is in the player or on nothing; in albums, only with focus in the player. Space on a focused button presses the button; arrows on the volume slider change the volume.
- **Saved volume:** `filesgg.volume` and `filesgg.muted`, through `lib/storage` (never throws).
- **Not playable** (`media.playable === false`, or a load error): "This video can't play in the browser" (or audio) with Download.
- **Processing:** no poster or cover yet, so the type icon shows.

### Text viewer

`src/viewer/text/` is a lazy chunk. The plain text shows first; Shiki loads after it in its own chunk.
- **Shiki, fine-grained:** `shiki/core` with the JavaScript regex engine (no wasm), files.gg's own small theme (`theme.ts`, from the design tokens) and one grammar chunk per language from a fixed list (`languages.ts`). Plain text never loads Shiki.
- **Language:** `media.language`, else a known filename (`Dockerfile`, `Makefile`, …) or the extension, else plain text. A language outside the list shows as plain text.
- **Limits:** over 1 MiB or 20,000 lines (from `size` / `media.lines`, else after fetching) it shows "Too large to preview" with Download and Raw. Over 512 KiB the preview stays unhighlighted, to stay fast.
- **Fetching:** from `cdn_url` as it is (already signed for protected files).
- **Line anchors:** clicking a line number sets `#L5`, shift-click `#L5-L9`, with `replaceState`. Anchors in the URL are highlighted and scrolled to on load and on hash changes. In albums, the selection stays local and the URL is left alone. `#L…` anchors are not touched by the `#pw=` / `#t=` watcher in `main.tsx`.
- **Toolbar:** language, line count, Wrap toggle and Copy.

### Trust and safety (milestone 4)

- **Pending:** "Checking this file…", reloading itself on a fixed schedule (`components/pendingReload.ts`), with progress kept in `history.state` so it survives reloads without storage. No API polling.
- **Removed:** one sentence per public reason, with a link to the Terms (`/legal/terms`). CSAM-blocked content never reaches the client as anything but `missing`.
- **NSFW:** an interstitial before anything of the file mounts, so no media request is made before Show.
- **Report:** a link to `/report/<vanity>` (or `/report/a/<vanity>`) that opens the lazy dialog on a plain click. When the form opens it asks `GET /api/auth/session` (never on page load): signed in (the HttpOnly session cookie, which JavaScript never reads), it sends `POST /api/reports`; signed out, `POST /api/reports/anonymous` with managed Turnstile (action `report`). On a custom domain it's always anonymous: `POST https://api.files.gg/reports/anonymous` without credentials, with the token from the challenge frame.
- **Lazy pieces:** the pending and removed cards, the NSFW gate, the warning banners and download confirmation, the link-warning banner and the report form are all chunks of their own, so a plain file page doesn't load them.

Each lazy chunk has its own utility stylesheet (`pdf/pdf.css`, `album/album.css`, `media/media.css`, `text/text.css`, `report/report.css`, `links/links.css`, built with `@reference` against the shared tokens), so their classes stay out of the viewer's entry CSS.

### Design tokens

`src/styles/theme.css` defines `--gg`, `--gg-end`, `--gg-fold`, `--gg-ink`, `--gg-on-light`, `--bg`, `--surface`, `--surface-2`, `--well`, `--line`, `--text`, `--muted`, `--danger` and `--warn` on `:root`, with `color-scheme: dark`. `@theme inline` exposes them as Tailwind colours (`bg-surface`, `text-muted`, `border-line`, `text-gg`, …). A light theme would only need to redefine the `:root` values.

### API client

`src/lib/api.ts`:

- Calls same-origin `/api` with `credentials: "same-origin"`; the session is the HttpOnly `__Host-filesgg_session` cookie (milestone-6 §3), so no credential is ever stored or read by JavaScript. Every non-`GET` request sends `X-Filesgg-Csrf: 1` (§3.6); `credentials: "omit"` drops it. `X-Fingerprint` (from `filesgg.fingerprint`) goes only while signed out, for anonymous uploads.
- Signed-in state is `GET /auth/session` (`fetchSession`, `api.session`); the module remembers the last answer (`signedInState()`), and `ensureFingerprint` asks it first. A `401` on a signed-in call, `403 CSRF` and `403 ACCOUNT_PENDING_DELETION` are announced to `onAuthEvent` listeners, which the dashboard turns into "You were signed out.", a generic error, and the Keep my account screen.
- `src/lib/session.ts` holds the session query (`useSession`, stale after 60 s, refetched on focus; `useMe` and `useSignedIn` read it), the `BroadcastChannel("filesgg-session")` that keeps tabs in step, what a sign-in or sign-out resets, and the `next` rules (`safeNext`). `src/lib/accountApi.ts` has the Milestone 6 calls (auth, settings, upload keys, domains), dashboard only; `lib/discord.ts` the PKCE flow; `lib/sharex.ts` the `.sxcu` and curl snippet; `lib/usernames.ts` and `lib/passwordStrength.ts` the form rules.
- Every localStorage access goes through `src/lib/storage.ts`, which never throws. The other keys are `filesgg.access.<kind>.<vanity>` (unlock tokens), `filesgg.uploads` (resumable uploads), `filesgg.volume` and `filesgg.muted`.
- A non-2xx response throws `ApiError { status, code, message, body }`, parsed from the `{ code: "STRING", message, status, ...details }` body; a body without a string code gets `code: null`, and the message falls back on the status. Network failures become `status: 0, code: "NETWORK_ERROR"`.
- Types follow milestone-3 §4 and §6: one `FilePayload` (snake_case, epoch seconds, URLs ready to use), `OwnerFile` on top of it.

`src/lib/queries.ts` has the TanStack Query hooks (`useMe`, `useMyFiles`, `useMyLimits`, `useMyAlbums`, `useAlbum`) and the dashboard's mutations. Owner payloads carry URLs signed for 1 h, so the files and album queries refetch every 40 minutes, and on focus once older than that; an image whose signed URL has expired triggers a refetch too. File mutations update every cached list optimistically, roll back on error and refetch when settled; album mutations do the same on the album's cache entry. Generated passwords are never kept in the cache.

The Milestone 2 calls are typed from the contract:
- `unlock`, `refreshUnlock` and `view`;
- `createUpload`, `uploadStatus`, `completeUpload` and `abortUpload`;
- `ensureFingerprint`.

The Milestone 3 owner calls (contract §6) are `myFiles`, `updateFile`, `deleteFile`, `deleteFiles`, `setFilesExpiry`, `setFilesAccess`, `filePass`, `createAlbum`, `myAlbums`, `album`, `updateAlbum`, `deleteAlbum`, `setAlbumFiles`, `addAlbumFiles`, `removeAlbumFile`, `setAlbumCaption` and `albumPass`. `src/lib/errors.ts` maps every error code, the album codes included, to its message.

The Milestone 4 owner calls (milestone-4 §6–§8) are `myFile`, `setFileNsfw`, `setFilesNsfw`, `requestNsfwReview`, `badges`, `createReport`, `createAnonymousReport`, `myReports`, `myReport`, `reportMessages`, `sendReportMessage`, `reopenReport`, `notices`, `acknowledgeNotices` and `appealNotice`, with hooks in `lib/queries.ts` (`useBadges`, `useMyReports`, `useReportMessages`, `useNotices`, `useAcknowledgeNotices`, `useAppealNotice`, `useSetNsfw`, …). The staff calls (§9) are typed in `src/app/admin/adminApi.ts` with their hooks in `adminQueries.ts`, so they ship in the admin chunk only.

Uploads use XHR (`lib/upload/xhr.ts`) for progress, with the same base, headers (the CSRF header included) and `ApiError` parsing.

### Upload page (`/app/upload`)

**Adding files:**
- Drop anywhere on the page, paste, or pick; multiple files work.
- Each file is checked against `GET /users/@me/limits` first: file size (single or chunked) and storage including what's already queued.

**How files are sent:**
- **10 MiB or less:** one `POST /files` with progress.
- **Larger:** a chunked session:
  - 3 chunks in parallel;
  - retries with exponential backoff and jitter, on network, 408, 429 and 5xx errors;
  - Pause and Resume;
  - polling `complete`.
- **Resuming after a reload:** the session is remembered by `name + size + lastModified`; ids only, never passwords. "Re-select *name* to resume" then sends only the chunks the server is missing.

**Pickers** (rules in `lib/upload/options.ts`):
- **Expiry:** signed in, Never (the default), presets or custom; anonymous, 1 h / 1 d / 7 d / 21 d (default 21 d) with the note.
- **Access:** anyone with the link, a password (typed, or Generate), or Only me (signed in only).
- **Password timing:** "Stay unlocked for" and "Password works until", both capped by the file's own expiry.
- **Adult content (NSFW):** a checkbox when `limits.nsfw_allowed` (signed in and not restricted) that sends `nsfw=true`; signed out, the hint "Sign in to upload sensitive media" instead.
- **Restrictions:** while `GET /users/@me/badges` lists an `uploads` restriction (or a suspension), the page says "Uploads are restricted until <date>" and the dropzone, picker, drop and paste are off.

**Turnstile:** anonymous uploads use it with action `upload`, one fresh token per request.

**Results:**
- Milestone 4: after the bytes are up, the row shows "Checking…" and polls `GET /users/@me/files/<id>` (every 1 s for 30 s, then every 5 s, up to 10 minutes) until the scan answers. The link appears once the file is `ok` or `flagged`; `410 UPLOAD_REJECTED { reason }` shows its message (§11.2), and a blocked or held signed-in file says so and links its notice. A generated password still shows at once.
- Copy link, plus "Copy link with password" (`url_with_password`).
- A generated password is shown once.
- Every contract §7 code has its own message (`lib/errors.ts`).

**"Put these in an album"** (Milestone 3, `upload/useUploadAlbum.ts`):
- Shown while the batch has more than one file, on by default, with an optional title. Files added while a batch is still going join it.
- When every file in the batch has finished, `POST /users/@me/albums` gets the successful ids, and the album link shows above the per-file links. Fewer than two successes make no album.
- Anonymous uploads work too (up to 50 files). Signed in, a password or private batch's album gets the same access with a `PATCH` (a generated password gets the album its own one, shown once). Anonymous albums can't be edited, so a protected anonymous batch isn't offered an album.

### Dashboard (Milestone 3)

**Files** (`/app/files`, `pages/FilesPage.tsx`, `app/files/`):
- A table by default, a grid toggle, and a card list below 640 px. Page, sort, search (debounced), type chips, access and "Temporary" live in the URL (`lib/files/urlState.ts`).
- Thumbnails follow `lib/files/thumbnail.ts`.
  - Owner payloads' URLs are signed for 1 h, so password and private files show their media like public ones. A refetch re-signs them; each thumbnail keeps its URLs until they near expiry, so lists don't reload every image.
  - The video hover clip plays on hover and on keyboard focus.
- Multi-select with shift-click ranges and select all on the page (`lib/files/selection.ts`). The "N selected · X MB" bar sticks to the bottom on phones.
- Row actions: Copy link, Open, Open as owner, Rename (inline, the name only), Set expiry, Keep forever, Change access, Add to album and Delete.
- Clicking a row opens a drawer that shows the file with the viewer's renderers, from the owner payload's URLs.
- "Open as owner" (protected files) mints an owner pass (`POST …/pass`) and opens its `#t=` page URL.

**Change access** (`access/AccessDialog.tsx`): one dialog for a file, a selection or an album.
- It shares its fields with the upload pickers (`access/AccessFields.tsx`), and its rules are in `lib/files/accessForm.ts`.
- An empty password keeps the current one, and the timing fields are only sent once changed.
- It warns when saving would break existing password links.

**Albums** (`/app/albums`, `/app/albums/<id>`):
- The editor reorders with dnd-kit (pointer or keyboard). The order saves with `PUT …/files` 600 ms after the last move, and rolls back if that fails.
- Captions save on blur. Items the public page hides get a note saying why.

**Overview** (`/app`): the storage meter (amber at 80%, red at 95%, and an explanation at 100%), counts by type, files expiring within 7 days, and recent uploads.
- The expiring list reads the first 100 temporary files, since the list has no sort by expiry.

### Dashboard (Milestone 4: trust & safety)

**Badges and banners** (`DashboardLayout.tsx`): `GET /users/@me/badges` is fetched on load, every 60 s while the tab is visible, and on focus. The sidebar shows My reports (`reports_unread`), Notices (`notices_unacknowledged`) and, for staff, Admin (`staff.open`, red while `p0 > 0`). While notices are unacknowledged, every page has the "You have N notices about your files or account" banner. A suspended account sees Notices and, since Milestone 6 (§11.1), Settings → Security (password and sessions) and Settings → Data (exports), with "Your account has been suspended"; any other page redirects to Notices.

**My reports** (`/app/reports`, `/app/reports/<id>`): status chips (open, resolved, dismissed) and search in the URL, 25 a page, unread counts. The detail has the target link, the status, the thread ("You" and "files.gg staff"; reading it marks the report read), a reply box hidden once closed, and Reopen when `can_reopen`. Escalated (CSAM) reports only say they were escalated.

**Notices** (`/app/notices`, `/app/notices/<id>`): newest first, each with the action, rule text, target link, date and staff message, Acknowledge and "Acknowledge all", and Appeal when `can_appeal`. A `copyright` notice's appeal has the counter-notice fields (§8.2), checked before sending and against the API's `errors`. Then the appeal state and staff's reply show. The Hidden, Removed and Blocked badges link to `/app/notices/<id>`, which finds the notice among the latest 100 (the API has no single-notice read).

**Files and albums:**
- NSFW tiles (and album covers) are blurred (`filter: blur(16px)`) with an eye-off icon and play no hover clip, unless "Always show sensitive media" (`filesgg.showSensitive`, shared with the viewer) is on. The drawer opens NSFW files behind an interstitial that mounts nothing before Show.
- `pending`, `hidden`, `removed` and `blocked` files show their state instead of media (the CDN refuses them), with "Checking…", "Hidden", "Removed" or "Blocked" badges linking to the notice; flagged files get no badge, only their warnings in the drawer. Checking files on the page are polled every 5 s for up to 10 minutes.
- Row, drawer and bulk actions: Mark as sensitive, Unmark (disabled with "Marked by files.gg. Ask for a review instead." when `nsfw_locked`), and "Ask for review…" for classifier marks. Signed in only.
- The album editor has a "Mark album as sensitive" switch, badges on items, notes on items that aren't shown (still being checked, hidden, removed or blocked), a notice for a hidden or removed album, and polls every 5 s while an item is being checked.

**Admin** (`/app/admin/*`, `src/app/admin/`): a lazy chunk that `AdminGate` loads only when the session's user has `staff`; everyone else gets the not-found page and never downloads it. The API enforces access anyway (§9.1).
- Pages: Overview (summary, past-goal counts, stalled scans, unrecorded CyberTipline reports, and for admins the staff list and rescans), Queue (priority, age, reasons, target, reporters, target state and assignee; filters for status, priority, reason, kind, assignee and second review in the URL; Claim, Release, and Take over for admins), Bugs, a case page, file, album and user pages with the action panel, Lookup, Bans (lift for admins) and the audit log (admins).
- A case shows the target through the staff grant, its reports (with DMCA notices and threads, a reply box and the canned responses in `canned.ts`), scanner findings and flags, history (with the notices sent), claim and release, the action panel (rule required where §9.3 says, a staff note, the notice text, durations and hold days), closing with a reporter message, appeal decisions (`SAME_MODERATOR` explained), the CyberTipline record and the second-review flag.
- Permissions follow §9.1 in `permissions.ts`: CSAM confirmation and child-safety media for child-safety staff only, suspensions and permanent bans for admins, nothing to lift for CSAM.
- Moderator safety: every image, video and poster is `blur(24px) grayscale(1)` until Reveal (per item, reset on leaving the page), videos have no controls or autoplay before Reveal, and hash-matched content shows "Not displayable" without requesting anything.
- Every admin page shows "N child-safety or P0 cases are open" (linking to the queue filtered to P0), and for admins "Scanning is behind" while `scans_stalled > 0`. `GET /admin/summary` is polled every 30 s; the opt-in "Notify me about new P0 cases" (`filesgg.admin.notify`) fires "New P0 case on files.gg" when `newest_p0_at` increases, and a polite live region announces queue changes.

### Dashboard (Milestone 6: accounts)

**Sign-in pages** (`src/app/auth/`, milestone-6 §6, §13.2): routes of `app.html` outside the dashboard layout (a centred card with the logo), each a lazy chunk.
- `/app/login` (email and password, never a username), `/app/register` (email; a username lowercased as you type and checked with `/username/check` 400 ms after the last keystroke, with the reason; an optional display name; a password with a strength meter, minimum 8, no maximum), `/app/verify#token=`, `/app/forgot` (always "If an account uses that email, we've sent a link. It works for 1 hour."), `/app/reset#token=` (signs in), and `/app/auth/discord`.
- Every form that signs in, creates an account or sends an email runs managed Turnstile right before submitting (actions `login`, `register`, `forgot`, `reset`), and the widget resets after each try. Errors use the contract copy: "Wrong email or password", "Too many attempts. Try again in N minutes", "Couldn't verify you're human. Try again."
- Email tokens are read from the fragment once and removed with `replaceState`. `?next=` must be a path under `/app/` (no `//`, no scheme); a signed-in visitor of login or register goes there (or to `/app`).
- **Claiming:** when this browser has an anonymous fingerprint, login, register and Discord say "Files you uploaded from this browser will move to your account." After sign-in the fingerprint is deleted and a toast says the files are in the account (not for a pending-deletion account, which claims nothing).
- **Discord** (§5.2): Continue with Discord makes a PKCE verifier (32 random bytes, base64url), sends its S256 challenge to `POST /api/auth/discord/authorize`, keeps `{ verifier, state, purpose, next }` in `sessionStorage["filesgg.oauth"]`, and redirects. The callback page compares `state` with the stored one and sends nothing if it differs ("This sign-in link expired. Try again."), clears the query, runs Turnstile for a sign-in, and posts code, state and verifier. `access_denied` says "Discord sign-in was cancelled."; any other error after `prompt=none` retries once without `prompt`. `signup_required` shows "Choose your username" (the suggestion, the display name, the email line); a verified Discord email that belongs to an account shows the contract message and Sign in. Link and re-auth return to Settings with a toast.

**Session in the dashboard:** the layout waits for `GET /api/auth/session` before rendering a page. A `401` signs the tab out with "You were signed out." and Sign in; sign-in, sign-out and `401`s post `"session-changed"` on `BroadcastChannel("filesgg-session")`, and other tabs refetch (clearing their cache if the account changed). The sidebar footer shows Sign in and Create account, or the initials tile (§2.4), the names and a menu with Settings and Sign out.
- `user.deletion` set: every route shows only "Your account will be deleted on <date>. Your files and albums are offline until then." with Keep my account, Download my data and Sign out.
- `needs_username`: a dialog that can't be dismissed until a new name is saved.
- An unverified email (or none, after a Discord sign-up) gets a dismissible banner with Resend (or Add an email).

**Settings** (`/app/settings/*`, tabs in the URL; signed in only):
- **Profile:** the username with the 30-day rule ("You can change it again on 25 Dec"; the old name is held for you), the display name with the initials preview, "Show my name on albums".
- **Security:** email (verified badge, change with the pending state and Cancel), password (set or change; the result says other devices were signed out and upload keys still work), login methods (Discord with its avatar from `cdn.discordapp.com`, Link or Unlink; Unlink disabled with "Add a password and verify your email first, so you can still sign in"), and sessions (device, country, last used, "This device", Sign out per row, Sign out everywhere, which signs this browser out too).
- **Domains** (premium; an explanation otherwise, "Premium is granted by files.gg staff for now"): Add domain, then a card with the CNAME and TXT records, Copy buttons and the DNS-only hint; the status ("Waiting for DNS" → "Issuing certificate" → "Active", and Failing, Failed, Paused, Disabled by files.gg with the reason and "Appeal in Notices"); Check now, Set as default, Retry, Remove; the "Only my files" switch (on by default; turning it off confirms); and "Only show my files on my domain" (needs a serving domain; turning it on shows the `/preview` counts and confirms; a paused note). Domains are polled every 10 s while one is pending and the tab is visible.
- **Data:** Request export, the export list with Download (a same-origin link to `/api/users/@me/exports/<id>/download`), and Delete account: type the username, re-authenticate, then the final confirmation. Staff and suspended accounts get the reason instead.
- **Re-authentication** (`account/useReauth.ts`): an action that answers `403 REAUTH_REQUIRED` opens the shared dialog (the password, or Continue with Discord with `purpose: reauth`) and is retried once confirmed. A Discord re-auth leaves the page, so the action is tried again by hand afterwards.

**Integrations** (`/app/integrations`): the key list (name, prefix, scopes, pinned domain, created, last used or "never used", expiry, state; Rename and Revoke with a confirmation), Create key (name, "Also allow adding to albums", link domain for premium, expiry never/30/90/365 days, and ShareX defaults: file expiry, access, view limit and what happens at it (milestone-6 §19.3), sensitive, album), and the result panel shown once: the key with Copy, Download ShareX config, and the curl snippet with Copy. The `.sxcu` and the curl snippet are built in the browser (`lib/sharex.ts`, §7.7 exactly); the ShareX defaults go into their `Arguments` and `-F` fields (and, as the optional `sharex` object, to the API, so its own `sharex` and `curl` match); they don't change the key. At 20 active keys Create key is disabled with the reason.

**Premium** shows on Overview (a badge with the expiry, the storage meter against the premium limit, and the website and ShareX limits), on Upload (the single-request limit for ShareX and curl), and in Integrations.

**Admin:** `/app/admin/users/:id` loads its Milestone 6 cards lazily inside the admin chunk (`admin/account/AccountCards.tsx`): Premium (status, granted by, expiry, history; Grant, Change expiry and Revoke, each with a required note, admins only), login methods, sessions, upload keys (Revoke one key through `revoke_upload_keys`), domains and a pending deletion. User actions gain Sign out everywhere and Reset the username. Cases gain the `domain` kind, with a domain panel and `disable_domain`, `enable_domain` and `set_domain_scope`; `/app/admin/domains` lists every domain (filters by status and hostname in the URL, Load more; `pages/DomainsPage.tsx`, its own lazy chunk inside the admin chunk), `/app/admin/domains/:id` is the domain page, and Lookup lists matching domains.

**Files drawer (§13.4, §19.7):** **Copy direct link** copies `direct_url`; **Open on i.example.com** mints an owner pass with `domain_id` for the default domain while it's serving (premium only). Rows and the drawer show "N of M views used" for view-limited files; the drawer's View limit section has **Set/Edit view limit…** (`ViewLimitDialog`, which explains `VIEW_LIMIT_TOO_LOW`) and **Remove limit**, signed in only (anonymous files set it at upload). A file whose `private` action fired shows as private with "Raise the limit to share it again", and the dialog can share it with the link again in the same `PATCH`. The upload page has **View limit** (off, or 1–1000) and **When the limit is reached** (Expire the file, or Make it private when signed in).

## Assets

The favicons, touch icon, PWA icons, OG image and the logo SVGs in `public/` (logos under `public/assets/brand/`) are copies of `branding/`. Regenerate them with `python3 branding/build.py`, then copy them again.
