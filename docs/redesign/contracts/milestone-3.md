# Milestone 3 contract

This is the shared contract between `api/`, `cf-worker/` and `web/` for Milestone 3. It covers:
- media processing (`probe` and `derive`: metadata, thumbnails, posters, covers, waveforms, hover clips);
- serving derived media from `cdn.files.gg`;
- the album API, album pages and "Download all";
- the owner's file library endpoints, for the dashboard's Files and Albums sections;
- the viewer's players and text viewer.

The design behind each item is in [`../PLAN.md`](../PLAN.md) ("Media processing", "Albums", Phase 2 and Phase 3). This file pins the **exact formats**. When this file and the plan disagree, this file wins for Milestone 3. Fix the plan afterwards. Everything in [`milestone-2.md`](milestone-2.md) still holds unless it's changed here.

**Not in Milestone 3:** NSFW detection and scanning (Milestone 4; `nsfw` stays `false`), conversion (Milestone 5), the "Show my name on albums" setting (Milestone 6), and Monaco's "open in editor" mode.

---

## 0. Decisions of 2026-11-25 (override everything below and milestone-2.md)

1. **No backward compatibility, and a fresh start.** No data from the old databases or storage is migrated, and nothing is kept for old clients:
   - **Removed from the API:** the old response shapes (`to_dict()`, numeric error codes, the camelCase duplicates in payloads) and the recorded old-API tests. Every error is `{ code: "STRING", message, status, ...details }`. Payloads are snake_case with times in epoch seconds.
   - **Removed routes:** the old list `GET /files`, `DELETE /files/<vanity>`, `/users/@me/file-count`, `/users/@me/mimetypes` and `/google/health-check`.
   - **Removed from the Worker:** the old Mithril frontend (`/auth`, `/dashboard`, `/details`, `/legal`, `/options`), the CDN's legacy storage route, and the GCS fallback. B2 only.
   - **Removed from the web app:** the old localStorage keys and the `?line=` redirect.
   - **Old ShareX configs** stop working.
   - **Link formats are ours to choose.** `files.gg/<vanity>` and `cdn.files.gg/files/<vanity>.<ext>` stay because they're good, not for compatibility.
   - **Schema:** with no old data to carry, the migrations can be squashed into one clean schema, dropping the dual-write rollout trigger and the old columns.
2. **Signed URLs replace `?t=`** (§3).
3. **New CDN paths** (§3):
   - previews at `/previews/<kind>/<vanity>.<ext>`;
   - the collage at `/albums/collage/<vanity>.webp`;
   - the ZIP at `/albums/download/<vanity>.zip`.
   
   No ids in CDN URLs.

---

## 1. Schema (now part of `api/migrations/0001_schema.sql`, after the 2026-11-25 squash)

**`file_hashes` gains:**

| Column | Notes |
|---|---|
| `media jsonb` | `probe` output (§2). `NULL` until probed. |
| `processing_state text NOT NULL DEFAULT 'pending'` | `pending` → `probed` → `done`, or `failed` / `skipped`. Check constraint. |
| `probed_at`, `derived_at timestamptz` | `derived_at` is also the asset version (§3). |

**`file_hash_assets`** (one row per derived asset):

| Column | Notes |
|---|---|
| `hash_id bigint`, `kind text` | Primary key together. `kind` is a preview kind from §3, for example `thumb`. |
| `storage_key text` | `derived/<hash_id>/<kind>.<ext>` |
| `content_type text`, `size bigint`, `width int`, `height int` | `width`/`height` NULL for non-images. |
| `created_at timestamptz` | |

Blob garbage collection (when the last `File` for a hash goes) deletes the hash's derived objects and rows too.

**`albums`** and **`album_files`**: as in PLAN.md "Albums", plus the Milestone 2 access columns copied from `files`: `visibility`, `password_hash`, `access_version`, `unlock_ttl`, `password_expires_at`, `show_name_when_locked`. Also `collage_key text` and `collage_version bigint` (epoch s), and `moderation_state text NOT NULL DEFAULT 'visible'`. `album_files` cascades on album delete; deleting a file removes its `album_files` rows.

---

## 2. Jobs: `probe`, `derive`, `album_collage`

- **Queue:** all three run on the **`media`** queue, so slow derives never delay `finalize_upload`. The `worker` service in `docker-compose.yml` runs with `WORKER_QUEUES=default,media`; a dedicated media worker can be split out later.
- **When:** `finalize_upload` and the single-request upload path queue `probe` for a **new** hash. A de-duplicated upload of a hash that's already processed queues nothing. `probe` queues `derive` when it finishes.
- **Per content:** both jobs take `{ "hash_id": "<id>" }` and are keyed by hash, never by file.
- **Input:** the blob is streamed from storage to a temp file; nothing reads it over the network.
- **Sandbox (every subprocess):**
  - `ffmpeg`/`ffprobe` always get `-protocol_whitelist file,pipe` and `-nostdin`;
  - `resource.setrlimit` in `preexec_fn`: address space 1.5 GiB, CPU 60 s (probe 15 s), no core files;
  - a wall-clock `timeout` (probe 20 s, derive 90 s);
  - Pillow keeps its decompression-bomb limit on. No ImageMagick.
- **Failure:** a job that errors or times out sets `processing_state = 'failed'` and records nothing partial. The file keeps working without previews. Retries follow the jobs queue's normal backoff (max 3 attempts), after which it's `failed`.
- **Tools** (in the API image's `worker` target): `ffmpeg` (includes `ffprobe`), `poppler-utils` (`pdftoppm`, `pdfinfo`), Pillow, `pillow-heif`.

### `media` (the `probe` output, stored in `file_hashes.media`)

Every key is optional. Units: px, **milliseconds**, bytes.

```json
{
  "width": 1920, "height": 1080,
  "duration": 31250, "framecount": 48, "fps": 29.97, "loop": 0,
  "playable": true, "has_audio": true, "has_alpha": false,
  "codecs": ["h264", "aac"], "container": "mp4",
  "bitrate": 128000, "sample_rate": 44100, "channels": 2,
  "tags": { "title": "…", "artist": "…", "album": "…", "track": 3 },
  "pages": 12, "page_width": 612, "page_height": 792,
  "lines": 240, "language": "python", "snippet": "first ~12 lines, ≤ 1024 bytes, UTF-8"
}
```

- `width`/`height` are **after** EXIF orientation (images) and the rotation tag (video).
- **`playable`** (video and audio): `true` when the container and codecs play in current Chrome, Firefox and Safari. Video: `mp4`/`mov`/`webm` with `h264`, `vp8`, `vp9` or `av1` video, and `aac`, `mp3`, `opus`, `vorbis` or `flac` audio (or none). Audio: `mp3`, `aac`/`m4a`, `ogg`/`opus`, `wav` (PCM), `flac`. Everything else is `false` (for example HEVC, mkv, wma, ape).
- Text (`kind: text`): `lines`, `language` (from the extension: a fixed map, `null` when unknown) and `snippet`. Tag strings are trimmed and cut to 200 characters.

### What `derive` creates

| Kind | Assets |
|---|---|
| Image (browser-displayable) | `thumb` (fits 320×320) and `thumb-2x` (fits 640×640). Skipped when the original already fits 320×320. |
| Image (not browser-displayable: HEIC/HEIF, TIFF, PSD, …) | the same thumbs, plus `display` (fits 4096×4096) |
| Animated (gif, apng, animated webp) | thumbs from the first frame, plus `hover.mp4` |
| Video | `poster.webp` (fits 1280×1280, ffmpeg `thumbnail` filter over the first 10% capped at 30 s), thumbs, `hover.mp4` |
| Audio | `cover.webp` (embedded art, fits 1200×1200) **or**, with no art, `waveform.webp` (1600×240, transparent, brand green `#3DEB7E`). Always `peaks.json`. |
| PDF | thumbs of page 1 |
| Text, other | none |

- **`hover.mp4`:** at most 3 s, muted, fits 480×480, H.264 `yuv420p`, `-movflags +faststart`, CRF ~30.
- **`peaks.json`:** `{"version":1,"length":1000,"peaks":[…]}`, 1,000 values in `[0,1]`, rounded to 3 decimals.
- When `derive` finishes, `processing_state = 'done'` and `derived_at = now()`.

### `album_collage`

`{ "album_id": "<id>" }`. Queued (deduplicated, `run_after = now + 5 s`) after any change to an album's items or cover. It makes a **1200×630 webp**: a 2×2 grid of the first four items that have a `thumb`, `poster` or `cover` (one, two or three items fill the space instead of leaving gaps). It stores `derived/albums/<album_id>/collage-<version>.webp` and sets `collage_key` and `collage_version`. No visual items gives no collage (`collage_key = NULL`).

---

## 3. CDN URLs and signed URLs (`cdn.files.gg`)

### Every URL the CDN serves

```
https://cdn.files.gg/files/<vanity>.<ext>                        the file itself
https://cdn.files.gg/previews/<kind>/<vanity>.<kind ext>?v=<ver>  a generated preview
https://cdn.files.gg/albums/collage/<album vanity>.webp?v=<ver>   an album's 2×2 collage
https://cdn.files.gg/albums/download/<album vanity>.zip           an album's "Download all"
```

Anything else on the CDN is `404`. There's no legacy storage route and no GCS fallback (§0).

**Preview kinds** (a fixed set, each with one extension):

| Kind | Ext | What it is |
|---|---|---|
| `thumb` | `webp` | Tile image, fits 320×320 |
| `thumb-2x` | `webp` | Tile image, fits 640×640 |
| `display` | `webp` | Full-size stand-in for images browsers can't show (HEIC, TIFF, PSD), fits 4096×4096 |
| `poster` | `webp` | Video still, fits 1280×1280 |
| `cover` | `webp` | Embedded album art, fits 1200×1200 |
| `waveform` | `webp` | Audio waveform strip, 1600×240 |
| `peaks` | `json` | Waveform seek-bar data |
| `hover` | `mp4` | ≤ 3 s muted tile clip |

- **Parsing:** the kind is the **first** segment after `/previews/` and must be in the set. Everything after it, minus the kind's extension, is the vanity, so multi-segment vanities work (`/previews/thumb/abcd/xyz.webp` is vanity `abcd/xyz`), and a vanity that happens to be `thumb` can't be misread. A wrong extension for the kind is `404`. Albums work the same way: `collage` or `download` comes first, then the album vanity.
- **Lookup:** previews use the file's vanity lookup (§5), which lists the hash's previews. One that isn't listed (not made yet, failed, or not applicable) is `404`.
- **`?v=`** is the preview's version (`derived_at`, or `collage_version`). It changes only when a preview is regenerated, so caches can keep public previews forever. It isn't checked and isn't signed.
- **Headers:** the Milestone 1 CDN security headers, `Content-Type` from the stored row, `Content-Disposition: inline` (`attachment` for the ZIP). `Range` passes through.
- **Cache:** public (`link`) files and albums get `public, max-age=31536000, immutable` on previews and collages. Anything served through a signed URL gets `private, no-store`.

### Signed URLs (replace `?t=` everywhere)

Password and private files and albums are served **only** through signed URLs. The CDN no longer accepts `?t=`.

```
https://cdn.files.gg/files/abc123.png?expires=1795603600&sig=<signature>
https://cdn.files.gg/previews/thumb/abc123.webp?v=5&expires=1795603600&sig=<signature>
https://cdn.files.gg/files/abc123.png?album=Ab3dE6gH&expires=1795603600&sig=<signature>
```

```
signature = base64url_nopad( HMAC-SHA256( CDN_SIGNING_SECRET,
              "filesgg-cdn-1" + "\n" + <path> + "\n" + <expires> + "\n" + <grant> ) )

grant     = "file:"  + <file id>  + ":" + <file access_version>       (signed for the file)
          | "album:" + <album id> + ":" + <album access_version>      (signed through an album)
```

- **`path`** is the URL path exactly as it appears in the signed URL (percent-encoded, as `new URL(url).pathname` returns it), without the host or query.
- **Signed for one path:** a signed URL is valid for that one path only, so it can't be edited into a URL for another file, preview or album. `?download=true` and `?v=` aren't part of the signature, so Download works with the same URL.
- **Through an album:** URLs for items of a protected album carry `album=<album vanity>` and use the album grant. The Worker accepts it only when that album is in the file's `albums` list (§5, shown items only) with the matching `access_version`. The album's own collage and ZIP URLs use the album grant without `album=`.
- **Valid when:**
  1. the signature matches the grant computed from the **current** lookup;
  2. `expires > now`;
  3. `expires <= now + 31 days`, as a sanity cap.
  
  Changing a password or access bumps `access_version`, which breaks every URL signed before it, as tokens did. Invalid or expired gives `401` for password targets and `404` for private ones, with `private, no-store`.
- **Expiry:** a signed URL expires when the grant behind it does. An unlock lasts `min(u + unlock_ttl, password_expires_at)`. An owner payload's URLs (§6) last 1 h.
- **Who signs:** only the API. The Worker verifies and never signs. Public (`link`) URLs aren't signed. If one arrives signed anyway (a link item inside a protected album), the Worker ignores the signature and serves it as public, with public caching.
- **Secret:** `CDN_SIGNING_SECRET`, shared by the API and the Worker. `CDN_TOKEN_SECRET` is gone; the API's own unlock tokens (below) are signed with `SECRET_KEY`.

**Test vectors** (secret `test-cdn-signing-secret`). Both implementations must reproduce these exactly:

| path | expires | grant | sig |
|---|---|---|---|
| `/files/abc123.png` | 1795603600 | `file:1234567890123456789:0` | `2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8` |
| `/previews/thumb/abc123.webp` | 1795603600 | `file:1234567890123456789:0` | `fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0` |
| `/files/abcd/xyz.png` | 1795603600 | `file:1234567890123456790:2` | `oBzsm8vQj1Gu63_mqxqJxnryvfOrRIn_lFlRFzE7TJA` |
| `/files/abc123.png` | 1795603600 | `album:987654321098765432:3` | `qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68` |
| `/albums/download/Ab3dE6gH.zip` | 1796204800 | `album:987654321098765432:3` | `wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA` |
| `/files/abc123.png` (valid only at version 1, so it must be **rejected** while the file is at version 0) | 1795603600 | `file:1234567890123456789:1` | `Fx-ceAVJ1NUckKl8KkrfXvv9EjlAht92rlHCfcN4RUs` |

### The API's unlock token (browser ↔ API only)

The unlock flow from milestone-2 §5 stays, but its token never appears in a CDN URL. It's the visitor's proof for the API: `X-Filesgg-Access` on `/view`, and the body of `/unlock/refresh`. It's signed with `SECRET_KEY` instead of the CDN secret, with the same claims (`k t s v u e`).
- `POST …/unlock`, `GET …/view` and `POST …/unlock/refresh` all return the **payload with signed URLs** (`file` or `album`), plus `token` and `expires_at`. Refresh therefore returns fresh URLs.
- `#pw=` and `#t=` page fragments are unchanged. `#t=` carries an owner pass, an unlock token with `s: "owner"`.

### "Download all" (`/albums/download/<vanity>.zip`)

- Streamed by the Worker, never built server-side: ZIP **store** mode (no compression), general-purpose bit 3 (data descriptors) and a CRC-32 computed while streaming. UTF-8 names (bit 11).
- Items in album order; only the items the album page shows. Duplicate names become `name (2).ext`. Names go through the Milestone 1 filename cleaning.
- **Cap:** if the shown items total over **2 GiB**, respond `413 {"code":"ZIP_TOO_LARGE","limit":2147483648}`. The album page offers per-item downloads instead. Under the cap no ZIP64 is needed.
- `Content-Disposition: attachment; filename="<album title or vanity>.zip"`, `Cache-Control: private, no-store`.
- A protected album needs a signed URL (album grant).

---

## 4. Payload additions

Every place that returns the **file payload** (`/files/<vanity>`, upload responses, unlock, `/view`, refresh, the internal lookup's `file`, album items, the owner list) has these fields. There's one file shape now; the old `to_dict()` shape is gone (§0).

| Field | Type | Notes |
|---|---|---|
| `media` | object | §2, **minus `snippet`** (the snippet appears only in the owner list, §6). |
| `width`, `height`, `duration`, `framecount` | number | Copied from `media` to the top level. |
| `processing` | boolean | `true` while `processing_state` is `pending` or `probed`. |
| `assets` | object | `{ "<kind>": { "url", "width"?, "height"? } }` for each ready preview (§3 kinds). |
| `thumbnail` | `{ url, type, width?, height? }` | The best one for the kind: video `poster`; audio `cover`, then `waveform`; everything else `thumb`. Omitted when none. |
| `hover_url` | string | `assets.hover.url`, when present. |

- **URLs in a payload are ready to use.** For `link` files they're plain. For protected files, every URL (`cdn_url`, each `assets` URL, `thumbnail`, `hover_url`) is **signed by the API for whoever is allowed to see it**: an unlock, an owner, or an album grant. Clients never build or modify CDN URLs; they only add `?download=true`.
- **No URLs for protected files without a grant:** the public lookups (`/files/<vanity>` for a password file, the Worker's internal lookup) return the locked payload, or unsigned URLs that the CDN refuses.
- **`kind`:** a non-browser image (HEIC, TIFF, PSD, …) with a ready `display` preview is `kind: "image"`, and the viewer shows `assets.display.url` instead of `cdn_url`. Without one it stays `file`.
- **`nsfw`:** always `false` in Milestone 3.

**Album payload** (`GET /albums/<vanity>`, the internal album lookup, unlock, `/view`, refresh):
- `id`, `vanity`, `url`, `title`, `description`, `layout`, `nsfw`, `visibility`, `expires_at`, `count`, `total_size`, `next_cursor`;
- `cover`: `{ url, type, width?, height? }`, the `cover_file_id` item's best image, or else automatic (the first visual item's `thumbnail`; for a tracklist, the first `cover`);
- `collage`: `{ url, width: 1200, height: 630 }` when one exists;
- `download_url`: `https://cdn.files.gg/albums/download/<vanity>.zip`;
- `items[]`: file payloads plus `position` and `caption`.

For a protected album, every URL in it (items, `cover`, `collage`, `download_url`) is signed with the **album grant**, and item URLs carry `album=<vanity>`.

**Which items an album shows:** items that aren't deleted, expired or hidden by moderation, and:
- in a **`link`** album, only items whose own visibility is `link`. A password or private file added to a public album stays hidden there (the owner's editor shows it with a note);
- in a **`password`** or **`private`** album, every item, served through the album grant.

An album with no items to show is `missing`.

**Field names are snake_case everywhere** (`cdn_url`, `expires_at`, `uploaded_at`, `hover_url`, `download_url`). Times are epoch **seconds**. The camelCase duplicates (`cdnUrl`, `expiresAt`, `uploadedAt`, `downloadUrl`) are removed (§0).

---

## 5. Worker ↔ API: internal lookups

```
GET /internal/files/<vanity>
GET /internal/albums/<vanity>
X-Filesgg-Origin-Secret: <ORIGIN_SHARED_SECRET>
```

The lookups by id are removed. Every CDN path names a vanity.

**`/internal/files/<vanity>`** returns:
- `file`: the payload, unsigned;
- `access`;
- `owner_user_id`;
- `albums`: `[{ id, vanity, access_version }]`, only albums where the file is **shown**;
- `storage`: `{ key, size }`, B2 only;
- `previews`: `{ "<kind>": { "key", "content_type", "size" } }`;
- `previews_version`.

**`/internal/albums/<vanity>`** returns:
- `album`: unsigned;
- `access`;
- `items_access`;
- `items_storage`: `{ "<file id>": { key, size, filename } }`, every shown item;
- `collage`: `{ key, version }` or `null`.

For a password album the Worker renders the `locked` shell; for a private one, `missing`. The 30 s lookup cache stays for now; its revocation delay is still an open item in PLAN.md.

---

## 6. Owner API (signed in; anonymous callers with `X-Fingerprint` get their own anonymous files and albums)

### Files

| Request | Response |
|---|---|
| `GET /users/@me/files?query&sort_by&type&visibility&temporary&offset&limit` | `{ "count", "items": [owner file], "size", "total": { "count", "size" } }` |
| `PATCH /users/@me/files/<id>` | Milestone 2 fields, plus `filename` (renames the **name** only; the extension stays). Returns the owner file. |
| `DELETE /users/@me/files/<id>` | `204` |
| `POST /users/@me/files/delete { file_ids }` | `200 { "deleted": [ids] }`. At most 100 ids; ids you don't own are skipped. |
| `POST /users/@me/files/expiry { file_ids, expires_in }` | `200 { "items": [owner file] }`. `expires_in: null` means **Keep forever** (signed in only). |
| `POST /users/@me/files/access { file_ids, visibility, password?, generate_password?, unlock_ttl?, password_expires_in?, show_name_when_locked? }` | `200 { "items": [owner file], "password"? }`. One generated password is shared by the batch and returned once. |

- **Query parameters:**
  - `query` matches the filename (case-insensitive substring);
  - `sort_by` is `-created` (default), `created`, `-size`, `size`, `name` or `-name`;
  - `type` is `image`, `video`, `audio`, `text`, `pdf` or `other` (by `kind`);
  - `visibility` is `link`, `password` or `private`;
  - `temporary=true` returns only files with an `expires_at`;
  - `limit` is 1–100 (default 25).
- `count` and `size` describe the filtered result; `total` is all your files.
- **Owner file** = the public payload (§4) plus Milestone 2's owner fields (`access_version`, `unlock_ttl`, `password_expires_at`, `show_name_when_locked`), plus `media.snippet` and `albums: [{ id, vanity, title }]`. Every URL in an owner payload is signed for 1 h with the file grant (albums: the album grant), so the dashboard can show your own protected files directly.
- **Delete** is a soft delete (`deleted_at`). It removes the file from every album and queues `delete_blob` when it was the hash's last live reference.

### Albums

| Request | Response |
|---|---|
| `POST /users/@me/albums { title?, description?, layout?, file_ids, cover_file_id? }` | `201` owner album |
| `GET /users/@me/albums?query&sort_by&offset&limit` | `{ "count", "items": [owner album summary] }` |
| `GET /users/@me/albums/<id>` | owner album, with **every** item (≤ 500) including hidden ones |
| `PATCH /users/@me/albums/<id> { title?, description?, layout?, cover_file_id?, ...access fields }` | owner album. Access fields work exactly like a file's `PATCH` (including `generate_password` → `password` once). |
| `DELETE /users/@me/albums/<id>?delete_files=true` | `204` |
| `PUT /users/@me/albums/<id>/files { file_ids }` | owner album. Sets the exact list and order (adds, removes and reorders in one call). |
| `POST /users/@me/albums/<id>/files { file_ids, position? }` | owner album. Appends, or inserts at `position`. Files already in the album are skipped. |
| `DELETE /users/@me/albums/<id>/files/<file_id>` | owner album |
| `PATCH /users/@me/albums/<id>/files/<file_id> { caption }` | owner album |
| `GET /albums/<vanity>?cursor` | public album payload (§4), 100 items a page. A password album returns the locked payload `{ vanity, protected: "password", title? }`; private is `404 UNKNOWN_ALBUM`. |
| `POST /albums/<vanity>/unlock`, `/unlock/refresh`, `GET /albums/<vanity>/view` | now real, with the same rules as files (milestone-2 §5) |

- **Owner album** = the album payload, plus `access_version`, `unlock_ttl`, `password_expires_at`, `show_name_when_locked`, `cover_file_id`, `created_at`/`updated_at` (epoch s), and `items[]` of owner files, each with `position`, `caption` and `shown: boolean` (false when §4 hides it).
- **Owner album summary** = `id`, `vanity`, `url`, `title`, `layout`, `visibility`, `count`, `cover`, `collage`, `created_at`, `updated_at`.
- **Rules:**
  - Only your own, live files can be added; anything else gives `400 INVALID_ALBUM_FILES { file_ids }`.
  - Limits: 500 files per album (`ALBUM_FULL`, `limit`) and 1,000 albums per user (`ALBUM_LIMIT_REACHED`, `limit`).
  - **Anonymous albums:** only `POST /users/@me/albums`, with ≤ 50 files, all uploaded by this fingerprint within the last hour; otherwise `403 ANONYMOUS_ALBUM_NOT_ALLOWED`. The album's `expires_at` is the latest of its files' expiries. Anonymous callers can't edit an album afterwards.
  - `title` ≤ 100 characters, `description` ≤ 2,000, `caption` ≤ 500 (plain text; control characters other than `\n` are stripped).
- **Upload integration:** `POST /files` and `POST /uploads` accept `album=<album vanity>` (signed in, your own album). The file is appended once it's stored. An unknown or foreign album gives `400 INVALID_ALBUM` before anything is uploaded.
- **Reaper:** albums with no live items are soft-deleted after 7 days. Expired anonymous albums are deleted with their last file.

### Limits

`GET /users/@me/limits` adds `album_max_files` (500, or 50 anonymous) and `albums_max` (1000, or `null` anonymous).

### New error codes

| Code | HTTP | Details |
|---|---|---|
| `UNKNOWN_ALBUM` | 404 | |
| `INVALID_ALBUM` | 400 | |
| `INVALID_ALBUM_FILES` | 400 | `file_ids` |
| `ALBUM_FULL` | 400 | `limit` |
| `ALBUM_LIMIT_REACHED` | 400 | `limit` |
| `ANONYMOUS_ALBUM_NOT_ALLOWED` | 403 | |
| `ZIP_TOO_LARGE` | 413 | `limit` (Worker) |
| `FILE_TYPE_NOT_ALLOWED` | 400 | Executables and malware-style files, refused by filename extension, declared mimetype **or content** (PE, ELF, Mach-O, Java class and `.lnk` headers), on `POST /files`, `POST /uploads`, chunk 0 and finalize (`api/utils/filetypes.py`). |

---

## 7. Viewer behaviour (web)

- **Video:**
  - `poster` from `thumbnail` when its type is `poster`;
  - `media.playable === false` shows "This video can't play in the browser" with Download (no player);
  - player controls: play/pause, seek, time, volume and mute, speed 0.25×–2×, a keep-pitch toggle (`preservesPitch`), fullscreen;
  - keyboard while the player has focus or the page has no other focus: space/k play, ←/→ ±5 s, m mute, f fullscreen;
  - volume and mute persist in `localStorage` `filesgg.volume` / `filesgg.muted`.
- **Audio:**
  - `cover` shows as large art; otherwise `waveform` shows as a strip;
  - `peaks.json` (fetched from `assets.peaks.url`) draws a waveform seek bar;
  - the tag line is "Artist: Title" when both tags exist;
  - same controls and persistence as video, minus fullscreen; not playable shows Download.
- **Images:** `assets.display.url` for non-browser types (§4).
- **Text and code:** a **Shiki** read-only viewer (lazy chunk, JavaScript regex engine, so no wasm):
  - the text is fetched from `cdn_url` (already signed when protected);
  - a preview limit of **1 MiB / 20,000 lines**, over which it shows "Too large to preview" with Download and Raw;
  - line numbers; `#L5` and `#L5-L9` highlight and scroll, and clicking a line number (shift-click for a range) sets them;
  - the language is `media.language`, else guessed from the extension, else plain text;
  - wrap toggle and Copy.
- **While `processing`:** the type icons and `aspect-ratio` from `width`/`height` are used, as in Milestone 1. Nothing polls.
- **PDF:** the footer uses `media.pages` (already built).

---

## 8. Dashboard (web)

- **Files** (`/app/files`):
  - table view by default with a grid toggle; 25 per page; page, sort, query and filters in the URL;
  - tiles and thumbnails follow PLAN.md Phase 3 "Files": image `thumb` (`thumb-2x` in `srcset`), video poster with a ▶ badge that plays `hover_url` muted on hover, audio cover or a music icon, PDF first page, text `media.snippet`;
  - an access column with filter;
  - multi-select with shift-click ranges, select all on the page, and a "N selected · X MB" bar with **Delete** (confirm), **Set expiry…**, **Keep forever**, **Change access…**, **Add to album…**;
  - row actions: Copy link, Open, Rename, Set expiry, Change access, Owner pass (private files: "Open as owner" mints a pass and opens it), Delete;
  - clicking a row opens a side drawer that reuses the viewer's renderers.
- **Albums** (`/app/albums`): a card grid (collage or cover, title, count, updated), and an editor at `/app/albums/<id>` with:
  - title, description, layout and cover pickers;
  - a drag-to-reorder grid (dnd-kit, keyboard reordering included), saved with `PUT …/files`;
  - inline captions; "Add files" (a picker over your library with search and type filters); remove item;
  - access settings (the same component as files);
  - delete, with "Also delete the files".
- **Upload:** with more than one file queued, a **"Put these in an album"** toggle (on by default). When the batch finishes, the page calls `POST /users/@me/albums` with the successful files and shows the album link above the per-file links.
- **Overview** (`/app`): storage meter (amber at 80%, red at 95%), counts by type, files expiring in the next 7 days, and recent uploads.
- `mock-api.ts` gains every endpoint above, so `npm run dev` works without the API.
