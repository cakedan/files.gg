# files.gg web

The new files.gg frontend (redesign Milestone 1): React 19, Vite, TypeScript, Tailwind CSS v4, react-router, TanStack Query and lucide. It replaces `frontend/` (the Mithril app) once the worker switches over. The spec is `docs/redesign/PLAN.md` (Phase 2, Phase 3, Phase 4 and Appendix A).

It builds two entry points:

| Entry | Served at | What it is |
|---|---|---|
| `viewer.html` | `files.gg/`, `files.gg/<vanity>[.<ext>]`, `files.gg/a/<vanity>[/<n>]` and `files.gg/convert` | The file viewer and album page. A small bundle that boots from data the worker inlines into the HTML, with no API call. The PDF viewer, the album page and the video/audio renderers are lazy chunks. |
| `app.html` | `files.gg/app` and `files.gg/app/*` | The dashboard SPA. Every page is its own lazy-loaded chunk. |

The viewer never imports dashboard code, react-router, TanStack Query or the API client. ESLint enforces this (`no-restricted-imports` on `src/viewer/**` and `src/components/**`), and each entry has its own CSS file that only scans its own sources.

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

The API base URL comes from `VITE_API_URL`. See `.env.example`.
- **Builds** default to `https://api.files.gg`.
- **`npm run dev`** uses the in-memory **mock API** (below) unless `VITE_API_URL` is set, for example to a local API in `.env.local`.
- **The real stack locally:** `e2e/up.sh` builds this app (into `e2e/.local/web-dist`, not `dist`) against the local API and serves it through the Worker on `http://files.localhost:8787`. See `e2e/README.md`.

**Turnstile:** set `VITE_TURNSTILE_SITE_KEY` for production builds, which warn when it's missing. Dev and tests use Cloudflare's documented testing key `1x00000000000000000000AA` (always passes; https://developers.cloudflare.com/turnstile/troubleshooting/testing/). It issues the dummy token `XXXX.DUMMY.TOKEN.XXXX`, which the mock accepts the way the testing secret keys do. All five testing site keys and three testing secrets are in `src/lib/config.ts`.

In dev and preview, `/app` and `/app/*` serve `app.html`, and `/`, `/convert` and `/a/<vanity>[/<n>]` serve `viewer.html`. In dev, a bare vanity such as `/private123` does too. The same rewrites happen in production (see below).

### Mock API (dev only)

`mock-api.ts` is a Vite middleware at `/__mock-api` that implements the Milestone 2 contract in memory, so the whole flow works with no backend. It's never part of a build.

**Endpoints:**
- `GET /auth/fingerprint`, `GET /users/@me` and `GET /users/@me/limits`. Without `Authorization` you get the anonymous values; with any `Authorization` you're "Mock User".
- `POST /files`, with a multipart parser.
- The chunked `POST /uploads`, `PUT …/chunks/<i>`, `GET`, `complete` (moves to `complete` after 1.5 s) and `DELETE`.
- `POST /{files|albums}/<vanity>/unlock`, `…/unlock/refresh` and `GET …/view`.
- `POST /users/@me/{files|albums}/<id or vanity>/pass`, for owner passes.

**Behaviour:**
- Tokens are real contract §1 tokens, signed with the contract's test secret. `mock-api.test.ts` checks them against the test vectors.
- Turnstile, rate limits (5 a minute), expiry and the size limits follow the contract.
- Every §7 error code the uploads can hit is reproducible.

**Knobs (env):** `MOCK_CHUNK_DELAY_MS` (default 400), `MOCK_CHUNK_FAIL_RATE` (default 0, which exercises retries) and `MOCK_PROCESSING_MS`.

**To be signed in:** run `localStorage.token = '"mock"'` in the console.

**Owner pass:**
```bash
curl -X POST -H 'Authorization: x' localhost:5173/__mock-api/users/@me/files/private123/pass
```
Then open `/private123?fixture=private#t=<token>`.

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
| `/viewer.html?fixture=album-grid` or `/a/<anything>` | A grid album: images, an unplayable HEVC video with a poster, a PDF and a zip, with captions. |
| `/viewer.html?fixture=album-list` | The list layout. |
| `/viewer.html?fixture=album-tracklist` | An all-audio album (tagged tones with covers), shown as a tracklist. |
| `/viewer.html?fixture=locked` | A password file (`locked1234`), named on the lock screen. The password is `files.gg`, and `#pw=files.gg` unlocks it automatically. |
| `/viewer.html?fixture=locked-short` | A password PDF whose mock `unlock_ttl` is 90 s, to watch the refresh run out and the lock screen return. |
| `/viewer.html?fixture=locked-expired` | `password_expired: true`: "This link's password has expired". |
| `/viewer.html?fixture=locked-album` | A password album (`lockedalbum`, password `files.gg`). One item is a `link` file, so it gets no `?t=`. |
| `/private123?fixture=private` | A private file: "doesn't exist", unless the URL has a `#t=` owner pass. |

Add `/<n>` to an album path, for example `/a/demo1234/3?fixture=album-grid`, to open item 3 in the lightbox.

Fixtures live in `src/viewer/fixtures.ts`. They are imported behind `import.meta.env.DEV`, so production builds leave them out.

The media they point at lives in `web/fixtures/`, generated by `scripts/make-fixtures.mjs` with no downloads:
- the PDFs are written by hand, and the protected one uses RC4-128 standard security;
- the PNGs are encoded with zlib;
- the WAV tones are 8 kHz;
- the zip uses store mode.

The dev server serves that folder at `/fixtures/` with Range support. It isn't in `public/`, so none of it ships in a build.

## Worker contract (viewer boot data)

The Cloudflare worker (`cf-worker/worker/domains/stable.js`) implements this in the worker milestone. The client side is `src/viewer/boot.ts`, which has tests.

### 1. Routing

Handle these in this order, before any vanity lookup:

1. **Static files from `web/dist`**, served as they are:
   - `/assets/*`: hashed JS, CSS and source maps, plus `/assets/brand/*.svg`. Cache them as immutable for a year. `assets` is already in the API's `blacklisted_ids`.
     - This includes the pdf.js worker, `/assets/pdf.worker.min-<hash>.mjs`. Serve `.mjs` as `text/javascript`, or module workers refuse to start.
     - It also includes `/assets/pdfjs/<version>/{cmaps,standard_fonts,wasm,iccs}/*`. Serve `.wasm` as `application/wasm`. These paths are versioned, so they can be cached as immutable too.
   - Root files: `/favicon.ico`, `/favicon.svg`, `/favicon-16.png`, `/favicon-32.png`, `/favicon-48.png`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png` and `/og-image.png`. Match these **exact paths** first. Otherwise the vanity router reads `files.gg/favicon.ico` as the vanity `favicon`.
2. **`/app` and `/app/*`** serve `dist/app.html` with `Cache-Control: no-cache`. The plan (§1.4 item 2) still needs `app` and `api` added to `blacklisted_ids`.
3. **`/`** serves `dist/viewer.html` with the `home` state, and **`/convert`** serves it with `data-page="convert"`. The plan's "File conversion" design replaces this later; `convert` needs to be reserved like `app`.
4. **`/a/<vanity>` and `/a/<vanity>/<n>`** serve `dist/viewer.html` with the album state (below). `a` is reserved (§1.4 item 2). The client reads `<n>` from the path, so the worker returns the same album page for every `<n>`.
5. **`/<vanity>[.<anything>]`** serves `dist/viewer.html` with the `file`, `missing` or `unavailable` state. Keep the existing bot, ShareX, Telegram and `Accept: image/*` redirects to the CDN exactly as they are now (§1.4 item 3). They happen before the shell is rendered.

The HTML shell must be served with `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-cache` (or `private, no-store` for `unavailable`), because the hashed asset names inside it change on every deploy.

### 2. The `#root` element

`dist/viewer.html` contains a bare `<div id="root"></div>`. Use `HTMLRewriter` on `#root` to set these attributes:

| Case | `data-page` | `data-state` | `#file-data` | HTTP status |
|---|---|---|---|---|
| `/` | `home` | (omit) | (omit) | 200 |
| File found and not expired | `file` | `file` | file JSON | 200 |
| Unknown, deleted or expired (`expires_at <= now`) | `file` | `missing` | `null` | 404 |
| API unreachable, timed out or 5xx | `file` | `unavailable` | (omit) | 503 |
| `/convert` | `convert` | (omit) | (omit) | 200 |
| `/a/<vanity>` with at least one visible item | `album` | `album` | `#album-data`: album JSON | 200 |
| Album unknown, deleted, expired, or with no visible items | `album` | `missing` | (omit) | 404 |
| Album API unreachable | `album` | `unavailable` | (omit) | 503 |

The client checks them in this order:

1. `data-page="home"` shows home, and `data-page="convert"` shows the Convert placeholder.
2. `data-state="unavailable"` shows unavailable.
3. `data-state="missing"` shows missing.
4. `data-page="album"` shows the album when `#album-data` holds a valid album with at least one visible item, and missing otherwise.
5. A valid file payload shows the file.
6. Anything else shows missing: a `null` payload, no script tag, invalid JSON, or a payload without `filename` or `cdnUrl`.

`unavailable` must never be served for a file that really is missing. It tells the user the file still exists.

### 3. The `#file-data` script

Insert it right after `#root`, with `element.after(html, { html: true })`:

```html
<script id="file-data" type="application/json">{"kind":"image",...}</script>
```

**Escape the JSON before inlining it.** Run `JSON.stringify(payload)`, then replace `<` with `\u003c`, `>` with `\u003e`, `&` with `\u0026`, U+2028 with `\u2028` and U+2029 with `\u2029` (each written as those six ASCII characters). Filenames, titles and captions are user input, so none of them may be able to close the tag with `</script>`. The output is still valid JSON. The same applies to `#album-data`.

Payload fields (`src/viewer/types.ts`, Appendix A):

| Field | Type | Required | Source / notes |
|---|---|---|---|
| `kind` | `"image" \| "video" \| "audio" \| "text" \| "pdf" \| "file"` | yes | From the mimetype. Use `image` only for types browsers can display (png, jpeg, gif, webp, avif, bmp, ico). SVG is **`file`**, since the CDN forces it to `text/plain`. Unknown values fall back to `file`. |
| `filename` | string | **yes** | `file.filename` (name + extension). |
| `cdnUrl` | string (absolute URL) | **yes** | `file.urls.cdn`. Download appends `?download=true`; Raw opens it in a new tab. |
| `url` | string (absolute URL) | recommended | `file.urls.main`, the canonical link that "Copy link" copies. Without it, the client copies `origin + pathname`. |
| `mimetype` | string | yes | Defaults to `application/octet-stream`. |
| `extension` | string | yes | Derived from `filename` if missing. |
| `size` | number (bytes) | yes | Defaults to 0. |
| `width`, `height` | number (px) | when known | Both are needed to reserve the media's `aspect-ratio` before it loads. |
| `duration` | number (ms) | when known | For video and audio (later milestone). |
| `framecount` | number | when known | Above 1 means animated (later milestone). |
| `thumbnail` | `{ url, type, width?, height? }` | optional | PLAN.md "Media processing": `thumb`, `poster` (video), `cover` (audio, larger art box) or `waveform`. Album tiles use it, and so do the video poster and audio art. |
| `media` | object | optional | `probe` output: `{ width, height, duration, framecount, playable, has_audio, codecs, tags: { title, artist, album, track }, pages, lines }`. `pages` shows as "12 pages" in the footer. `playable: false` makes video show "Can't play this video in the browser" with Download. Tracklists use `tags`. |
| `hover_url` | string | optional | The 3 s muted clip that plays on video tiles on hover. |
| `processing` | boolean | optional | `true` until `derive` finishes. |
| `id`, `vanity` | string | optional | Not used yet. |
| `uploadedAt` | number (ms epoch) | yes | No `created_at` exists yet, so decode the snowflake: `Number(BigInt(id) >> 22n) + 1550102400000`. |
| `expiresAt` | number (ms epoch) \| `null` | yes | `null` means the file never expires. |

Numeric strings are accepted for numbers, and invalid or non-positive dimensions are dropped. Timestamps may also be ISO-8601 strings. The parser also accepts the snake_case spellings `cdn_url`, `expires_at` and `uploaded_at`/`created_at`, so the worker can pass API objects through.

### 4. The `#album-data` script (albums)

Insert it after `#root` the same way, with the same escaping:

```html
<script id="album-data" type="application/json">{"vanity":"Ab3dE6gH","items":[...]}</script>
```

The payload is the album from `GET /albums/:vanity` (PLAN.md Phase 1 "Albums"). Each item is a file payload as in the table above, plus `position` and `caption`. The client is `parseAlbumData` in `src/viewer/boot.ts`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `vanity` | string | **yes** | Used for `/a/<vanity>/<n>` URL sync. |
| `url` | string | recommended | The canonical `https://files.gg/a/<vanity>`, used by Copy link, Download all (`<url>/download.zip`) and Report (`/report?url=<url>`). |
| `title` | string | no | Up to 100 characters, plain text. If it's empty, a tracklist uses the album tag, and anything else shows "Untitled album". |
| `description` | string | no | Up to 2,000 characters, **plain text**. Newlines are kept, and http(s) URLs become links with `rel="nofollow ugc noopener"`. |
| `layout` | `"auto" \| "grid" \| "list" \| "tracklist"` | no | `auto` means a grid, or a tracklist when every item is audio. An explicit `tracklist` falls back to a grid if any item isn't audio. |
| `nsfw` | boolean | no | `true` shows one interstitial for the whole album. |
| `cover` | `{ url, type, width?, height? }` | no | The resolved cover (from `cover_file_id`, or automatic). Tracklists fall back to the first track's `cover`. |
| `expires_at` / `expiresAt` | ms or ISO \| `null` | no | Shown in the header. If it is in the past, the client shows missing. |
| `count`, `total_size` / `totalSize` | number | no | All visible items and their total bytes. When the payload is paginated, these can exceed `items`; otherwise they default to `items.length` and the sum of item sizes. |
| `next_cursor` / `nextCursor` | string \| `null` | no | When set, the page says "Showing the first N of M files". Loading more is a later milestone. |
| `items[]` | file payload + `position` (number), `caption` (string, ≤ 500) | **yes** | Only visible items should be sent. The client also drops invalid items and expired ones (`expiresAt <= now`), then sorts the rest by `position`. |

The owner's username is never shown, so don't send it unless "Show my name on albums" is on (later milestone).

### 4b. Milestone 2: protected files and albums

This follows `docs/redesign/contracts/milestone-2.md` §4 and §5; the client is `src/viewer/locked/` (a lazy chunk).

**Loading:**
- `data-state="locked"` takes `{ vanity, protected: "password", filename? | title?, password_expired? }` in `#file-data` or `#album-data`.
- On boot, `#pw=` and `#t=` are read and immediately stripped from the address bar with `replaceState`.

**Order of attempts:**
1. **A `#t=` owner pass:** `GET /{files|albums}/<vanity>/view` with `X-Filesgg-Access`. There's no unlock call and it's never stored. It refreshes through `/unlock/refresh` with the same timing, capped at 12 h from minting.
2. **A stored unlock token** (`localStorage["filesgg.access.<kind>.<vanity>"]`, kept until it expires): the same `/view` call. `401` drops the token.
3. **Otherwise the lock screen:**
   - a password field with a show toggle;
   - managed Turnstile (action `unlock`, `interaction-only`) on every attempt;
   - a `#pw=` password is tried once automatically when Turnstile passes;
   - errors for `WRONG_PASSWORD`, `TOO_MANY_ATTEMPTS` (with a live countdown), `PASSWORD_EXPIRED` and `CAPTCHA_INVALID` (with Retry the check).

**Private files:** the shell is `missing`. With `#t=` in the URL, the vanity comes from the path, and `404` or `401` show "doesn't exist".

**After unlocking:**
- Every media URL gets `?t=`. That covers `cdnUrl`, so Download and Raw carry it too, plus the thumbnail, the hover clip, album covers and album items.
- `link` files never get `?t=`, and the share link never does.
- Album "Download all" gets `?t=` too.
- The token refreshes 5 minutes before expiry (or at half-life if less is left).
- Refreshing stops once the server stops extending the token (its cap). `UNLOCK_EXPIRED`, or reaching expiry, returns to the lock screen.
- Media URLs move to a newer token only 2 minutes before theirs expires, so a refresh never reloads the image, restarts the video or reopens the PDF.

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

## Layout

```
src/
  app/          dashboard: routes, DashboardLayout (sidebar / mobile drawer), lazy pages
  viewer/       viewer: boot parsing, fixtures, state cards, file card, renderers/
    pdf/        lazy PDF chunk: pdf.js loader, pdfState.ts (pure, tested), viewer, pages, sidebar
    album/      lazy album chunk: layouts, justified grid, lightbox, tracklist, URL sync
  components/   shared by both entries and viewer-safe: Button, CopyButton, Brand (lockup/mark)
    locked/     lazy chunk: lock screen, unlock / view / refresh, owner passes
  lib/          api client, TanStack Query client and hooks, storage, time and format helpers
    access.ts   access tokens: storage, refresh timing, ?t= signing, #pw= / #t= fragments
    upload/     chunk scheduler, upload task, resume store, picker rules, error messages, limits check
  styles/       theme.css (tokens), viewer.css and app.css (one per entry)
  test/         Vitest setup
```

### Viewer renderers

`src/viewer/renderers/index.ts` maps `kind` to a component, and anything without an entry gets a generic download card:
- `image`: checkerboard, a click-to-zoom lightbox, Esc to close, and in the album carousel a click toggles fit and actual size;
- `pdf`: pdf.js, lazy;
- `video` and `audio`: native elements for now, lazy.

The text viewer (Shiki) registers there later, with `lazy()`. `FileCard`, album lists and the album carousel wrap renderers in `<Suspense>` with a fallback that holds the media's size. A renderer gets a `context` prop:
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
  - Password-protected PDFs prompt for the password and decrypt in the browser.
- **Fallback:** a broken PDF shows "Can't preview this PDF" with Download.

### Album page

`src/viewer/album/` is a lazy chunk:
- **Header:** title, plain-text description with safe links, count and size, expiry, Copy link, Download all and Report.
- **Layouts:**
  - a justified grid (`layout.ts`, `justifyRows`), with video, audio, PDF and file tiles, captions under the items, and hover clips;
  - a list, where each item uses its normal renderer at full width;
  - a tracklist: cover, tag artist and album, numbered tracks, and a bottom player bar with prev, next, shuffle and repeat on a plain `<audio>` element.
- **Lightbox:** a carousel with ←/→, swipe and Esc, plus per-item Download, Raw and Copy link.
  - Opening an item pushes `/a/<vanity>/<n>`, so Back closes it; moving between items replaces the entry.
  - The URL logic is `useAlbumLightbox`.
- **NSFW:** one interstitial for the whole album.

Each lazy chunk has its own utility stylesheet (`pdf/pdf.css`, `album/album.css`, built with `@reference` against the shared tokens), so their classes stay out of the viewer's entry CSS.

### Design tokens

`src/styles/theme.css` defines `--gg`, `--gg-end`, `--gg-fold`, `--gg-ink`, `--gg-on-light`, `--bg`, `--surface`, `--surface-2`, `--well`, `--line`, `--text`, `--muted`, `--danger` and `--warn` on `:root`, with `color-scheme: dark`. `@theme inline` exposes them as Tailwind colours (`bg-surface`, `text-muted`, `border-line`, `text-gg`, …). A light theme would only need to redefine the `:root` values.

### API client

`src/lib/api.ts`:

- Sends `Authorization` from localStorage `token`, and `X-Fingerprint` from `fingerprint`. These are the old app's keys and JSON encoding, so logins carry over on the same origin.
- As in the old app, the fingerprint is only sent while signed out.
- Every localStorage access goes through `src/lib/storage.ts`, which never throws.
- A non-2xx response throws `ApiError { status, code, message, body }`, parsed from the `{ code, message }` body. Network failures become `status: 0, code: "NETWORK_ERROR"`.

`src/lib/queries.ts` has the TanStack Query hooks (`useMe`, `useMyFiles`, `useMyLimits`).

The Milestone 2 calls are typed from the contract:
- `unlock`, `refreshUnlock` and `view`;
- `createUpload`, `uploadStatus`, `completeUpload` and `abortUpload`;
- `ensureFingerprint`.

Uploads use XHR (`lib/upload/xhr.ts`) for progress, with the same headers and `ApiError` parsing.

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

**Turnstile:** anonymous uploads use it with action `upload`, one fresh token per request.

**Results:**
- Copy link, plus "Copy link with password" (`url_with_password`).
- A generated password is shown once.
- Every contract §7 code has its own message (`lib/upload/errors.ts`).

## Assets

The favicons, touch icon, PWA icons, OG image and the logo SVGs in `public/` (logos under `public/assets/brand/`) are copies of `branding/`. Regenerate them with `python3 branding/build.py`, then copy them again.
