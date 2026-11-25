# files.gg Cloudflare Worker

This is one ES-module Worker (`export default { fetch }`), configured in `wrangler.toml` and deployed with Wrangler. It routes requests with [`cf-worker-router`](https://github.com/cakedan/cf-worker-router), signs B2 requests with [`aws4fetch`](https://github.com/mhart/aws4fetch), and serves `web/dist` as Workers static assets.

The contracts it implements:
- `web/README.md`, "Worker contract": the viewer shell;
- `docs/redesign/contracts/milestone-3.md` §0 and §3-5: signed CDN URLs, the CDN paths (files, previews, album collages and ZIPs), the internal lookups, snake_case payloads and embeds. These override `milestone-2.md` (its `?t=` tokens and GCS fallback are gone);
- `docs/redesign/contracts/milestone-2.md`: storage and the locked states;
- `docs/redesign/contracts/milestone-4.md` §10 (with §2.3, §2.4, §4.6, §6.3, §14.1): the scanning and moderation states, NSFW, the report routes, the staff grant and `security.txt`;
- `docs/redesign/contracts/milestone-6.md` §12 (with §3, §6, §8.8, §10, §16.5, §16.10, §16.11): the session cookie's routing, CORS without credentials, the auth redirects and reserved segments, `files.gg/challenge`, custom domains, domain-only mode and pending account deletions;
- `docs/redesign/PLAN.md`, "Hardening cdn.files.gg".

There is no backward compatibility (milestone-3.md §0): the old Mithril frontend, the CDN's raw GCS route, the GCS fallback and `?t=` tokens are gone.

## Routes it owns

| Route | Code | What it does |
|---|---|---|
| `files.gg/*` | `worker/domains/stable.js`, `worker/shell.js` | The viewer and dashboard from `web/dist`, the viewer shell with inlined boot data, report pages, `security.txt`, bot/embed redirects and the `/api/*` passthrough. |
| `cdn.files.gg/*` | `worker/domains/cdn.js`, `worker/storage.js`, `worker/utils/media.js`, `worker/utils/safety.js`, `worker/utils/signing.js`, `worker/utils/zip.js` | Files, previews, album collages and "Download all" ZIPs from B2, after the staff-grant, signed-URL and safety checks, under the hardening rules below; and `security.txt`. |
| `api.files.gg/*` | `worker/domains/api.js` | Passthrough to the API origin, with the origin secret. Never a cookie, never credentialed CORS. |
| `*/*` (every other hostname) | `worker/domains/custom.js`, `worker/utils/domains.js`, `worker/utils/owners.js` | Customers' custom domains (Cloudflare for SaaS, Worker as origin): the viewer, album and report pages, and the CDN's byte paths, after the domain lookup (below). |

`worker/index.js` sends our three hosts (and `www.files.gg`) to their routers and every other hostname to the custom-host router. It sets CORS (always `*`, never credentialed) and the cookie rules on every response, and the sandbox headers on every `cdn.files.gg` response.

### Sessions and cookies (milestone-6.md §3, §12)

The web session is the HttpOnly cookie `__Host-filesgg_session` (`SESSION_COOKIE_NAME`), host-only on `files.gg`:
- **`files.gg/api/*`** (the same-origin passthrough the website uses) is the only route that forwards it: the `Cookie` header upstream is `<name>=<value>` for the session cookie alone (two different values under that name forward nothing), and the request is marked `X-Filesgg-Via: main`. Both need `ORIGIN_SHARED_SECRET`. Only the API's `Set-Cookie` for that exact name comes back.
- **Everywhere else** (`files.gg` pages and assets, `api.files.gg`, `cdn.files.gg`, custom domains): no `Cookie` goes upstream (the API, B2, the asset server, Cloudflare's validation origin), and every `Set-Cookie` is removed from responses.
- Client copies of `X-Filesgg-Via` are always stripped, like `X-Filesgg-Internal-Lookup`. The internal lookups are built by the Worker and never carry a cookie. Both passthroughs still answer `404 NOT_FOUND` for any path that normalises to `/internal`.
- **CORS** is never credentialed: every cross-origin caller gets `Access-Control-Allow-Origin: *`, and `Access-Control-Allow-Credentials` is removed from every response, whatever the API sent.

### files.gg, in order (web/README.md §1)

1. `/api` and `/api/*` go to the API (with the session cookie, above).
2. **Root files** (`/favicon.ico`, `/favicon.svg`, `/favicon-{16,32,48}.png`, `/apple-touch-icon.png`, `/icon-{192,512}.png`, `/og-image.png`) come from `web/dist`, cached for a day. They are exact paths, so they never reach the vanity lookup.
3. **`/assets/*`** comes from `web/dist`, cached as immutable for a year. `.mjs` and `.js` are served as `text/javascript`, and `.wasm` as `application/wasm`. A path missing from `web/dist` is a 404.
4. **`/app` and `/app/*`** serve `app.html` with `Cache-Control: no-cache`.
5. **`/`** is the `home` page, and **`/convert`** is the `convert` page.
   - **`/login`, `/login/`** → `308` to `/app/login`; **`/register`, `/register/`, `/signup`, `/signup/`** → `308` to `/app/register`, with the query kept (milestone-6.md §6.2). `GET` and `HEAD` only.
   - **`/challenge?host=<custom hostname>&action=unlock|report|view`** (milestone-6.md §10.10; `view` opens a view-limited file, §19.7), on `MAIN_HOST` itself only (not `www.`): `web/dist/challenge.html` with `<script id="challenge-data">{"host","action"}</script>` as the first child of `<body>`, `Cache-Control: no-store` and `Content-Security-Policy: default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors https://<host>`. `404` (`no-store`) unless `host` is a serving custom domain (domain lookup) and `action` is `unlock`, `report` or `view`; `503` while the API is down.
6. **Report pages** (milestone-4.md §10.1), always 200 with `Cache-Control: no-cache`, the default meta tags, and no lookup (they never say whether the target exists):
   - `/report` → `#report-data` `{ "type": "any" }`;
   - `/report/a/<vanity>` → `{ "type": "album", "vanity" }`;
   - `/report/<vanity>[.<ext>]` → `{ "type": "file", "vanity" }`, the vanity being the rest of the path minus any extension, multi-segment vanities included.

   The vanity is always the last path segment (milestone-6.md §20.2): the old `/<vanity>/report`, `/a/<vanity>/report` and `/a/<vanity>/<n>` are gone (`missing`, 404, without a lookup).
7. **`/.well-known/security.txt`** from `web/dist`, as `text/plain; charset=utf-8`, cached for a day.
8. **`/a/<vanity>`** is an album, whatever its query: the lightbox item is `?item=<n>`, which the viewer reads and keeps in sync (milestone-6.md §20.2). `/a/<vanity>/<anything>` is `missing` without a lookup.
9. **`/<vanity>` and `/<vanity>.<anything>`** are files, multi-segment vanities included. The old frontend's paths (`/auth`, `/dashboard`, `/details`, `/legal`, `/options`) are ordinary vanity lookups now. `report`, `login`, `register`, `signup`, `challenge`, `files`, `previews` and `albums` are reserved segments (the API's `blacklisted_ids`, case-insensitive; milestone-6.md §6.3), so a vanity containing one (`/report.png`, `/x/report/y`, `/files/abc.png`) is `missing` without a lookup.

### The viewer shell

The Worker fetches `viewer.html` from the `ASSETS` binding and rewrites it with `HTMLRewriter`:
- it sets `data-page` and `data-state` on `#root`;
- it inserts `<script id="file-data">`, `<script id="album-data">` or `<script id="report-data">` after `#root`, escaping `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`;
- it replaces everything between the `filesgg:meta` markers with the file's own meta tags, using `property=` for `og:*`.

The rules live in `worker/utils/viewer.js`:

| Case | `data-page` / `data-state` | Boot JSON | HTTP |
|---|---|---|---|
| `link` file (`ok`) | `file` / `file` | the file payload (NSFW ones with `nsfw: true`) | 200 |
| `password` file (`ok`) | `file` / `locked` | `{vanity, protected, filename?, password_expired?}` | 200 |
| View-limited `link` file (`ok`, views left) | `file` / `limited` | `{vanity, view_limited: true, views_remaining}` | 200 (`private, no-store`) |
| View-limited `password` file (`ok`, views left) | `file` / `locked` | `{vanity, protected, view_limited: true, views_remaining, filename?, password_expired?}` | 200 (`private, no-store`) |
| View-limited file, asked for by a link-preview bot (a bot user agent, ShareX, a preview fetcher from `worker/utils/bots.js`, or `Accept: image/*`) | none | `This file has a view limit and can't be previewed.` (text) | **403** (`private, no-store`) |
| View-limited file with its limit used up | `file` / `missing` | `null` | 404 |
| `private`, unknown, deleted or expired file; a `blocked` file in any visibility | `file` / `missing` | `null` | 404 |
| `pending` file (or a lookup without `safety`), not private | `file` / `pending` | `{vanity, pending: true}` | 200 (`private, no-store`) |
| `hidden` or `removed` file, not private | `file` / `removed` | `{vanity, removed: "review" \| "terms" \| "copyright" \| "malware"}` | **410** |
| API down, timed out or 5xx | `file` / `unavailable` | none | 503 (`private, no-store`) |
| `link` album with shown items | `album` / `album` | the album, with only its `link` items (milestone-3.md §4) and no expired ones; `nsfw: true` and no `collage` when it's marked or a shown item is NSFW | 200 |
| `password` album | `album` / `locked` | `{vanity, protected, title?}` | 200 |
| `hidden` or `removed` album, not private | `album` / `removed` | `{vanity, removed}` | **410** |
| Album with nothing shown and `pending_count > 0` (or no `safety`), not private | `album` / `pending` | `{vanity, pending: true}` | 200 (`private, no-store`) |
| Album that's private, missing or empty | `album` / `missing` | none | 404 |
| Report page | `report` / (none) | `#report-data` | 200 |

- **Decision order** (milestone-4.md §10.1, first match wins): unavailable; missing or expired; `blocked` (looks missing); the owner steps of milestone-6.md §10.8 (`owner_state` not `active` → missing; on `files.gg`, `served_on: "custom"` → missing); private; `pending`; `hidden` or `removed`; password (locked); otherwise the file. Albums: unavailable; missing or expired; the owner steps; private; hidden or removed; pending; password; link. A `hidden` password file is therefore `removed`, not `locked`. The `pending` and `removed` shells carry only the vanity and the state, never the name.
- **States** come from the lookup's `safety` (`worker/utils/safety.js`). A lookup without `safety`, or with a state the Worker doesn't know, is `pending` (fail closed). Unknown public reasons become `review` (hidden) or `terms` (removed).
- **`serve_inline: false`** (or missing): the boot payload gets `kind: "file"` and loses `assets`, `thumbnail` and `hover_url`, since the CDN won't serve them.

- **Meta tags:** locked pages get generic ones ("Password-protected file · files.gg"), with no name, image or video; so do `pending` ("Checking this file · files.gg", or "this album") and `removed` ("This file was removed · files.gg", "This album was removed · files.gg"). Report pages keep `viewer.html`'s defaults. Home, convert, missing and unavailable pages keep `viewer.html`'s defaults. Otherwise (milestone 3), with URLs exactly as the API wrote them in `cdn_url`, `assets`, `thumbnail`, `cover` and `collage` (payloads are snake_case, times in epoch seconds):
  - image: the file itself (`cdn_url`), or `assets.display` for a non-browser image (HEIC, TIFF…);
  - video: `og:image` = the poster with its dimensions, plus `og:video` with the video's (only when `media.playable` isn't `false`);
  - audio: `og:audio`, and `og:image` = the cover, else the waveform;
  - PDF: the first-page `thumb-2x`, else `thumb`; anything else: its `thumbnail`, else `/og-image.png`;
  - album: `og:title` "*Title* · N files" (an untitled audio album uses its album tag), `og:image` = the collage, or the cover for an all-audio album (or when there is no collage);
  - `nsfw: true` (a file, an album, or any shown item of it): no image, video or audio, and "Sensitive content".
- **Headers:** every shell is served as `text/html; charset=utf-8` with `Cache-Control: no-cache` (`private, no-store` for `pending` and `unavailable`), the viewer CSP (web/README.md §6, plus Turnstile and `api.files.gg`) and `nosniff`.
- **TODO (Milestone 3):** `app.html` is served without a CSP. It needs its own, like the viewer's.
- **View limits** (milestone-6.md §19.5): while the lookup's `view_limit` is set, the page never names the file, never carries a URL or media (generic "View-limited file · files.gg" tags), never redirects to the CDN, and the CDN serves the file and its previews only through a URL signed with the file grant (401 for a password file, else 404, `private, no-store`). Link-preview bots get the 403 above, so they never reach the API's open endpoint (`/access/open/files/<vanity>`) and never use up a view. They are `/bot|sharex/i` plus `facebookexternalhit`, `Facebot`, `WhatsApp`, `Slack-ImgProxy`, `SkypeUriPreview`, `Embedly`, `Iframely`, `vkShare`, `Mastodon`, `Bluesky Cardyb` and `Google-InspectionTool` (case-insensitive, §19.7a), and any request whose `Accept` has `image/*`. Every user-agent rule lives in `worker/utils/bots.js`. Custom domains follow the same rules.
- **Bot redirects:** ShareX, Telegram, requests without `Accept-Language` or `Accept`, and `Accept: <type>/*` are redirected to the file's `cdn_url`, but only for `ok` `link` files that aren't NSFW. NSFW files never redirect, for any user agent (milestone-4.md §4.6): the page's text card is all an embed gets. Password and private files get the locked or missing shell.

### Internal lookups (milestone-3.md §5, milestone-4.md §6.3, milestone-6.md §10.7)

The Worker asks the API for `GET /internal/files/<vanity>`, `GET /internal/albums/<vanity>` and `GET /internal/domains/<hostname>`, sending `X-Filesgg-Origin-Secret` and `X-Filesgg-Internal-Lookup: 1` (the API needs both; the lookup header is stripped from every forwarded request, and both passthroughs answer 404 for `/internal` paths). Every page and every CDN path names a vanity; there are no lookups by id.
- **`/internal/files/<vanity>`:** `file` (the payload, unsigned), `access`, `owner_user_id`, `albums` (`[{ id, vanity, access_version }]`, the albums the file is shown in), `storage` (`{ key, size }`), `previews` (`{ "<kind>": { key, content_type, size } }`), `previews_version`, `safety` (`{ state: "ok" | "pending" | "hidden" | "removed" | "blocked", reason }`, `reason` being the public one for hidden and removed) `serve_inline`, `served_on` (`"files.gg" | "custom"`, domain-only mode), `owner_state` (`"active" | "pending_deletion"`; any other non-null value is treated as pending, fail closed) and `view_limit` (`{ limit, used, action }` or `null`; malformed is treated as used up, fail closed). Hash-matched CSAM answers 404, exactly like an unknown vanity.
- **`/internal/albums/<vanity>`:** `album` (unsigned), `access`, `items_access`, `items_storage` (`{ "<file id>": { key, size, filename } }`), `collage` (`{ key, version }` or `null`), `safety` (`{ state: "ok" | "hidden" | "removed", reason }`), `pending_count`, `owner_user_id`, `served_on` and `owner_state`. Only `ok` items are listed; an album with nothing to show but `pending_count > 0` is returned with `album.items: []`.
- **`/internal/domains/<hostname>`:** `{ domain: { id, hostname, user_id, scope: "own" | "any", serving } }`, or 404. Served only when `serving` is exactly `true` and `hostname` is the request's.
- **Caching:** results are cached for 5 s with the Cache API, keyed by kind and vanity or hostname (cache key version `v7`). Unknown ones are cached too, as negative entries. 5xx responses and timeouts (8 s) aren't cached.
- **Without `ORIGIN_SHARED_SECRET`:** every page is `unavailable`, never `missing`, so a misconfiguration doesn't look like deleted files.

### cdn.files.gg (milestone-3.md §3)

These four shapes, plus `/.well-known/security.txt` (from `web/dist`, as `text/plain; charset=utf-8`, with the CDN security headers), are the only URLs it serves. Anything else is a 404 without a lookup (other methods: 405), and `OPTIONS` on one of them is a 204 preflight without a lookup.

Per request (milestone-4.md §10.2, milestone-6.md §10.8): **parse → lookup (404 / 503) → staff grant → owner pending deletion (404, even signed) → access check (signature) → domain-only (a `link` target whose `served_on` is `custom` needs a valid file or album signature, else 404) → safety state → serve**. The new refusals are `private, no-store`; a target served only because it was signed is `private, no-store` too. A protected domain-only target still answers 401 or 404 unsigned, as in milestone-6.md §16.10.

| Path | What |
|---|---|
| `/files/<vanity>.<ext>` | The file. The vanity is everything before the first dot, multi-segment vanities included; the extension isn't checked. |
| `/previews/<kind>/<vanity>.<kind ext>?v=<ver>` | A preview, through the file's vanity lookup. |
| `/albums/collage/<album vanity>.webp?v=<ver>` | An album's collage. |
| `/albums/download/<album vanity>.zip` | An album's "Download all". |

- **Parsing** (`worker/utils/media.js`): the preview kind is the first segment after `/previews/` and must be one of `thumb`, `thumb-2x`, `display`, `poster`, `cover`, `waveform` (all `webp`), `peaks` (`json`) or `hover` (`mp4`). Everything after it, minus the kind's extension, is the vanity, so `/previews/thumb/abcd/xyz.webp` is vanity `abcd/xyz` and a vanity named `thumb` can't be misread. A wrong extension for the kind is a 404. Albums work the same way with `collage` or `download` first; album vanities are one segment. Empty segments, malformed escapes, an encoded `/`, and a `.` inside a vanity are 404s.
- **`?v=`** is never checked: it only gives regenerated previews and collages a new URL.

#### Access: signed URLs (`worker/utils/signing.js`)

`link` files and albums are public. `password` and `private` ones are served **only** through URLs the API signed; the Worker verifies and never signs:

```
signature = base64url_nopad( HMAC-SHA256( CDN_SIGNING_SECRET,
              "filesgg-cdn-1" + "\n" + <path> + "\n" + <expires> + "\n" + <grant> ) )
```

- **`path`** is the request's pathname exactly as it arrived (percent-encoded), so a signature is valid for that one path. `?download=true` and `?v=` aren't signed.
- **The grant comes from the current lookup:**
  - a file or one of its previews: `file:<file id>:<access_version>`;
  - the same with `album=<album vanity>`: `album:<album id>:<access_version>`, but only when that vanity is in the file lookup's `albums` list (the albums the file is shown in, at their current version). An `album=` that isn't listed denies, and never falls back to the file grant;
  - an album's collage or ZIP: its own album grant, without `album=`.
- **Valid when** the signature matches (compared in constant time, as text), `expires > now`, and `expires <= now + 31 days`. `expires` must be canonical decimal digits.
- **Otherwise:** `password` gives **401** and `private` (or anything unknown) **404**, with `Cache-Control: private, no-store`. The check comes before the preview list, the edge cache or any byte, so a protected file never says which previews it has. A file lookup without `file.id` denies everything and logs `API contract error`.
- Changing a password or access bumps `access_version`, which breaks every URL signed before it.
- `?t=` tokens aren't read at all.

#### Safety states (milestone-4.md §10.2)

After the access check, so a protected file's state never leaks to someone without access:

| Lookup `safety.state` | `/files/…` and `/previews/…` |
|---|---|
| `ok` | served |
| `pending` (or no `safety`) | `404`, `private, no-store` |
| `hidden`, `removed` | `410`, `private, no-store` |
| `blocked` | `404`, `private, no-store` |

- **`serve_inline: false`** (or missing) forces `Content-Disposition: attachment` on the file, staff URLs included, and every preview is a 404.
- **Albums:** a `hidden` or `removed` album answers `410` (`private, no-store`) for its collage and ZIP, after its own access check; one without `safety` answers 404. Nothing shown while items are pending is a 404 with `private, no-store`. The ZIP contains only the items in the lookup, which are only `ok` ones; an item carrying any other state is skipped as well.
- **NSFW** changes nothing on the CDN.
- Nothing is read from the edge cache or B2 for a refused state.

#### The staff grant (milestone-4.md §10.3)

```
https://cdn.files.gg/files/abc123.png?staff=<staff user id>&expires=<expires>&sig=<signature>
grant = "staff:" + <staff user id> + ":" + <file id from the lookup>
```

- Same formula and secret, signed for one path, for `/files/…` and `/previews/…` only. Valid when the signature matches, `expires > now` and **`expires <= now + 600`**.
- A valid staff URL skips the access and safety checks (private, pending, hidden, removed and non-CSAM blocked content). Hash-matched CSAM is never in a lookup, so there is nothing to serve. `serve_inline: false` still forces `attachment`.
- Always `private, no-store`, and never written to the edge cache.
- An invalid one is treated like any other bad signature: the request falls through to the normal access check (401 for password files, 404 for private ones; ignored on `link` files, which then answer for their state).
- **Only on `cdn.files.gg`** (milestone-6.md §10.9). On a custom domain any `staff=` refuses the request: 401 for password targets, 404 otherwise (`link` included).

### Custom domains (milestone-6.md §10.8-§10.11)

Every hostname that isn't `MAIN_HOST` (or `www.`), `CDN_HOST` or `API_HOST`. Per request:
1. `/.well-known/acme-challenge/*`, `/.well-known/pki-validation/*` and `/.well-known/cf-custom-hostname-challenge/*` go straight to the origin (`fetch(request)`, without the client's cookies), before any lookup.
2. The domain lookup (5 s cache). Not a valid hostname, under `MAIN_HOST`, unknown, `serving` not `true`, or a lookup for another hostname: a minimal page, `404`, `Cache-Control: no-cache`, "This domain isn't connected to files.gg right now.". The API down: the same kind of page, `503`.
3. The path (`worker/utils/domains.js` `classifyCustomPath`): `/` is the landing card (`data-page="domain-home"`); `/<vanity>[.<ext>]` and `/a/<vanity>` the shells (bot redirects go to `https://<host>/files/<vanity>.<ext>`); the report pages; `/files/…`, `/previews/…` and `/albums/…` the CDN paths with every `cdn.files.gg` rule; `/assets/*` and the root files from `web/dist`. Everything else (`/app`, `/api`, `/convert`, `/challenge`, `/login`, `/.well-known/security.txt`…) is a 404, and nothing is ever passed to the API.
4. The domain's scope: with `scope` other than `any`, the lookup's `owner_user_id` must equal the domain's `user_id` (anonymous content never matches), else missing (shell 404, CDN 404).
5. `owner_state` not `active` → missing. `served_on` is ignored.
6. Then the `files.gg` shell order and the CDN order. Staff URLs are refused.

- **Rehosting** (§10.9): every string in the boot data (and the lookup the meta tags are made from) and every `<meta content>` that starts with `https://<CDN_HOST>` or `https://<MAIN_HOST>` (exactly, followed by the end, `/`, `?` or `#`) gets the custom origin instead, path, query and fragment byte for byte. Signatures cover the path only, so they stay valid.
- **Pages** get `data-host="custom"` on `#root`, `<script id="host-data">{"host","main_origin","api_origin"}</script>` after it, and the custom viewer CSP (`'self'` is the domain; `connect-src` the API and CDN origins; `frame-src` the `MAIN_HOST` origin; no Turnstile).
- **Byte paths** get exactly the `cdn.files.gg` headers: the sandbox CSP (`frame-ancestors` the `MAIN_HOST` origin), `nosniff`, COOP, `Referrer-Policy: no-referrer`, CORP, CORS `*` and the exposed range headers.
- **Every response** gets `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no `preload`) and `nosniff`, loses any `Set-Cookie`, and gets `default-src 'none'; frame-ancestors 'none'` when it has no CSP of its own.

#### Bytes

- **Edge cache:** whole-object `GET`s are served from the edge cache, keyed by the storage key; previews and collages add their version (`previews_version`, `collage.version`) because a re-derive rewrites the same key.
- **B2 only:** otherwise the Worker sends a SigV4-signed `GET` or `HEAD` to B2, with `Range`, `If-None-Match` and `If-Modified-Since` passed through. No other client header reaches storage, and `x-amz-*` and `x-bz-*` headers never reach the client. A missing object is a 404. Without the `S3_*` bindings every read is a 503, so a misconfiguration doesn't look like deleted files.
- **Headers:**
  - files: content type and disposition follow the hardening rules below;
  - previews: `Content-Type` from the stored row (never a type that renders as a page; then the kind's fixed type), `Content-Disposition: inline`;
  - collages: `image/webp`, `inline`.
- **Cache-Control:** public files `public, max-age=3600`; public previews and collages `public, max-age=31536000, immutable`; anything signed, and every error about a protected target, `private, no-store`.

#### "Download all" (`/albums/download/<vanity>.zip`)

The shown items in album order (`items_storage` gives each one's key, size and filename; a paginated payload adds the rest of `items_storage`, with the same visibility rule). Only `ok` items are listed by the API, so pending, hidden, removed and blocked items are never in a ZIP; NSFW items are. An album with nothing to show is a 404; a hidden or removed album a 410. `worker/utils/zip.js` streams it:
- store mode, bit 3 data descriptors with the CRC-32 computed while streaming (slice-by-8, about 1.5 GB/s, so a 2 GiB album costs about 1.5 s of CPU), bit 11 UTF-8 names, no ZIP64;
- names cleaned like CDN filenames, with `/` and `\` replaced by `_`, and duplicates (case-insensitive) numbered `name (2).ext`;
- items are read one at a time, only as the client reads, with a plain `GET` (no client `Range`), from the edge cache when there but never written to it;
- an exact `Content-Length` (through `FixedLengthStream`), so browsers show progress, and `HEAD` answers without reading anything;
- an item that can't be read, or isn't the size `items_storage` says, aborts the response, so the client sees a failed download, never a short archive;
- over 2 GiB of items: `413 {"code":"ZIP_TOO_LARGE","message","status":413,"limit":2147483648}`, after the access check and before any read;
- `Content-Disposition: attachment; filename="<title or vanity>.zip"`, `Cache-Control: private, no-store`;
- one storage subrequest per item, so a 500-item album needs the paid plan's subrequest limit.

## Build order and deploy

The Worker serves `../web/dist`, so **build `web` first**, then deploy the Worker:

```sh
npm run build:web      # npm ci + vite build in ../web, which writes ../web/dist
npm run deploy         # wrangler deploy: uploads the Worker, web/dist as static assets, and the routes
```

`wrangler deploy` fails if `../web/dist` doesn't exist. Deploy the Worker after every `web` build: the shell references hashed asset names.

The old `tools/` uploader is gone. On the first Wrangler deploy:
- remove the old zone script and its routes in the dashboard;
- add `www.files.gg/*` to `routes` if it was routed before;
- the `*/*` route sends every other hostname on the zone to the Worker (custom domains). Give any hostname that must not reach it (mail, status) its own route without a Worker.

## Run locally

```sh
npm install
npm run build:web      # the shell and assets come from ../web/dist
npm run dev            # wrangler dev on http://localhost:8787
npm test               # unit and integration tests
npm run build          # bundle into dist/ exactly as deploy would, without uploading
```

- **Other hosts in dev:** `wrangler dev` rewrites every request to the first route's host (`files.gg`) and ignores the `Host` header. Use `--host` for another domain, for example `npm run dev -- --host cdn.files.gg`.
- **The whole stack locally:** `e2e/up.sh` runs this Worker under `wrangler dev` with a config generated from `wrangler.toml` minus the routes, so `Host` is kept, and `MAIN_HOST`/`CDN_HOST`/`API_HOST` set to `files.localhost`, `cdn.files.localhost` and `api.files.localhost` (see `e2e/README.md`).
- **Local secrets:** put them in `.dev.vars`, which is git-ignored. For local B2, point `S3_ENDPOINT` at MinIO.
- **npm 11** skips the `esbuild` and `workerd` install scripts until you approve them (`npm install-scripts approve esbuild workerd`). Wrangler and the tests work without them.

## Secrets and variables

Bindings come from `env`. Set secrets with `npx wrangler secret put <NAME>`, and generate shared values with `openssl rand -hex 32`.

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `ORIGIN_SHARED_SECRET` | secret | **yes** | Must equal the API's. Sent as `X-Filesgg-Origin-Secret` on internal lookups. On API passthrough requests it is sent with `X-Filesgg-Client-Ip` (from `CF-Connecting-IP`), and client-sent copies of these headers (and of `X-Filesgg-Internal-Lookup`) are removed. Unset: pages are `unavailable` and the CDN returns 503. |
| `CDN_SIGNING_SECRET` | secret | **yes**, for protected files and albums | Must equal the API's `CDN_SIGNING_SECRET`. Verifies signed CDN URLs (`expires` and `sig`), staff URLs (`staff=`) included; the Worker never signs. Unset: every signed URL is rejected (401 or 404), and `link` files are unaffected. Rotating it invalidates every signed URL in circulation. |
| `S3_READ_ACCESS_KEY_ID` | secret | yes, for B2 | A B2 application key id with **`readFiles` only**, scoped to the files bucket. Never the API's write key. |
| `S3_READ_SECRET_ACCESS_KEY` | secret | yes, for B2 | Its secret. |
| `S3_ENDPOINT` | var | yes, for B2 | B2's S3 endpoint, for example `https://s3.us-west-004.backblazeb2.com` (path-style requests). |
| `S3_REGION` | var | yes, for B2 | For example `us-west-004`. |
| `S3_BUCKET_FILES` | var | yes, for B2 | The private files bucket. Until all five `S3_*` bindings are set, every CDN read is a 503. |
| `SESSION_COOKIE_NAME` | var | no | The session cookie forwarded on `files.gg/api/*` (and passed back in `Set-Cookie`), nowhere else. Default `__Host-filesgg_session`; the plain-http local stack sets `filesgg_session`, matching the API's `SESSION_COOKIE_INSECURE`. Must be a cookie name; anything else fails every request. |
| `MAIN_HOST`, `CDN_HOST`, `API_HOST` | var | no | The public hostnames (defaults `files.gg`, `cdn.files.gg`, `api.files.gg`). They drive the routing (`MAIN_HOST` also answers on `www.`; every other hostname is a custom domain), the viewer and CDN CSPs, the cookie routes, rehosting and the default og:image. Bare hostnames only; anything else fails every request. URLs are `https://<host>`, except that a plain-http request to a loopback name (`*.localhost`, `127.0.0.1`) keeps its scheme and port, for `wrangler dev`. Production leaves them unset; `e2e/` sets them to `*.files.localhost`. |
| `API_ORIGIN` | var | no, tests and local only | Overrides the API origin (default `https://<API_HOST>`). Leave it unset in production. |

`CDN_TOKEN_SECRET`, `STORAGE_GCS_FALLBACK`, `STORAGE_ORIGIN` and `CORS_ALLOWED_ORIGINS` are gone; delete them from deployed Workers (`npx wrangler secret delete CDN_TOKEN_SECRET`; `CORS_ALLOWED_ORIGINS` in the dashboard's variables).

To rotate `ORIGIN_SHARED_SECRET` or `CDN_SIGNING_SECRET`, set the new value on the API and on the Worker at the same time.

## Tests

- **Unit tests** (`test/*.test.js`) cover the pure modules in `worker/utils/`:
  - trust and safety (`test/safety.test.js`): the lookup states, the file and album shells per state (milestone-4.md §14.3), NSFW redirects and og tags, `serve_inline`, the report routes and reserved segment, and the staff grant's §14.1 vectors, its 600 s cap and expiry;
  - signed URLs (`test/signing.test.js`): the contract's §3 test vectors (and the stale-version one that must be rejected), checked against the Worker and against an independent Node `crypto` signer, plus single-path validity, grants, `album=` rules, expiry and the 31-day cap, and malformed `expires` and `sig`;
  - CDN path parsing (`test/media.test.js`): multi-segment vanities, a vanity named like a kind, wrong extensions, unknown kinds, extra segments; the preview types and the ZIP plan;
  - the ZIP writer (`test/zip.test.js`): CRC-32 against zlib across chunk boundaries, and archives opened by JSZip with CRC checks on and by Info-ZIP `unzip -t` (skipped when the system has none);
  - the shell decisions, escaping, meta tags (milestone 3 embeds included), CSP and routing order;
  - filename sanitizing, dispositions, CDN headers, CORS, the origin-secret headers and bot routing;
  - milestone 6 (`test/accounts.test.js`): the session cookie rules, the auth redirects and reserved segments, owner state, domain-only and scope, custom-domain routing, the §16.5 rehosting vectors (with signature validity), the custom and challenge CSPs.
- **Integration tests** (`test/integration/*.test.js`) run the real Worker with Wrangler's `createTestHarness` (workerd). They run against two local mocks:
  - the API: internal lookups by vanity that check the secret, with snake_case payloads whose URLs are unsigned (files with previews, albums with `items_storage` and collages), milestone-4.md §6.3's `safety`, `serve_inline` and `pending_count` (with a fixture in every state, and hash-matched CSAM answering 404), and an echo for the passthrough;
  - **B2/S3:** it recomputes every request's SigV4 signature and rejects bad ones. It holds file blobs, previews and collages.

  Tests sign URLs the way the API does, with `test/support/signing.js` (Node `crypto`). `test/integration/cdn.test.js` covers files and signed URLs, `test/integration/media.test.js` previews, collages and ZIPs, which it unzips and checks, `test/integration/safety.test.js` every milestone 4 state on pages, files, previews, collages and ZIPs, NSFW, `serve_inline`, the staff grant, the report routes and `security.txt`, `test/integration/sessions.test.js` the cookie rules on every host (§16.11), `X-Filesgg-Via`, `/internal`, the auth redirects, reserved segments and `/challenge`, and `test/integration/custom-domains.test.js` the custom-domain serving matrix (§16.10), rehosting, staff URLs, pending deletions and the validation paths. The API mock also answers the domain lookup and sets session cookies.

  Static assets come from `test/fixtures/web-dist`, which holds a real build's `viewer.html` and `app.html` plus placeholders and a `.well-known/security.txt`. To test against a real build, run `WEB_DIST=../web/dist npm run test:integration`.

## cdn.files.gg serving rules

The rules live in `worker/utils/security.js`. The spec is `docs/redesign/PLAN.md`, under "Hardening cdn.files.gg".

- HTML, SVG, XHTML and every XML type are always served as `text/plain`. `?force-text=true` forces any file to `text/plain`.
- `Content-Disposition` is `inline` only for images (except SVG), audio, video and `text/plain`, and only without `?download=true`. Everything else, PDFs included, is `attachment`.
- Filenames are sanitized:
  - bidi, zero-width and control characters are removed;
  - whitespace is collapsed;
  - names are capped at 255 bytes, keeping the final extension.

  They're sent as `filename="<ascii>"; filename*=UTF-8''<encoded>`.
- Every response, 404s and errors included, carries:
  - the sandbox CSP, `nosniff`, COOP, `Referrer-Policy: no-referrer` and CORP `cross-origin`;
  - `Access-Control-Allow-Origin: *`, without credentials, plus the exposed range headers that pdf.js needs.
- Storage 403s become 404s.
- `cdn.files.gg` never serves `web/dist` (except `/.well-known/security.txt`), and serves nothing outside the four URL shapes above.
