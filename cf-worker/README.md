# files.gg Cloudflare Worker

This is one ES-module Worker (`export default { fetch }`), configured in `wrangler.toml` and deployed with Wrangler. It routes requests with [`cf-worker-router`](https://github.com/cakedan/cf-worker-router).

## Routes it owns

| Route | Code | What it does |
|---|---|---|
| `files.gg/*` | `worker/domains/stable.js` | The page shell for `files.gg/<vanity>` and the app routes, with OpenGraph and Twitter tags. Bots and embeds are redirected to the CDN (PLAN.md §1.4 item 3). Also serves `/assets/*` from storage and proxies `/api/*` to the API. |
| `cdn.files.gg/*` | `worker/domains/cdn.js` | File bytes from storage, served under the hardening rules below. |
| `api.files.gg/*` | `worker/domains/api.js` | Passthrough to the API origin, with the origin secret and credentialed CORS. |
| `proxy.files.gg/*` | `worker/domains/proxy.js` | `/download/<url>` and `/unfurl/<url>`. Only callers that hold `PROXY_SECRET` can use it. |

`/favicon.ico` on any of these hosts is served from storage. `worker/index.js` sets CORS on every response, and also the sandbox headers on every `cdn.files.gg` response.

## Run locally

```sh
npm install
npm run dev        # wrangler dev on http://localhost:8787
npm test           # unit tests plus integration tests against the real Worker
npm run build      # bundle into dist/ exactly as `deploy` would upload it, without uploading
```

`wrangler dev` rewrites every request to the first route's host (`files.gg`) and ignores the `Host` header. To work on another domain, start dev with `--host`, for example `npm run dev -- --host cdn.files.gg`.

In dev, the Worker calls the real `api.files.gg` and the real storage bucket. Put local secrets in `.dev.vars`, which is git-ignored:

```
PROXY_SECRET=dev-only
ORIGIN_SHARED_SECRET=dev-only
```

npm 11 skips the `esbuild` and `workerd` install scripts until you approve them (`npm install-scripts approve esbuild workerd`). Wrangler and the tests work without them.

## Deploy

```sh
npx wrangler login     # once
npm run deploy         # wrangler deploy: uploads the "files-gg" Worker and attaches the routes
```

The old `tools/` uploader is gone. It used the legacy zone-level script endpoint. On the first Wrangler deploy, remove the old zone script and its routes in the dashboard (Workers Routes on the `files.gg` zone), so they don't shadow the new routes. If `www.files.gg` was routed to the old script, add it to `routes` in `wrangler.toml`.

## Secrets and variables

Bindings come from `env`.

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `PROXY_SECRET` | secret | yes, for `proxy.files.gg` | Callers send it in `X-Proxy-Token`. When it isn't set, every proxy request is 403. The Worker strips the header before fetching the remote URL. |
| `ORIGIN_SHARED_SECRET` | secret | yes, for client IPs | Must equal the API's `ORIGIN_SHARED_SECRET`. Sent as `X-Filesgg-Origin-Secret`, with `X-Filesgg-Client-Ip` (from `CF-Connecting-IP`), on every API request. Client-sent copies of both headers are always removed. When it isn't set, neither header is sent, a warning is logged, and the API falls back to nginx's address. |
| `CORS_ALLOWED_ORIGINS` | var (`wrangler.toml`) | no | Comma-separated origins allowed credentialed CORS on `api.files.gg` and `files.gg/api/*`. Defaults to `https://files.gg`. |
| `API_ORIGIN`, `STORAGE_ORIGIN` | var | no, tests only | Override `https://api.files.gg` and the storage bucket. The integration tests use them to point the Worker at a mock. Leave them unset in production. |

Set or rotate a secret with a value from `openssl rand -hex 32`:

```sh
npx wrangler secret put PROXY_SECRET
npx wrangler secret put ORIGIN_SHARED_SECRET
```

To rotate `ORIGIN_SHARED_SECRET`, set the new value on the API and on the Worker at the same time. During the gap, per-IP limits fall back to Cloudflare's edge address. They get coarser, but nothing breaks.

## Tests

- **Unit tests** (`test/*.test.js`) cover the pure modules in `worker/utils/`:
  - filename sanitizing, `Content-Disposition`, the inline allowlist, the CDN headers, CORS, the origin-secret headers and the proxy token check;
  - page rendering and bot/embed routing.
- **Integration tests** (`test/integration/*.test.js`) run the real Worker with Wrangler's `createTestHarness` (workerd), built from `wrangler.toml` the same way `deploy` builds it. The API and storage are a local mock server (`test/support/worker.js`).
- **Page fixtures:** `test/fixtures/stable-pages.mithril.json` is the output of the old Mithril/webpack Worker, captured before Mithril was removed. The new pages must match it byte for byte, except that `og:*` tags now use `property=` instead of `name=`.

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
- A storage 403 becomes a 404. `<vanity>`, `<vanity>.<anything>` and multi-segment vanities all resolve.
