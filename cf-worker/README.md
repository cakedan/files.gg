# files.gg Cloudflare Worker

This is one ES-module Worker (`export default { fetch }`), configured in `wrangler.toml` and deployed with Wrangler. It routes requests with [`cf-worker-router`](https://github.com/cakedan/cf-worker-router), signs B2 requests with [`aws4fetch`](https://github.com/mhart/aws4fetch), and serves `web/dist` as Workers static assets.

The contracts it implements:
- `web/README.md`, "Worker contract": the viewer shell;
- `docs/redesign/contracts/milestone-2.md`: tokens, internal lookups, storage and the locked states;
- `docs/redesign/PLAN.md`, "Hardening cdn.files.gg".

## Routes it owns

| Route | Code | What it does |
|---|---|---|
| `files.gg/*` | `worker/domains/stable.js`, `worker/shell.js` | The new viewer and dashboard from `web/dist`, the viewer shell with inlined boot data, bot/embed redirects, the `/api/*` passthrough, and the old frontend's pages. |
| `cdn.files.gg/*` | `worker/domains/cdn.js`, `worker/storage.js` | File bytes from B2 (GCS fallback), after the access check, under the hardening rules below. |
| `api.files.gg/*` | `worker/domains/api.js` | Passthrough to the API origin, with the origin secret and credentialed CORS. |
| `proxy.files.gg/*` | `worker/domains/proxy.js` | `/download/<url>` and `/unfurl/<url>`. Only callers that hold `PROXY_SECRET` can use it. |

`worker/index.js` sets CORS on every response, and the sandbox headers on every `cdn.files.gg` response.

### files.gg, in order (web/README.md §1)

1. `/api` and `/api/*` go to the API.
2. **Root files** (`/favicon.ico`, `/favicon.svg`, `/favicon-{16,32,48}.png`, `/apple-touch-icon.png`, `/icon-{192,512}.png`, `/og-image.png`) come from `web/dist`, cached for a day. They are exact paths, so they never reach the vanity lookup.
3. **`/assets/*`** comes from `web/dist`, cached as immutable for a year.
   - `.mjs` and `.js` are served as `text/javascript`, and `.wasm` as `application/wasm`.
   - A path missing from `web/dist` falls back to the old frontend's bundle in GCS (`/assets/stable/*`).
4. **`/app` and `/app/*`** serve `app.html` with `Cache-Control: no-cache`.
5. **`/`** is the `home` page, and **`/convert`** is the `convert` page.
6. **`/a/<vanity>` and `/a/<vanity>/<n>`** are albums.
7. **The old frontend's pages (temporary)** get the legacy shell, which loads the old bundle from GCS:
   - `/auth` and `/auth/*`: login, register, logout, and the email-verify and password-reset links (`/auth/verify/<token>`, `/auth/forgot/<token>`) that the API's emails point to;
   - `/dashboard` and `/dashboard/*`;
   - `/details/*`;
   - `/legal` and `/legal/*`;
   - `/options` and `/options/*`.

   Milestone 6 replaces these pages. Remove the legacy shell (`renderLegacy` in `stable.js`, `legacyMetatags` in `utils/pages.js`, and the GCS `/assets/*` fallback) at that point.
8. **`/<vanity>` and `/<vanity>.<anything>`** are files, multi-segment vanities included.

### The viewer shell

The Worker fetches `viewer.html` from the `ASSETS` binding and rewrites it with `HTMLRewriter`:
- it sets `data-page` and `data-state` on `#root`;
- it inserts `<script id="file-data">` or `<script id="album-data">` after `#root`, escaping `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`;
- it replaces everything between the `filesgg:meta` markers with the file's own meta tags, using `property=` for `og:*`.

The rules live in `worker/utils/viewer.js`:

| Case | `data-page` / `data-state` | Boot JSON | HTTP |
|---|---|---|---|
| `link` file | `file` / `file` | the file payload | 200 |
| `password` file | `file` / `locked` | `{vanity, protected, filename?, password_expired?}` | 200 |
| `private`, unknown, deleted or expired file | `file` / `missing` | `null` | 404 |
| API down, timed out or 5xx | `file` / `unavailable` | none | 503 (`private, no-store`) |
| Album with visible items | `album` / `album` | the album, minus `private` items | 200 |
| `password` album | `album` / `locked` | `{vanity, protected, title?}` | 200 |
| Album that's private, missing or empty | `album` / `missing` | none | 404 |

- **Meta tags:** locked pages get generic ones ("Password-protected file · files.gg"), with no name, image or video. Home, convert, missing and unavailable pages keep `viewer.html`'s defaults.
- **Headers:** every shell is served as `text/html; charset=utf-8` with `Cache-Control: no-cache`, the viewer CSP (web/README.md §6, plus Turnstile and `api.files.gg`) and `nosniff`.
- **TODO (Milestone 3):** `app.html` is served without a CSP. It needs its own, like the viewer's.
- **Bot redirects:** ShareX, Telegram, requests without `Accept-Language` or `Accept`, and `Accept: <type>/*` are redirected to the CDN, but only for `link` files. Password and private files get the locked or missing shell.

### Internal lookups

The Worker asks the API for `GET /internal/files/<vanity>` and `GET /internal/albums/<vanity>`, sending `X-Filesgg-Origin-Secret`.
- **Caching:** results are cached for 30 s with the Cache API, keyed by vanity. Unknown vanities are cached too, as negative entries. 5xx responses and timeouts (8 s) aren't cached.
- **Without `ORIGIN_SHARED_SECRET`:** every page is `unavailable`, never `missing`, so a misconfiguration doesn't look like deleted files.

### cdn.files.gg/files/<vanity>[.<anything>]

1. **Look up the vanity.** Unknown or expired gives 404, and API down gives 503.
2. **Check access.** `link` files are public. `password` and `private` files need `?t=<token>` (contract §1):
   - the HMAC (constant-time), `e > now`, and well-formed claims;
   - `k: "file"` with `t` equal to the file's id and `v` equal to its `access_version`;
   - or `k: "album"` where some entry of the file lookup's `albums` (`[{ id, access_version }]`, the albums the file is a visible item of) has `id` equal to `t` and `access_version` equal to `v`. Missing or empty `albums` denies. A `private` file needs an owner pass even through an album.
   - **A lookup without `file.id`** (required by contract §2) denies every token and logs `API contract error`.
   - Without a valid token, `password` gives **401** and `private` gives **404**. Protected responses, errors included, get `Cache-Control: private, no-store`.
3. **Fetch the bytes.** Only after the check passes:
   - **Edge cache:** whole-object `GET`s are served from the edge cache, keyed by the storage key (`files/<hash_id>`).
   - **B2:** otherwise the Worker sends a SigV4-signed `GET` or `HEAD` to B2, with `Range`, `If-None-Match` and `If-Modified-Since` passed through. No other client header reaches storage, and `x-amz-*` and `x-bz-*` headers never reach the client.
   - **GCS fallback:** a B2 `404` is retried on GCS when `storage.backend` is `"gcs"`, or for any object while `STORAGE_GCS_FALLBACK` isn't `"false"`. Without the `S3_*` bindings, everything is read from GCS.
4. **Set the headers.** Content type and disposition follow the hardening rules below. Public responses get `public, max-age=3600`.

## Build order and deploy

The Worker serves `../web/dist`, so **build `web` first**, then deploy the Worker:

```sh
npm run build:web      # npm ci + vite build in ../web, which writes ../web/dist
npm run deploy         # wrangler deploy: uploads the Worker, web/dist as static assets, and the routes
```

`wrangler deploy` fails if `../web/dist` doesn't exist. Deploy the Worker after every `web` build: the shell references hashed asset names.

The old `tools/` uploader is gone. On the first Wrangler deploy:
- remove the old zone script and its routes in the dashboard;
- add `www.files.gg/*` to `routes` if it was routed before.

## Run locally

```sh
npm install
npm run build:web      # the shell and assets come from ../web/dist
npm run dev            # wrangler dev on http://localhost:8787
npm test               # unit and integration tests
npm run build          # bundle into dist/ exactly as deploy would, without uploading
```

- **Other hosts in dev:** `wrangler dev` rewrites every request to the first route's host (`files.gg`) and ignores the `Host` header. Use `--host` for another domain, for example `npm run dev -- --host cdn.files.gg`.
- **The whole stack locally:** `e2e/up.sh` runs this Worker under `wrangler dev` with a config generated from `wrangler.toml` minus the routes, so `Host` is kept, and `MAIN_HOST`/`CDN_HOST`/`API_HOST`/`PROXY_HOST` set to `files.localhost`, `cdn.files.localhost`, `api.files.localhost` and `proxy.files.localhost` (see `e2e/README.md`).
- **Local secrets:** put them in `.dev.vars`, which is git-ignored. For local B2, point `S3_ENDPOINT` at MinIO.
- **npm 11** skips the `esbuild` and `workerd` install scripts until you approve them (`npm install-scripts approve esbuild workerd`). Wrangler and the tests work without them.

## Secrets and variables

Bindings come from `env`. Set secrets with `npx wrangler secret put <NAME>`, and generate shared values with `openssl rand -hex 32`.

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `ORIGIN_SHARED_SECRET` | secret | **yes** | Must equal the API's. Sent as `X-Filesgg-Origin-Secret` on internal lookups. On API passthrough requests it is sent with `X-Filesgg-Client-Ip` (from `CF-Connecting-IP`), and client-sent copies of both headers are removed. Unset: pages are `unavailable` and the CDN returns 503. |
| `CDN_TOKEN_SECRET` | secret | **yes**, for protected files | Must equal the API's `CDN_TOKEN_SECRET`. Verifies `?t=` tokens. Unset: every token is rejected (401 or 404), and `link` files are unaffected. Rotating it invalidates every unlock and owner pass. |
| `S3_READ_ACCESS_KEY_ID` | secret | yes, for B2 | A B2 application key id with **`readFiles` only**, scoped to the files bucket. Never the API's write key. |
| `S3_READ_SECRET_ACCESS_KEY` | secret | yes, for B2 | Its secret. |
| `S3_ENDPOINT` | var | yes, for B2 | B2's S3 endpoint, for example `https://s3.us-west-004.backblazeb2.com` (path-style requests). |
| `S3_REGION` | var | yes, for B2 | For example `us-west-004`. |
| `S3_BUCKET_FILES` | var | yes, for B2 | The private files bucket. Until all five `S3_*` bindings are set, the CDN reads from GCS only. |
| `STORAGE_GCS_FALLBACK` | var | no (default `"true"`) | Retry objects missing from B2 on GCS during the migration. Set it to `"false"` after the copy is verified; `storage.backend: "gcs"` files still fall back. |
| `CORS_ALLOWED_ORIGINS` | var | no | Comma-separated origins allowed credentialed CORS on `api.files.gg` and `files.gg/api/*`. Defaults to the `MAIN_HOST` origin, `https://files.gg`. |
| `PROXY_SECRET` | secret | yes, for `proxy.files.gg` | Callers send it in `X-Proxy-Token`. Unset: every proxy request is 403. It is never forwarded. |
| `MAIN_HOST`, `CDN_HOST`, `API_HOST`, `PROXY_HOST` | var | no | The public hostnames (defaults `files.gg`, `cdn.files.gg`, `api.files.gg`, `proxy.files.gg`). They drive the routing (`MAIN_HOST` also answers on `www.`), the viewer and CDN CSPs, the default `CORS_ALLOWED_ORIGINS`, the credentialed routes, the default og:image and the proxy's links. Bare hostnames only; anything else fails every request. URLs are `https://<host>`, except that a plain-http request to a loopback name (`*.localhost`, `127.0.0.1`) keeps its scheme and port, for `wrangler dev`. Production leaves them unset; `e2e/` sets them to `*.files.localhost`. |
| `API_ORIGIN`, `STORAGE_ORIGIN` | var | no, tests and local only | Override the API origin (default `https://<API_HOST>`) and the GCS bucket. Leave them unset in production. |

To rotate `ORIGIN_SHARED_SECRET` or `CDN_TOKEN_SECRET`, set the new value on the API and on the Worker at the same time.

## Tests

- **Unit tests** (`test/*.test.js`) cover the pure modules in `worker/utils/`:
  - the token verifier, including the contract's four test vectors (the tampered one is rejected);
  - the shell decisions, escaping, meta tags, CSP and routing order;
  - filename sanitizing, dispositions, CDN headers, CORS, the origin-secret headers and the proxy check;
  - the legacy shell.
- **Integration tests** (`test/integration/*.test.js`) run the real Worker with Wrangler's `createTestHarness` (workerd). They run against three local mocks:
  - the API: internal lookups that check the secret, and an echo for the passthrough;
  - GCS;
  - **B2/S3:** it recomputes every request's SigV4 signature and rejects bad ones.

  Static assets come from `test/fixtures/web-dist`, which holds a real build's `viewer.html` and `app.html` plus placeholders. To test against a real build, run `WEB_DIST=../web/dist npm run test:integration`.
- **Page fixtures:** `test/fixtures/stable-pages.mithril.json` was captured from the old Mithril Worker. The legacy pages still match it byte for byte (apart from `og:*` → `property=`), and every bot redirect keeps its old `Location`.

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
- `cdn.files.gg` never serves `web/dist`. Raw paths other than `/files/*` still read the old GCS bucket (the old frontend's assets).
