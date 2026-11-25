# Milestone 2 contract

This is the shared contract between `api/`, `cf-worker/` and `web/` for Milestone 2. It covers:
- B2 storage;
- streaming and chunked uploads;
- expiry and limits;
- access control (link, password and private), with Turnstile and signed CDN tokens;
- the Worker serving the new viewer shell.

The design behind each item is in [`../PLAN.md`](../PLAN.md). This file pins the **exact formats** all three parts must agree on. When this file and the plan disagree, this file wins for Milestone 2. Fix the plan afterwards.

It extends the viewer boot contract in [`web/README.md`](../../web/README.md) ("Worker contract"). Everything there still holds unless it's changed here.

---

## 1. Signed access token (`CDN_TOKEN_SECRET`)

**Used for:**
- password unlocks;
- owner passes;
- every CDN request for a protected file or album.

The API mints the token and the Worker verifies it. Both must produce **byte-identical** tokens from the same inputs.

**Format:** `base64url(body_json) + "." + base64url(HMAC_SHA256(secret, base64url(body_json)))`
- base64url has **no padding** (RFC 4648 §5).
- `body_json` is the JSON of the claims with **keys sorted** and **no whitespace**, which is Python's `json.dumps(claims, separators=(',', ':'), sort_keys=True)`. The JS side must serialise the same way. Build the object with keys in sorted order and use `JSON.stringify`.
- Verify the HMAC with a **constant-time** comparison, then parse the claims.

**Claims (all required):**

| Key | Type | Meaning |
|---|---|---|
| `k` | `"file"` or `"album"` | What the token is for |
| `t` | string | The file or album **id** (snowflake), as a string, never a number |
| `s` | `"unlock"` or `"owner"` | `unlock` comes from entering the password; `owner` is an owner pass |
| `v` | int | The target's `access_version` when minted. If it doesn't match the current value, the token is invalid. |
| `u` | int, epoch seconds | When the unlock (or pass) was granted. Refreshes keep it unchanged. |
| `e` | int, epoch seconds | Expiry: `min(u + unlock_ttl, password_expires_at)`, or `u + 3600` for an owner pass. |

**Valid when:**
1. the signature matches;
2. `e > now`;
3. `k` and `t` match the requested file, *or* `k = "album"` and the requested file is a visible item of album `t`;
4. `v` equals the target's current `access_version`.

**Test vectors** (secret `test-cdn-token-secret`). Both implementations must reproduce these exactly:

| Claims | Token |
|---|---|
| `{"e":1795603600,"k":"file","s":"unlock","t":"1234567890123456789","u":1795600000,"v":0}` | `eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjB9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk` |
| `{"e":1796204800,"k":"album","s":"unlock","t":"987654321098765432","u":1795600000,"v":3}` | `eyJlIjoxNzk2MjA0ODAwLCJrIjoiYWxidW0iLCJzIjoidW5sb2NrIiwidCI6Ijk4NzY1NDMyMTA5ODc2NTQzMiIsInUiOjE3OTU2MDAwMDAsInYiOjN9.363h20AIfnXPJ20FngplD6_ARO_pidniwnoIaD0Lebk` |
| `{"e":1795603600,"k":"file","s":"owner","t":"1234567890123456789","u":1795600000,"v":2}` | `eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJvd25lciIsInQiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5IiwidSI6MTc5NTYwMDAwMCwidiI6Mn0.S7b7xKQg5Cu19qkZa4BGRNLeZgwmnVmqGjN_1p4nFiE` |
| Tampered: the first token's body with `v` changed to 1, but the old signature (must be **rejected**) | `eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjF9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk` |

**How the token travels:**
- **On CDN URLs:** as the `t` query parameter, for example `https://cdn.files.gg/files/<vanity>.<ext>?t=<token>`. The viewer appends it to every media, download and Raw URL for protected files.
- **In the page URL:** an owner pass arrives in the fragment, `#t=<token>`. A password arrives as `#pw=<password>`. Neither ever reaches a server.
- **Thumbnails and other derived assets** take the same `?t=` (Milestone 3).

---

## 2. Worker ↔ API: internal lookup

The Worker never sees storage keys or hashes in public responses. To serve a file or a page, it asks the API:

```
GET https://api.files.gg/internal/files/<vanity>
GET https://api.files.gg/internal/albums/<vanity>
X-Filesgg-Origin-Secret: <ORIGIN_SHARED_SECRET>
X-Filesgg-Internal-Lookup: 1
```

- **Without the right secret, or without the lookup header:** `404`, identical to an unknown vanity (milestone-3 §5: the secret alone is on every forwarded request).
- **Unknown, deleted or expired:** `404 {"code":"UNKNOWN_FILE"}`.
- **Found:**

```json
{
  "file": { "...the public file payload (web/README.md §3), with cdnUrl and url WITHOUT any token..." },
  "access": {
    "visibility": "link",
    "access_version": 0,
    "unlock_ttl": 3600,
    "password_expires_at": null,
    "show_name_when_locked": false
  },
  "owner_user_id": "1234567890123456789",
  "albums": [{ "id": "987654321098765432", "access_version": 3 }],
  "storage": { "backend": "b2", "key": "files/987654321" }
}
```

- **`file.visibility`** (`"link"`, `"password"` or `"private"`) is part of the **public** file payload everywhere: the internal lookup, unlock, `/view` and album items. It isn't sensitive. It lets the viewer skip `?t=` for `link` items inside a protected album.
- **`file.id` is required here:** the snowflake as a string. web/README §3 lists it as optional for the viewer, but the Worker needs it to match token claims.
- **`albums`** lists every album the file is a visible item of, as `{ id: string, access_version: int }`. It's an empty list until albums exist (Milestone 3).
  - The Worker accepts a `k: "album"` token for a file only if some entry has `id == t` **and** `access_version == v`. So changing an album's password or access revokes its tokens immediately (rule 4), with one lookup and no lookup by album id.
  - If the field is missing, treat it as `[]`, which fails closed.

- **`visibility`** is `"link"`, `"password"` or `"private"`.
- **`password_expires_at`** is epoch seconds, or `null`.
- **`storage.backend`**: removed in Milestone 3, which is B2 only (milestone-3.md §5).
- **`owner_user_id`** is `null` for anonymous uploads.

The album lookup returns `{ "album": {…album payload, web/README.md §4…}, "access": {…}, "items_access": { "<file id>": { "visibility": …, "access_version": … } } }`.

- **The Worker caches** lookups for 30 s with the Cache API, keyed by vanity. Unknown vanities are cached for 30 s too, as negative entries.
- **The API returns** `Cache-Control: no-store` on the response itself.

---

## 3. Storage (B2, S3-compatible)

- **Object keys:** `files/<hash_id>`, unchanged from today. Later: `derived/<hash_id>/<kind>.<ext>` and `staging/<upload_id>`.
- **API:** writes and deletes with **aiobotocore** (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_FILES`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), using a write/delete key.
- **`python -m worker`:** uses **boto3** (sync) with the same settings, for `finalize_upload`.
- **CDN Worker:** reads with **SigV4-signed `GET`/`HEAD`**, using a **read-only** key stored as Worker secrets (`S3_READ_ACCESS_KEY_ID`, `S3_READ_SECRET_ACCESS_KEY`) and vars (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_FILES`).
  - `Range`, `If-None-Match` and `If-Modified-Since` are passed through.
  - On a `404` from B2 when `storage.backend` is `"gcs"`, or for any object during migration, it falls back to the existing GCS origin.
- **Local and tests:** **MinIO** stands in for B2, so tests never touch real Backblaze.

---

## 4. Viewer shell: new states (extends web/README.md §2)

| Case | `data-page` | `data-state` | Script tag | HTTP |
|---|---|---|---|---|
| `password` file, no valid token | `file` | `locked` | `#file-data` = `{"vanity":"…","protected":"password","filename":"…"?}`. `filename` is present only when `show_name_when_locked` is on. | 200 |
| `password` file whose password has expired | `file` | `locked` | the same, plus `"password_expired": true` | 200 |
| `private` file (no owner pass) | `file` | `missing` | `null` | 404 |
| `password` album | `album` | `locked` | `#album-data` = `{"vanity":"…","protected":"password","title":"…"?}`. `title` is present only when `show_name_when_locked` is on. | 200 |

- **Locked pages:** the `og:*` meta tags are the generic "Password-protected file · files.gg", with **no image or video**.
- **Bots:** the existing bot, ShareX, Telegram and `Accept: image/*` redirect to the CDN must **not** happen for `password` or `private` files. Those get the locked or missing shell, so they never leak bytes.
- **Owner pass:** when the page URL has `#t=`, the client uses it directly, never calling the unlock endpoint, and then strips it.

---

## 5. Unlock (browser only)

```
POST /files/<vanity>/unlock      { "password": "…", "turnstile_token": "…" }
POST /albums/<vanity>/unlock     { "password": "…", "turnstile_token": "…" }
```

**Order of checks:**
1. **Turnstile**, with action `unlock`, checked against Cloudflare's `siteverify`. Failure gives `403 CAPTCHA_INVALID`, and the password is **not** checked.
2. **Rate limit:** 5 attempts a minute per file and IP. Over the limit gives `429 TOO_MANY_ATTEMPTS { "retry_after": <s> }`.
3. **Password expiry:** an expired password gives `410 PASSWORD_EXPIRED`.
4. **The password itself** (argon2id): wrong gives `401 WRONG_PASSWORD`.

**On success:** `200 { "token": "…", "expires_at": <epoch s>, "file": { …full public payload… } }`. For albums it returns `"album"` instead of `"file"`.

```
POST /files/<vanity>/unlock/refresh   { "token": "…" }   → 200 { "token", "expires_at" }   (no Turnstile)
```

```
POST /albums/<vanity>/unlock/refresh  { "token": "…" }   → 200 { "token", "expires_at" }   (no Turnstile)
```

- **Unlock tokens:** refreshing keeps `u` and returns `e = min(now + 3600, u + unlock_ttl, password_expires_at)`. Once nothing is left, the response is `401 UNLOCK_EXPIRED`.
- **Owner passes** (`s: "owner"`) refresh through the same endpoints. They return `e = min(now + 3600, u + 43200)`, so an owner pass lives at most **12 h** from when it was minted. After that the owner opens it again from the dashboard. `access_version` still has to match.

**Viewing with a token you already hold:**

```
GET /files/<vanity>/view      X-Filesgg-Access: <token>   → 200 { "file": {…full public payload…}, "expires_at": <token e> }
GET /albums/<vanity>/view     X-Filesgg-Access: <token>   → 200 { "album": {…}, "expires_at": … }
```

This covers a returning visitor with a stored unlock token, and an owner-pass (`#t=`) visit.
- **Why it's needed:** the server-rendered shell can't know about either token, because the fragment and `localStorage` never reach the Worker. So the shell shows `locked` (password) or `missing` (private), and the client swaps the token for the payload here.
- **Accepted:** any valid token (contract §1) for that target, with `unlock` or `owner` scope. Albums also accept a token for an album containing the file.
- **Invalid, expired or wrong version:** `401 UNLOCK_EXPIRED`.
- **`private` files:** a wrong or missing token gives `404 UNKNOWN_FILE`, so the endpoint never confirms the file exists.
- **Turnstile:** not needed. The token is already the proof, and it's rate-limited like `refresh`.
- **Header, not query string:** the token goes in a header so it stays out of API access logs.

**Owner passes** (signed in):

```
POST /users/@me/files/<id>/pass       → 200 { "token", "expires_at", "url" }
POST /users/@me/albums/<id>/pass      → 200 { "token", "expires_at", "url" }
```

- `url` is `https://files.gg/<vanity>#t=<token>`. Custom domains come in Milestone 6.

---

## 6. Uploads

### Single request (unchanged path, new rules)

`POST /files`: multipart (`file`) or `type=raw`.

**New optional fields:**

| Field | Values |
|---|---|
| `expires_in` | seconds |
| `visibility` | `link` (default), `password` or `private` (`private` needs an account) |
| `password` | 6–128 characters |
| `generate_password` | `true` |
| `unlock_ttl` | seconds, one of 600 / 3600 / 86400 / 604800 / 2592000 |
| `password_expires_in` | seconds |

**Anonymous uploads** (`X-Fingerprint`, no `Authorization`) also need `turnstile_token`, with action `upload`.

**Limits:** 100 MB signed in and 25 MB anonymous, checked from `Content-Length` before reading, then against the real size.

**Response:** today's file object, plus `expires_at` (epoch s or `null`) and `visibility`. With `generate_password`, it also includes `password` (once) and `url_with_password` (`https://files.gg/<vanity>#pw=<password>`).

### Chunked

| Request | Response |
|---|---|
| `POST /uploads { filename, size, expires_in?, visibility?, password?, generate_password?, unlock_ttl?, password_expires_in?, turnstile_token? }` | `201 { "upload_id", "chunk_size": 10485760, "chunk_count", "expires_at" }` |
| `PUT /uploads/<id>/chunks/<index>` (raw body, exactly `chunk_size` bytes except the last) | `204` |
| `GET /uploads/<id>` | `200 { "status": "open"\|"processing"\|"complete"\|"failed", "received": [indexes], "size", "file"?: {…}, "error"?: "CODE" }` |
| `POST /uploads/<id>/complete` | `202 { "status": "processing" }`. Poll `GET /uploads/<id>` until `complete` or `failed`. |
| `DELETE /uploads/<id>` | `204` |

- **Limit:** 1 GB signed in, 25 MB anonymous. Sessions expire after 24 h.
- **Turnstile:** `turnstile_token` is required on `POST /uploads` for anonymous users only, never on chunks.
- **Ownership:** the session belongs to the token or fingerprint that created it. Anyone else gets `404`.

### Limits

`GET /users/@me/limits`. Anonymous callers send `X-Fingerprint` and get the anonymous values.

```json
{
  "storage": { "used": 0, "limit": 10737418240 },
  "max_file_size_single": 104857600,
  "max_file_size_chunked": 1073741824,
  "max_expiry": null,
  "allow_no_expiry": true,
  "anonymous": false
}
```

- **`max_expiry`:** seconds, or `null` for no maximum.
- **`storage.limit`:** `null` for anonymous callers, whose files expire instead.

---

## 7. Errors

**New endpoints** return string codes: `{ "code": "FILE_TOO_LARGE", "message": "…", "status": 413, ...details }`. The web client already accepts string or numeric codes.

| Code | HTTP | Details |
|---|---|---|
| `FILE_TOO_LARGE` | 413 | `limit` |
| `STORAGE_LIMIT_REACHED` | 413 | `limit`, `used` |
| `EXPIRY_NOT_ALLOWED` | 400 | `max_expiry` |
| `CAPTCHA_INVALID` | 403 | |
| `TOO_MANY_ATTEMPTS` | 429 | `retry_after` |
| `WRONG_PASSWORD` | 401 | |
| `PASSWORD_EXPIRED` | 410 | |
| `UNLOCK_EXPIRED` | 401 | |
| `UNKNOWN_FILE` | 404 | |
| `UNKNOWN_UPLOAD` | 404 | |
| `UPLOAD_INCOMPLETE` | 409 | `missing` (indexes) |
| `CHUNK_SIZE_MISMATCH` | 400 | `expected` |
| `PRIVATE_REQUIRES_ACCOUNT` | 400 | |
| `RESERVED_VANITY` | 400 | |

Old endpoints keep their existing numeric codes, so the golden responses still match.

---

## 8. Turnstile

- **Site key:** public, `TURNSTILE_SITE_KEY`, in `web/` config.
- **Secret:** `TURNSTILE_SECRET`, in the API.
- **Server-side check:** the API calls `siteverify` and checks `success`, `action` (`upload`, `unlock`, `login`, `register`, `forgot`) and `hostname` (`files.gg`, or `localhost` in dev).
- **reCAPTCHA is removed:** login, register and forgot now take `turnstile_token` instead of `captcha`.
- **Tests and local dev** use **Cloudflare's documented testing keys**: a site key that always passes, one that always fails, and the matching secrets. Look up the exact values in Cloudflare's Turnstile docs ("Testing"); don't guess them.

---

## 9. Expiry, reserved vanities, misc

- **Expired files** (`expires_at <= now`) behave as unknown everywhere at read time. The reaper soft-deletes them every 10 minutes. Anonymous uploads have a maximum expiry of 21 days, default 21 days. Signed-in users can pick 1 h to never.
- **`blacklisted_ids` gains:** `app`, `api`, `a`, `convert`, `internal`, `report`, `uploads`, `favicon`, `apple-touch-icon` and `og-image`.
- **New secrets in `docker-compose.yml`:** `CDN_TOKEN_SECRET` (shared with the Worker), `TURNSTILE_SECRET`, and `S3_*` for the files bucket.
- **The Worker's secrets** are listed in `cf-worker/README.md`.
