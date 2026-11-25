# Milestone 5 contract (conversion)

> Later renamed: the anonymous uploader's *fingerprint* is now a *guest* (`guest_id`, `Authorization: Guest`); see §20.

This is the shared contract between `api/`, `cf-worker/` and `web/` for Milestone 5. It covers:
- converting a file to another format, with the result as a normal files.gg file (or album) with its own link;
- the formats, their options, and `GET /conversions/formats`, which the UI builds its forms from;
- the `converter` services: RQ worker pools on Redis by tier, as notsobot.api runs its jobs, and the network-less `office` service that runs LibreOffice;
- polled progress (queue position, stage, time limit), cancelling, history and batch conversion;
- the conversion cache, provenance and the moderation cascade;
- limits for signed-in and anonymous callers;
- **document previews:** Word, Excel, PowerPoint and OpenDocument files shown in the viewer as a PDF;
- the Convert page (`files.gg/app/convert`, and public at `files.gg/convert`) and the entry points in the viewer, the Files table and albums;
- **rate limits on Redis,** notsobot.api's limiter, replacing every Postgres rate limit (§18).
- **the changelog, Terms of Service and Privacy Policy pages** (§19);
- **guests:** the anonymous uploader's "fingerprint" is renamed, and sent as `Authorization: Guest` (§20).
- **upload defaults** (Settings → Uploads) for key uploads and conversions, and the Convert page's output options (§21).

The design is in [`../PLAN.md`](../PLAN.md): "File conversion", §4 item 11 (the anonymous limits table) and Phase 3 item 9 (the Convert page). This file pins the **exact formats**. When this file and the plan disagree, this file wins for Milestone 5; fix the plan afterwards. Everything in [`milestone-6.md`](milestone-6.md), [`milestone-4.md`](milestone-4.md), [`milestone-3.md`](milestone-3.md) and what they keep of [`milestone-2.md`](milestone-2.md) still holds unless it's changed here, in particular: the vanity is always the last path segment (milestone-6 §20), sessions only on `files.gg/api` (milestone-6 §3), every new blob is scanned before it's served (milestone-4 §2), and no backward compatibility.

**Not in Milestone 5:**
- the client-side fast path (png ↔ jpg ↔ webp in the browser), kept out of v1 as the plan says;
- the "later candidates": CSV ↔ JSON ↔ XLSX, Markdown → PDF, archive repacking, OCR;
- conversions through upload keys (keys stay upload-only, milestone-6 §7);
- paid plans that raise conversion limits (premium raises them, §7.1, but nothing is sold).

---

## Decisions made in this contract

Those marked **(owner, 2026-11-25)** were decided by the project owner; the rest are engineering choices. Review them before building.

1. **(owner, 2026-11-25) Office documents preview as a PDF rendered by LibreOffice,** in the pdf.js viewer that already exists (§9). Not docx-preview: one renderer covers Word, Excel, PowerPoint and OpenDocument, and no untrusted document is parsed by code on the page.
2. **(owner, 2026-11-25) Document previews only for files a signed-in user uploaded.** Anonymous Office uploads show the download card with "Sign in to preview and convert". Previews are stored per content hash, so a preview made for a signed-in copy is also shown on an anonymous copy of the same bytes: no new LibreOffice input comes from it (§9.1).
3. **(owner, 2026-11-25) All of conversion in one milestone:** every row of the format table, batch, progress, history, the public page and every entry point.
4. **(owner, 2026-11-25) PDF → images makes an album** (pages in order) for signed-in callers, and a ZIP for anonymous ones (§4.6).
5. **LibreOffice runs in its own container with no network at all** (`network_mode: none`, read-only root, tmpfs), fed through a shared tmpfs spool volume (§3.2). A document can make LibreOffice fetch URLs (a spreadsheet's `WEBSERVICE()`, linked images, OLE links), and the existing sandbox limits CPU and memory but not the network. Nothing else runs LibreOffice.
6. **The `converter` service is the worker image plus `resvg`, `pillow-heif` and `img2pdf`,** claiming only the `convert` queue (§3.1). The media worker and the scanner don't get them.
7. **Sources are named by vanity, not id,** so anyone allowed to see a file can convert it. A password-protected source needs its unlock token (`X-Filesgg-Access`), exactly as viewing it does (§5.1).
8. **Only the owner can convert a view-limited file** (`VIEW_LIMITED_SOURCE` otherwise): a conversion would otherwise be an unlimited copy (§5.1).
9. **Outputs of a protected source are protected too:** `private` for signed-in callers, and `password` with a generated passphrase for anonymous ones, unless the caller picks otherwise within their allowed levels (§5.3).
10. **(owner, 2026-11-25) Conversions and document previews run on RQ + Redis, as notsobot.api's jobs do;** the upload pipeline (finalize, scan, probe, derive, collage, the scheduled tasks) stays on the Postgres queue, where enqueuing in the same transaction as the data is part of the safety gate. Copied from notsobot (`api/worker.py`, `utilities/tools/job*.py`, `responses/tools.py`, the `api-rq-worker-*` services), §3.3: `rq worker-pool` services by tier with their own `cpus` and `cpu_shares`; rq's forked **work horse** per job, killed at its timeout; a `NotSoWorker`-style worker class (structured errors, failure reasons, metrics from the parent); queue position (`LPOS`), stage and time limit on every poll; cancel through rq's stop command; a per-process thread budget. The Postgres `conversions` row stays the record of every conversion; Redis only holds the queue.
11. **(owner, 2026-11-25) Progress is polled, notsobot style, not streamed:** `POST /conversions` waits up to 2 s, so quick conversions finish in one request, then the page polls `GET /conversions/<id>` (§8). No SSE, no `LISTEN/NOTIFY`.
12. **Processing time is measured, not estimated:** the worker class reaps each work horse with `os.wait4`, whose rusage includes every tool the horse ran, so killed horses are charged too; the horse's CPU limit is the smaller of the tier's limit and what's left of the caller's daily budget (§7.3).
13. **The recipe hash includes a converter version** (`CONVERTER_VERSION`, an integer in code), so changing how a target is produced invalidates the cache without a migration (§6).
14. **`target` is optional,** as notsobot's `to` is: without it, each kind converts to its default (§1.2), so "make this play anywhere" is one call.
15. **Audio isn't re-encoded when it doesn't have to be** (notsobot's `copy_audio`): when the source's audio codec fits the target container and no option touches the audio, it's copied (`-c:a copy`), so m4a → mp4 or webm (Opus) → ogg loses nothing (§4.2).
16. **Conversions aren't retried** (notsobot's jobs aren't either): a work horse that's killed or crashes fails the conversion with a failure reason, and the result card offers **Try again**.
17. **Enqueue after commit, with a sweeper:** the conversion row is committed first, then its RQ job is enqueued with the job id `conversion:<id>`. A scheduled task re-enqueues a `queued` conversion whose job doesn't exist in Redis (an enqueue that failed, Redis restarted between fsyncs), and cancels one queued past its tier's wait with `CONVERTER_BUSY` (§3.3).
18. **(owner, 2026-11-25) Rate limits move to Redis with notsobot.api's limiter** (§18): moving windows, a global limit and per-route limits. Two files.gg changes: brute-force limits (login, re-auth, register, forgot, unlock, reports) fail **closed** when Redis is down, and the guest id is never a key.

---

## 0. Ground rules

- **Outputs are normal files.** They go through the same storage, `FileHash` de-duplication, `scan` → `probe` → `derive` pipeline and publication gate as uploads. A conversion can succeed while its output is still `pending` scan; the result card says "Scanning…" exactly as the upload page does.
- **Untrusted input everywhere.** Every source is attacker-controlled, including PDFs and documents that passed the scan. Every tool runs through `media/sandbox.py` (CPU, memory, wall clock, scrubbed environment, `-protocol_whitelist file,pipe` and the demuxer whitelist for ffmpeg), and LibreOffice only in the `office` container (§3.2).
- **Errors never echo tool output.** `CONVERSION_FAILED` carries a short reason from a fixed list (§12); stderr goes to the logs for staff only.
- **No route has anything after a vanity** (milestone-6 §20). Conversions are addressed by id (`/conversions/<id>`), which is a snowflake, never a vanity.

---

## 1. Formats

### 1.1 Source kinds

A source's **kind** comes from its mimetype and its probe (`file_hashes.media`, milestone-3 §2):

| Kind | Mimetypes (and probe) |
|---|---|
| `image` | image/png, jpeg, webp, avif, heic, heif, tiff, bmp, x-icon, vnd.adobe.photoshop (psd), svg+xml; image/gif and image/webp **with one frame** |
| `animated` | image/gif, image/apng, image/webp **with more than one frame** (probe `frames > 1`) |
| `video` | video/* with a video stream in the probe |
| `audio` | audio/*, and video/* with only an audio stream |
| `document` | docx, doc, xlsx, xls, pptx, ppt, odt, ods, odp, rtf (the mimetypes in `0002_mimetypes.sql`; macro-enabled types are blocked at upload already) |
| `pdf` | application/pdf |

A file whose probe failed (`processing_state = 'failed'`) or that isn't one of these kinds has no targets: `UNSUPPORTED_CONVERSION`.

### 1.2 Targets and options

Option names, types and ranges are exact. `GET /conversions/formats` (§10.1) returns this table as data.

| Source kind | Target | Options (name: type, range, default) |
|---|---|---|
| `image` | `png`, `jpg`, `webp`, `avif`, `gif`, `ico` | `quality`: int 1–100, 85 (jpg, webp, avif only) · `max_width`, `max_height`: int 1–8192, none (aspect kept, never upscaled) · `background`: `#rrggbb`, `#ffffff` (jpg only, and gif/ico for semi-transparency) · `strip_metadata`: bool, **true** (removes EXIF including GPS) |
| `animated` | `mp4`, `webm`, `webp` (animated), `gif` | `fps`: int 1–60, source (capped 60) · `width`: int 16–1920, source (capped 1920) · `trim_start`, `trim_end`: number seconds ≥ 0 · `loop`: bool, true (webp, gif) |
| `video` | `mp4` (H.264 + AAC), `webm` (VP9 + Opus), `gif`, `mp3`, `m4a`, `ogg` (Opus), `wav` | `max_height`: enum 1080, 720, 480, none (never upscaled) · `trim_start`, `trim_end` · `mute`: bool, false (mp4, webm) · `target_size`: preset `discord` (10 MB) or number MB 1–500, none (mp4, webm; two-pass bitrate) · gif: `fps` 1–30 (12), `width` 16–960 (480) · audio targets: `bitrate` as for audio |
| `audio` | `mp3`, `m4a`, `ogg` (Opus), `flac`, `wav` | `bitrate`: enum 64, 96, 128, 160, 192, 256, 320 kbps, 192 (lossy only) · `trim_start`, `trim_end` · `normalize`: bool, false (ffmpeg `loudnorm`, two-pass) · `keep_tags`: bool, **true** (tags and cover art) |
| `document` | `pdf` | none |
| `pdf` | `png`, `jpg` (one image per page) | `dpi`: int 72–300, 150 · `pages`: string of ranges like `1-3,7`, all · `quality`: int 1–100, 85 (jpg) |
| several `image` (or an album) | `pdf` | `page_size`: enum `fit` (each page the image's size), `a4`, `letter`; `fit` · `margin_mm`: int 0–50, 0 (ignored for `fit`) |

**Default targets** (when `target` is left out, decision 14): `image` → `png`, `animated` → `mp4`, `video` → `mp4`, `audio` → `mp3`, `document` → `pdf`, `pdf` → `png`, several images → `pdf`.

Rules:
- `trim_end` must be greater than `trim_start` and is clamped to the duration. `trim_*` on a source without a duration is `INVALID_OPTION`.
- Converting to the source's own format is allowed (resize, strip metadata, re-encode).
- An unknown option, a value out of range or one that doesn't apply to the target: `400 INVALID_OPTION` with `{ option, reason }`. Options are never silently dropped.
- `target_size` picks the video bitrate as `(size × 8 × 0.97 − audio bitrate × duration) ÷ duration`; if that's under 100 kbps, `400 TARGET_SIZE_TOO_SMALL` with the smallest workable size in MB.
- SVG is rasterised with **resvg** (no scripts, no external references, `--resources-dir` an empty directory), at its own size capped by `max_width` / `max_height`, default 2048 on the longer side.
- PSD is flattened (the composite image). HEIC/HEIF through `pillow-heif`. GIF output of anything uses `palettegen` / `paletteuse` (`stats_mode=diff`, `dither=sierra2_4a`).

### 1.3 Output names

`<source name without extension>.<target extension>`, through the normal `resolve_name` (milestone-2), so the 128-character limit and the reserved checks apply. PDF pages: `<name>-p<page, zero-padded to the page count's width>.<ext>`. Images → PDF: the album's title, or the first image's name, `.pdf`.

---

## 2. Schema: `api/migrations/0007_conversions.sql`

One transaction, plus nothing `CONCURRENTLY` (the tables are new).

### 2.1 `conversions`

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | snowflake |
| `owner_user_id` | bigint NULL → users ON DELETE CASCADE | exactly one of the two owner columns (CHECK `num_nonnulls = 1`) |
| `owner_guest_id` | bigint NULL | |
| `owner_ip_hash` | bytea NULL | the abuse IP hash (milestone-4), anonymous only, for the per-IP limits; cleared with the other IP hashes |
| `batch_id` | bigint NULL | groups a batch (§10.6) |
| `source_file_id` | bigint NULL → files ON DELETE SET NULL | single-source conversions |
| `source_album_id` | bigint NULL → albums ON DELETE SET NULL | images → PDF from an album |
| `source_hash_id` | bigint NULL → file_hashes ON DELETE SET NULL | the bytes converted (for the cache and the cascade) |
| `source_kind` | text | §1.1 |
| `target` | text | §1.2 |
| `options` | jsonb NOT NULL | normalised (defaults filled in, sorted keys) |
| `recipe_hash` | bytea NOT NULL | §6 |
| `status` | text | `queued` / `running` / `succeeded` / `failed` / `cancelled` |
| `progress` | real 0–1 | |
| `output_file_id` | bigint NULL → files ON DELETE SET NULL | single-file outputs |
| `output_album_id` | bigint NULL → albums ON DELETE SET NULL | PDF → images (signed in) |
| `cached` | boolean NOT NULL DEFAULT false | served from the cache |
| `queue` | text NOT NULL | the RQ queue it went on (§3.1) |
| `job_id` | text NULL | its RQ job id, `conversion:<id>` (none for cache hits) |
| `stage` | text NULL | while running: `downloading` / `converting` / `storing` (§8) |
| `time_limit` | integer NOT NULL | seconds the work horse gets (§7.1) |
| `error` | jsonb NULL | `{ code, message, metadata }`, what the API returns (§12), saved by the work horse or its parent, never tool output |
| `failure_reason` | text NULL | staff and metrics only, notsobot's `get_job_failure_reason`: `killed_at_timeout`, `killed_SIGKILL`, `work_horse_lost`, `cancelled`, an exception's type (`OSError`), or an error code |
| `cpu_ms` | bigint NOT NULL DEFAULT 0 | §7.3 |
| `input_size`, `output_size` | bigint NULL | for "size before and after" |
| `created_at`, `started_at`, `finished_at` | timestamptz | |

Indexes: `(owner_user_id, id DESC)` and `(owner_guest_id, id DESC)` where not null; `(status)` partial on `queued`/`running`; `(source_hash_id)`; `(batch_id)` where not null.

`status` and `error` follow the work horse: `queued` → `running` → `succeeded` / `failed` / `cancelled`. `error.code` is one of §12; `error.metadata` carries what the code says (`{ seconds, ran_seconds, queued_seconds, max_seconds, tier }` for `CONVERSION_TIMEOUT`, like notsobot's `job_timeout_error`).

`conversion_sources (conversion_id, position, file_id → files ON DELETE SET NULL, hash_id)` holds the ordered sources of images → PDF. Single-source conversions don't use it.

### 2.2 `conversion_cache`

`(source_hash_id → file_hashes ON DELETE CASCADE, recipe_hash bytea)` primary key, `output_hash_id → file_hashes ON DELETE CASCADE`, `created_at`. Multi-output recipes (PDF → pages) and multi-source ones (images → PDF) are **not** cached in v1.

### 2.3 Provenance on `files`

`ALTER TABLE files ADD COLUMN derived_from_file_id bigint REFERENCES files (id) ON DELETE SET NULL, ADD COLUMN conversion_id bigint REFERENCES conversions (id) ON DELETE SET NULL`, with an index on `derived_from_file_id` where not null. For multi-source outputs, `derived_from_file_id` is the first source, and the cascade (§5.4) walks `conversion_sources` too.

### 2.4 No change to `jobs`

Conversions don't use the Postgres `jobs` table (decision 10). `jobs`, its claim order and `python -m worker` stay exactly as they are.

### 2.5 Assets and usage

- `file_hash_assets.kind` gains `'document'` (the preview PDF, §9).
- `conversion_usage (subject text, day date, cpu_ms bigint, count integer, PRIMARY KEY (subject, day))`, where `subject` is `u:<user id>`, `g:<guest id>` or `i:<hex abuse IP hash>`. Rows older than 2 days are deleted by the hourly cleanup task.
- `file_hashes.preview_state text NOT NULL DEFAULT 'none' CHECK (preview_state IN ('none', 'queued', 'done', 'failed', 'skipped'))` for document previews.
- `DROP TABLE safety_rate_limits, unlock_attempts` (§18.5).

---

## 3. Services

### 3.1 Redis and the `converter` services

- **Redis:** a `redis` service, the same as notsobot's `db-api-redis`: `redis:8.10.3-alpine` pinned by digest, `--requirepass ${REDIS_PASSWORD}`, `appendonly yes` and `appendfsync everysec` (a crash loses at most a second of queued jobs, and §3.3's sweeper re-enqueues them), RDB snapshots on, a named volume for `/data`. Not published; only the API and the `converter*` services reach it (`REDIS_URL`). Nothing in it needs a backup: every conversion is a Postgres row.
- **Python:** `rq==3.0.0`, `redis==8.1.0`, `hiredis==3.5.0` (notsobot's pins), hashed in `requirements.txt` (the API enqueues and reads queue positions) and the converter image.
- The worker image (`api/Dockerfile` target `worker`) gains a `converter` target: `worker` plus `resvg` (Debian), `pillow-heif` and `img2pdf` (pip, hashed in `requirements-converter.txt`).
- **Queues by tier,** as notsobot's `high` / `medium` / `low` / `editor` (`utilities/tools/job_limits.py`). `POST /conversions` picks the queue from the caller; nothing else does:

  | RQ queue | Who | notsobot's |
  |---|---|---|
  | `convert_premium` | premium users | `high` |
  | `convert_member` | signed-in users | `medium` / `low` |
  | `convert_anonymous` | anonymous visitors | (none: notsobot has no anonymous jobs) |
  | `convert_previews` | document previews (§9) | `editor`: background work that never holds up a person waiting |

- **Worker-pool services,** as notsobot's `api-rq-worker-premium` / `-base` / `-editor`. rq takes from the queues in the order listed, so each pool drains its first queue before the next:

  | Service | Command | `cpu_shares` |
  |---|---|---|
  | `converter-premium` | `rq worker-pool convert_premium convert_member -n ${CONVERTER_PREMIUM_PROCESSES:-2} --worker-class 'convert_worker.ConvertWorker'` | 768 |
  | `converter` | `rq worker-pool convert_member convert_anonymous -n ${CONVERTER_PROCESSES:-4} --worker-class 'convert_worker.ConvertWorker'` | 512 |
  | `converter-previews` | `rq worker-pool convert_previews -n ${CONVERTER_PREVIEW_PROCESSES:-1} --worker-class 'convert_worker.ConvertWorker'` | 256 |

  So premium never waits behind anyone else, signed-in users never wait behind anonymous visitors, and previews never hold up a conversion someone is watching. Idle premium workers help with the member queue, as notsobot's premium pool takes `medium` after `high`. `cpus` limits and `cpu_shares` only matter once the host's CPUs are all wanted, exactly as in notsobot's compose. `init: true` on each, as notsobot's.
- **A per-process thread budget,** notsobot's `VIPS_CONCURRENCY` / `cpu_budget()`: each service sets `CONVERT_THREADS` to its `cpus` limit ÷ its processes (at least 1). ffmpeg gets `-threads <CONVERT_THREADS>` (and `-filter_threads 1`), Pillow and libvips the same through `OMP_NUM_THREADS` and `VIPS_CONCURRENCY`, so N processes on a limited container don't each assume the whole host.
- Same sandbox rules as the media worker: non-root, scrubbed environment for children, `-protocol_whitelist file,pipe`, the demuxer whitelist. Per-job limits: the tier's `time_limit` (§7.1) as the job's `job_timeout`, `CONVERT_CPU` (§7.3), `CONVERT_ADDRESS_SPACE` 3 GiB (video encoders need more than 1.5 GiB), `MAX_OUTPUT_FILE` = the caller's max file size.
- RQ job functions: `jobs.convert.run(conversion_id)` (§4) and `jobs.convert.preview(hash_id)` (§9). On the Postgres queue's scheduler (it already runs every minute): `convert_sweep` (§3.3).

### 3.2 `office` (LibreOffice, no network)

- Its own image (`api/Dockerfile` target `office`): Debian trixie slim, `libreoffice-writer-nogui`, `libreoffice-calc-nogui`, `libreoffice-impress-nogui`, fonts (`fonts-dejavu`, `fonts-liberation2`, `fonts-crosextra-carlito`, `fonts-crosextra-caladea`, `fonts-noto-core`), and the system `python3` for a stdlib-only daemon, `api/office/daemon.py`. No pip packages, no app code beyond that file.
- Compose: `network_mode: none`, `read_only: true`, `tmpfs` for `/tmp` and the LibreOffice profile, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `pids_limit`, `mem_limit` 2 GiB, non-root uid shared with the converter.
- **The spool** is a named volume `office-spool` with `driver_opts: { type: tmpfs, device: tmpfs, o: size=2g,uid=…,mode=0770 }`, mounted in the `converter*` services and `office` only.
  - The converter writes `<spool>/new/<uuid>/input.<ext>` and `request.json` (`{ "filter": "pdf", "timeout": 120, "max_pages": 500 }`), then renames the directory into `<spool>/queue/<uuid>` (atomic).
  - The daemon polls `queue/` (every 200 ms; inotify isn't worth a dependency), moves a job to `work/`, runs `soffice --headless --norestore --nologo --nodefault --nolockcheck --nofirststartwizard -env:UserInstallation=file:///tmp/lo-<uuid> --convert-to pdf --outdir work/<uuid> input.<ext>` with a fresh profile per job, under `RLIMIT_CPU`, `RLIMIT_AS` and a wall-clock kill of the whole process group, then writes `output.pdf` and `result.json` (`{ "ok": true, "pages": n }` or `{ "ok": false, "reason": "timeout" | "failed" | "too_many_pages" }`) and renames to `done/<uuid>`.
  - The converter waits for `done/<uuid>` up to `timeout + 15 s`, reads the result, and always deletes its directories. The daemon deletes anything older than 10 minutes in any spool directory.
  - One job at a time per daemon process; `OFFICE_PROCESSES` (default 2) daemon processes.
- **LibreOffice settings,** in a `registrymodifications.xcu` copied into each fresh profile: macro security "very high" with no trusted locations, `DisableMacrosExecution`, never update links (`LinkUpdateMode` 0 in Writer and Calc), never load external images, Calc recalculation on load `never`, no auto-save or recovery. The missing network is the real guarantee; the settings stop the attempts early.
- `pages > max_pages` after export: `too_many_pages`, no output.

### 3.3 Work horses and the worker class (notsobot's `NotSoWorker`)

`api/convert_worker.py` defines `ConvertWorker(rq.Worker)` and `ConvertJob(rq.job.Job)`, modelled on notsobot's `worker.py`:

- **One forked work horse per job** (rq's own model): memory a job grew is returned when it ends, a crash or the OOM killer takes one job and not the worker, and nothing a job leaves behind reaches the next. rq's horse calls `os.setsid`, so killing it kills every tool it started.
- **Loading once:** the module imports the app's job code and opens nothing at import; each horse opens its own Postgres connection (psycopg, sync) the first time it needs one and closes it when the job ends, as notsobot's `close_job_database`.
- **`ConvertJob._execute`:** notsobot's `NotSoJob` fix, so a job that raises (its timeout included) exits straight away instead of waiting on executor threads.
- **Time limit:** `job_timeout` is the conversion's `time_limit`. rq raises `JobTimeoutException` in the horse at the limit and kills it 60 s later if it hasn't stopped. The horse's own tools stop a little earlier (the wall clock in `sandbox.run`), so the usual timeout is a clean one. The error is `CONVERSION_TIMEOUT` with `metadata: { seconds, ran_seconds, queued_seconds, max_seconds, tier }` (notsobot's `job_timeout_error`: queue time doesn't count, and the message says how long it ran after how long it waited).
- **Cancel:** `DELETE /conversions/<id>` sets `status = 'cancelled'` in Postgres, then stops the job as notsobot's `stop_job` does: `send_stop_job_command` when it's started, `job.cancel()` when it's queued. A horse that starts on a conversion that's already `cancelled` returns without work.
- **Errors are structured,** notsobot's `store_job_error` (pushed as the worker's exception handler): an `ApiError` raised in the horse is saved as `conversions.error` (`{ code, message, metadata }`). Anything else is a crash: `{ type, module, message }` goes to the log for staff, and the conversion gets `CONVERSION_FAILED` (`reason: "internal"`).
- **The parent finishes what the horse couldn't** (`execute_job`, which sees timeouts and killed horses, as notsobot's does): if the conversion is still `running` after the horse is gone, it's set `failed` with the right error, and `failure_reason` is saved either way.
- **Failure reasons,** notsobot's `get_job_failure_reason`: `cancelled`; `killed_at_timeout`; `killed_<SIGNAL>` (usually `killed_SIGKILL` from the OOM killer); `work_horse_lost`; the saved exception's `package.Type`; or the `ApiError`'s code.
- **CPU time:** `ConvertWorker` reaps the horse with `os.wait4` (overriding rq's wait, verify the hook in rq 3.0.0, §17) and charges its rusage, tools included, to the conversion and `conversion_usage` (§7.3).
- **Not retried** (decision 16): no `Retry`. `result_ttl` and `failure_ttl` are 120 s, as notsobot's: the record is the Postgres row, not the RQ result.
- **Stage,** notsobot's `set_job_stage`: the horse sets `conversions.stage` to `downloading`, `converting`, then `storing`, and updates `progress` at most once a second.
- **Temp files,** notsobot's `track_temp_directories`: each horse works in its own directory under `CONVERT_TMP_DIR`, deleted when the job ends however it ended (`perform_job` wraps it). Each service's `CONVERT_TMP_DIR` is a container-local tmpfs, and before taking a job the worker deletes anything there idle longer than the longest time limit plus 5 minutes (notsobot's tasker `TempCleaner`, without a separate service).
- **Metrics,** notsobot's `record_job`: the parent increments counters in a Redis hash (`filesgg:metrics:jobs`: jobs by queue and result, errors and failures by reason, wait and duration buckets), and logs one structured line per job. The admin summary (milestone-4) shows them, with each queue's length and oldest job's age.
- **Queue position,** notsobot's `get_job_queue_position`: `LPOS` of the job in its queue, plus the length of every queue its pool drains first (`convert_member` jobs count `convert_premium` too).
- **The sweeper (`convert_sweep`, decision 17),** every minute on the Postgres scheduler: a `queued` conversion older than 30 s whose RQ job doesn't exist is enqueued again (same job id, so never twice); one queued longer than its tier's wait (anonymous 10 minutes, members 60, premium never) is `cancelled` with `CONVERTER_BUSY`, and its RQ job cancelled (notsobot's queue `ttl` and `JOB_EXPIRED`); a `running` one whose job is gone from Redis and whose `started_at` is past its time limit plus 2 minutes is `failed` with `work_horse_lost`.
- **Not copied from notsobot:** GPU (NVENC) encoding slots (files.gg has no GPUs); the "first poll scans and uploads the result" step, because a files.gg horse stores its output itself (§4.4) and the scan is a pipeline job like any upload's; the `creator` check in job meta, because the Postgres row's owner is the check.

---

## 4. Running a conversion (`convert` job)

### 4.1 Lifecycle

1. `POST /conversions` validates, checks limits (§7), resolves the recipe (§6) and, on a cache hit, creates the output `File` immediately: `status = 'succeeded'`, `cached = true`, no job, no CPU charged, but `count` is.
2. Otherwise it commits the conversion (`queued`), then enqueues `jobs.convert.run` on the caller's tier queue (§3.1) with job id `conversion:<id>` (from an executor thread, as notsobot's `enqueue_job`). A failed enqueue is logged and left to the sweeper (§3.3); the response is the same.
3. It then waits up to 2 s for the conversion to finish (notsobot's `wait_briefly`: re-reading the row at 0.1 s, doubling to 1 s), and answers `200` with the finished conversion or `202` with it still queued or running (§8).
4. An RQ work horse (§3.3) marks it `running`, downloads the source(s) into its directory, converts in sandboxed children, sets its stage and progress, and on success stores the output through the normal path (§4.4).
5. Cancelling, time limits, crashes and lost workers are handled by the worker class and the sweeper (§3.3). Nothing is retried.

### 4.2 Tools by target

| Conversion | Tool |
|---|---|
| image → image | Pillow in the sandboxed child (`python -m media.convert`), `pillow-heif` registered; resvg for SVG first |
| animated, video, audio | ffmpeg (`-progress pipe:1`, two-pass where §1.2 says so). Audio is copied (`-c:a copy`) instead of re-encoded when its codec fits the target container and no option (`bitrate`, `normalize`, `trim_*` on audio-only targets) changes it: AAC into mp4 / m4a, Opus into webm / ogg, MP3 into mp3 (notsobot's `copy_audio`, decision 15) |
| document → pdf | the `office` service (§3.2) |
| pdf → images | `pdftoppm` (poppler) per page range, at `dpi`, with `-r`, `-png` or `-jpeg -jpegopt quality=` |
| images → pdf | `img2pdf` (lossless embedding; PNG with alpha is flattened on `#ffffff` first) |

Before the tool runs, the source's probe is checked against the limits (duration, dimensions, page count), so an oversized job fails fast with `CONVERSION_TOO_LARGE` and `{ limit, value }`.

### 4.3 Output checks

The output is sniffed like an upload (`filetypes.sniff_executable` and the libmagic type) and must be the target's type; anything else is `CONVERSION_FAILED` (`reason: "bad_output"`). An empty output is `CONVERSION_FAILED` (`reason: "empty_output"`).

### 4.4 Storing the output

- Hash, de-duplicate against `file_hashes`, upload to B2 under the normal key, and create the `File` with the normal insert used by `finalize` (one shared helper, not a copy), with:
  - owner: the caller (user or guest), `upload_key_id` NULL;
  - `derived_from_file_id`, `conversion_id`;
  - access: §5.3; expiry: §5.5; `nsfw_marked`: the source's effective NSFW (§5.4);
  - the storage quota is checked here: over it, `STORAGE_LIMIT_REACHED` and no file.
- A new hash gets the normal `scan` job; a de-duplicated one keeps its scan state (a blocked hash makes the conversion `failed`, `FILE_BLOCKED`, and no `File`).
- On success, `conversion_cache` gets `(source_hash_id, recipe_hash) → output_hash_id` (single-source recipes only).

### 4.5 Cache hits

A hit whose output hash is `blocked`, `held` or deleted is ignored (and the cache row deleted). A hit never skips §5 (access) or §7 (limits other than CPU).

### 4.6 PDF → images output

- **Signed in:** a new album owned by the caller, titled `<source name>`, layout `grid`, the pages in order, each page a `File` with the same access and expiry as §5.3 and §5.5; the album gets that access too. The conversion's `output_album_id` is set and the result links to the album.
- **Anonymous:** one ZIP (`<name>-pages.zip`, stored entries, the same layout as the album download ZIP of milestone-3) as the output `File`.
- Page count after `pages` is applied counts against "PDF → images" in §7.1.

---

## 5. Access, ownership and provenance

### 5.1 Who can convert what

The caller must be able to **view** the source right now:
- `link`: anyone.
- `password`: a valid unlock token for that file (`X-Filesgg-Access`, milestone-2), or the owner.
- `private`: the owner only.
- **view-limited** (`view_limit` set): the owner only, else `403 VIEW_LIMITED_SOURCE`.
- The source must not be deleted, expired, `hidden` or `removed` by moderation, and its hash must be `passed` or `flagged`: otherwise `404 SOURCE_UNAVAILABLE` (one code for all, so it leaks nothing).
- A `flagged` (NSFW) source can be converted by anyone who can view it.
- Album sources (images → PDF, batch): the album must be viewable by the same rules (album unlock token), and every item is checked as above; unviewable items are skipped and listed in the response's `skipped`.

### 5.2 Who owns the output

The caller: their user, or their guest. Converting someone else's file never touches the original, and its owner isn't told.

### 5.3 Output access

| Source | Signed-in caller | Anonymous caller |
|---|---|---|
| `link` | their upload default (§21) | `link` |
| `password` or `private` | `private` | `password` with a generated passphrase (returned once, like `generate_password`) |

This is what a request that sends none of `visibility`, `password` and `generate_password` gets; §21 has the upload defaults and the order the fields are settled in. The request may set `visibility` (and `password` / `generate_password`) within the caller's allowed levels: anonymous callers can choose `link` or `password` only (`private` needs an account, `PRIVATE_REQUIRES_ACCOUNT` as for uploads). View limits aren't copied; the request may set its own (`view_limit`, `view_limit_action`), signed-in only.

### 5.4 Provenance and the moderation cascade

- NSFW: the output's `nsfw_marked` is true if the source's effective NSFW is true (uploader mark, staff override, or `nsfw_auto`).
- **When a source file is removed by moderation** (`moderation_state = 'removed'`, or deleted with `deleted_reason = 'moderator'`), every file whose `derived_from_file_id` is it, or that's an output of a conversion listing it in `conversion_sources`, is removed the same way, recursively, with `moderation_rule = 'derived_from_removed'` and an audit entry per file. Hiding cascades the same way, and un-hiding the source un-hides outputs hidden by the cascade only.
- **When a source hash becomes `blocked`** (a rescan, a new hash-list match), the same cascade runs for every file of that hash.
- Albums made by PDF → images go with their pages: the album is removed when all its pages are.
- The cascade runs as a job (`moderation_cascade`, default queue) so a large tree doesn't block the staff request.

### 5.5 Output expiry

- Signed in: the request's `expires_in` (`null` is never), else their upload default (§21), within their limits.
- Anonymous: at most 21 days, default 21 days (the anonymous upload rule).
- An output doesn't expire with its source: it's the caller's file with the caller's expiry. What ties it to the source is the moderation cascade (§5.4).

---

## 6. Recipes and the cache

- `recipe = { "v": CONVERTER_VERSION, "kind": source_kind, "target": target, "options": normalised options }`, serialised as canonical JSON (sorted keys, no spaces, numbers as given after normalising), and `recipe_hash = sha256(recipe)`.
- Normalising fills every default, drops options that are at their "none" value, rounds `trim_*` to milliseconds, and lowercases enums and colours. So `{ "quality": 85 }` and `{}` for jpg are the same recipe.
- `CONVERTER_VERSION` is an integer constant in `api/media/convert.py`, bumped whenever any target's output would change.
- Cache rows are deleted when their output hash is garbage-collected (the blob GC already deletes `file_hashes`; the FK cascades).

---

## 7. Limits

### 7.1 Values

From the plan's table, as `get_limits()` keys (prefix `conversion_`), with premium raising the signed-in column:

| Key | Signed in | Premium | Anonymous |
|---|---|---|---|
| `conversion_targets` | all | all | all except `document → pdf` |
| `conversion_max_input` | 500 MB | 5 GB | 50 MB |
| `conversion_max_duration` | 30 min | 2 h | 60 s (output capped at 720p) |
| `conversion_max_pdf_pages` | 200 | 500 | 20 |
| `conversion_max_images_to_pdf` | 200 | 500 | 20 |
| `conversion_cpu_seconds_per_day` | 1800 | 7200 | 180, per guest **and** per IP |
| `conversion_count_per_day` | 200 | 1000 | 10, per guest **and** per IP |
| `conversion_concurrent` | 3 | 5 | 1 |
| `conversion_batch` | true | true | false |
| `conversion_turnstile` | false | false | true (action `convert`) |
| `conversion_time_limit` | 600 s | 1800 s | 120 s |
| `conversion_queue` | `convert_member` | `convert_premium` | `convert_anonymous` |

Each is overridable by env (`CONVERSION_*`, as the other limits are). Max input is also capped by the caller's max file size for outputs. `conversion_time_limit` is the work horse's wall clock (§3.3), saved on the conversion as `time_limit` when it's created; a `CONVERSION_TIMEOUT` says which tier would give more (`metadata.tier`), as notsobot's `command_time` does.

### 7.2 Checks, in order

1. Turnstile (anonymous): `403 CAPTCHA_INVALID`.
2. `document → pdf` anonymous: `403 CONVERSION_REQUIRES_ACCOUNT`.
3. Batch anonymous: `403 CONVERSION_REQUIRES_ACCOUNT`.
4. Source access (§5.1).
5. Size, duration, pages, images: `413 CONVERSION_TOO_LARGE` `{ limit, value, unit }`.
6. Count per day, concurrent, CPU budget left > 0: `429 CONVERSION_LIMIT_REACHED` `{ limit: "count" | "concurrent" | "cpu", retry_after }`.

When an anonymous caller hits any of 2, 3, 5 or 6, the error has `"sign_in": true`, and the UI offers "Sign in for bigger conversions".

### 7.3 Processing time

- The worker class measures the horse's CPU time when it reaps it (`os.wait4` gives its rusage, which includes the tools it waited on), saves it in `conversions.cpu_ms`, and adds it to `conversion_usage` for every subject (user, or guest and IP). A killed horse is charged too.
- The horse's `RLIMIT_CPU` (set on itself, so its tools inherit what's left) is `min(the tier's time limit, budget left today)`, at least 5 s. Running out mid-job is `CONVERSION_LIMIT_REACHED` (`limit: "cpu"`).
- Days are UTC.

---

## 8. Progress (polled, notsobot style)

- `POST /conversions` waits up to 2 s (§4.1) so quick conversions (most images, cache hits) answer in one request.
- After that the page polls `GET /conversions/<id>` every second while it's `queued` or `running` (and every 5 s while the tab is hidden). Every poll is one indexed row read plus, while queued, one Redis pipeline (`LPOS`, `LLEN`); nothing is held open.
- While **queued**, the conversion object has `position` (how many jobs are ahead of it: `LPOS` in its own RQ queue, plus the length of every queue its worker pool takes first; notsobot's `get_job_queue_position`) and `queue` (`premium` / `member` / `anonymous`).
- While **running**: `stage` (`downloading` / `converting` / `storing`), `progress` 0–1, `time_limit`, and `started_at`. The horse writes `progress` at most once a second (ffmpeg `out_time_us ÷ duration`; pages done ÷ pages for PDF → images; 0, then 1 for single-step tools).
- `took` is the milliseconds since the conversion was created, until it finished (notsobot's `result.took`).
- The UI shows "Waiting in line: 3 ahead" (with "Sign in to skip the line" for anonymous visitors), then the stage and a progress bar, with Cancel throughout.

---

## 9. Document previews

### 9.1 When

- After a document-kind hash (§1.1) is **scanned** `passed` or `flagged`, if at least one live `File` of that hash is owned by a **user** (not a guest), the scan job (Postgres) commits `preview_state = 'queued'` and then enqueues `jobs.convert.preview` on the `convert_previews` RQ queue (§3.1), run by `converter-previews` in a work horse like any conversion. The sweeper re-enqueues a `queued` preview whose job is missing. `preview_state` goes `none` → `queued` → `done` / `failed` / `skipped`.
- An anonymous file claimed into an account (milestone-6 §4.2) queues the preview then, if the hash has none yet.
- Inputs over 50 MB, or a probe that says the file is encrypted, are `skipped` (no LibreOffice run).
- The job runs the same `office` path as `document → pdf` (§3.2) with `max_pages` 300 and a 120 s timeout; the PDF is stored as the hash's `document` asset (`application/pdf`), and its first page is rendered with `pdftoppm` to the `thumb` / `thumb-2x` assets when the hash has none.

### 9.2 Serving

- The owner payload's `assets.document` and the viewer's `#file-data` get `{ url, size, pages }`, at the CDN path `/previews/document/<vanity>.pdf?v=<asset version>`, signed for protected files exactly like the other preview kinds (milestone-3).
- The viewer shows the PDF renderer with that URL when `assets.document` is present: the download button still downloads the original file, and the header says "Preview" with the original type ("Word document · preview").
- Without the asset: the download card, plus "Convert to PDF" for signed-in viewers who can convert, or "Sign in to preview and convert" when the file is anonymous and has no preview.

---

## 10. API

Every endpoint is on `files.gg/api` (session cookie, CSRF rules of milestone-6 §3.6) and `api.files.gg` (anonymous, no cookie, CORS for custom-domain viewers is **not** extended: converting happens on files.gg only). Anonymous callers send `Authorization: Guest` as they do for uploads (§20). Upload keys get `403 UPLOAD_KEY_SCOPE` on everything here.

### 10.1 `GET /conversions/formats`

Public, cacheable for 5 minutes. `{ "version": CONVERTER_VERSION, "kinds": { "<kind>": { "targets": [ { "target": "mp4", "label": "MP4", "group": "video", "anonymous": true, "options": [ { "name": "max_height", "type": "enum", "values": [1080, 720, 480], "default": null, "label": "Max height" }, … ] } ] } }, "presets": [ { "id": "play_everywhere", "label": "Make it play everywhere", "kinds": ["video"], "target": "mp4", "options": {} }, { "id": "discord", "label": "Shrink for Discord", "kinds": ["video"], "target": "mp4", "options": { "target_size": "discord" } }, { "id": "extract_audio", "label": "Extract audio", "kinds": ["video"], "target": "mp3", "options": {} }, { "id": "gif_to_mp4", "label": "GIF → MP4", "kinds": ["animated"], "target": "mp4", "options": {} }, { "id": "remove_location", "label": "Remove photo location data", "kinds": ["image"], "target": "same", "options": { "strip_metadata": true } } ] }`. Option `type` is one of `int`, `number`, `bool`, `enum`, `color`, `pages`, `size` (the `target_size` preset-or-MB). `"target": "same"` means the source's own format.

### 10.2 The conversion object

`{ id, status, position, queue, stage, progress, time_limit, took, source: { kind, file: <file summary> | null, album: <album summary> | null, count }, target, options, cached, output: { file: <owner file payload> | null, album: <album summary> | null, password: <string, only on the response that created it> }, error: { code, message, metadata } | null, input_size, output_size, cpu_seconds, created_at, started_at, finished_at }`.
- `position`: jobs ahead while `queued` (§8), else 0. `queue`: `premium` / `member` / `anonymous`. `stage`: while `running`, else null. `time_limit`: seconds. `took`: ms (§8).
- `error.metadata` holds what the code adds (`reason`, `limit`, `value`, `unit`, `sign_in`, the timeout's `seconds` / `ran_seconds` / `queued_seconds` / `max_seconds` / `tier`), the same shape as the API's other errors.
- `failure_reason` is never in it (staff only).
- File and album summaries are the existing owner/public payloads; times are epoch seconds.

### 10.3 `POST /conversions`

Body: `{ source: "<vanity>" }` or `{ sources: ["<vanity>", …] }` (images → PDF, ordered) or `{ album: "<vanity>" }` (images → PDF in album order), plus `target`, `options`, and optional `visibility`, `password`, `generate_password`, `expires_in`, `view_limit`, `view_limit_action`, and `turnstile_token` (anonymous). Access tokens for protected sources: `X-Filesgg-Access`, one token per request (so a protected source is one per conversion; protected items of a multi-source request need the album token).
- After the brief wait (§4.1): `200 <conversion>` when it's finished (succeeded, failed or a cache hit), `202 <conversion>` while it's still queued or running. A conversion that failed during the wait is still `200` with its `error`, as notsobot's job responses are.
- Errors: §7.2, `INVALID_OPTION`, `UNSUPPORTED_CONVERSION`, `SOURCE_UNAVAILABLE`, `VIEW_LIMITED_SOURCE`.

### 10.4 `GET /conversions/<id>`, `DELETE /conversions/<id>`

The caller's own conversions only (`404` otherwise). `DELETE` on `queued` or `running` sets `cancelled` (`200 <conversion>`); on a finished one it removes it from history (`204`) without touching the output file.

### 10.5 `GET /users/@me/conversions`

Paginated like the file list (`?before=<id>&limit=` 1–100, default 50), newest first, for the session's user or the guest (anonymous visitors see their own recent conversions in the page, not a history tab). `{ items: [<conversion>], next: <id> | null }`.

### 10.6 `POST /conversions/batch`

Signed in only. `{ files: ["<vanity>", …] (1–100) | album: "<vanity>", target, options, …same output fields }`. One conversion per source with a shared `batch_id`; sources whose kind has no such target are listed in `skipped` with the reason. Limits are checked for the whole batch up front (count and concurrency count every item; the concurrent limit queues the rest rather than refusing them). `202 { batch_id, items: [<conversion>], skipped: [{ source, code }] }`. `GET /conversions?batch=<id>` lists a batch.

### 10.7 Routes summary

| Method and path | Notes |
|---|---|
| `GET /conversions/formats` | public |
| `POST /conversions` | §10.3 |
| `POST /conversions/batch` | §10.6 |
| `GET /conversions?batch=<id>` | caller's batch |
| `GET /conversions/<id>` | |
| `DELETE /conversions/<id>` | cancel or forget |
| `GET /users/@me/conversions` | history |

---

## 11. Worker (`cf-worker/`)

- The CDN preview paths accept kind `document` with extension `pdf`, with the same signing, `Content-Type: application/pdf`, `Content-Disposition: inline`, and the existing protected-file rules. Bots get the same treatment as other previews.
- `files.gg/convert` serves the app shell (it was a placeholder; `convert` is already a reserved vanity).
- No other routes.

---

## 12. Error codes

| Code | Status | Message | Extra |
|---|---|---|---|
| `UNSUPPORTED_CONVERSION` | 400 | "This file can't be converted to that format" | `{ kind, target }` |
| `INVALID_OPTION` | 400 | "That option isn't valid for this conversion" | `{ option, reason }` |
| `TARGET_SIZE_TOO_SMALL` | 400 | "That size is too small for this video" | `{ minimum_mb }` |
| `CONVERSION_TOO_LARGE` | 413 | "This file is too big to convert" | `{ limit, value, unit, sign_in? }` |
| `CONVERSION_LIMIT_REACHED` | 429 | "You've reached your conversion limit for today" (count, cpu) / "Too many conversions at once" (concurrent) | `{ limit, retry_after, sign_in? }` |
| `CONVERSION_REQUIRES_ACCOUNT` | 403 | "Sign in to convert documents" / "Sign in to convert in bulk" | `{ sign_in: true }` |
| `SOURCE_UNAVAILABLE` | 404 | "That file isn't available" | |
| `VIEW_LIMITED_SOURCE` | 403 | "Files with a view limit can only be converted by their owner" | |
| `RATE_LIMITED` | 429 | "You're doing that too fast" | `{ retry_after }`, and `Retry-After` (§18) |
| `RATE_LIMIT_UNAVAILABLE` | 503 | "Try again in a moment" | (a fail-closed limit with Redis down, §18.1) |
| `CONVERTER_BUSY` | 503 (as the conversion's error) | "Busy right now. Try again, or sign in to skip the queue" | `{ sign_in: true }` |
| `CONVERSION_TIMEOUT` | (as the conversion's error) | "The conversion took too long" | |
| `CONVERSION_FAILED` | (as the conversion's error) | "The conversion failed" | `reason`: one of `unreadable_source`, `bad_output`, `empty_output`, `too_many_pages`, `target_size_missed` (a `target_size` output still over the size after one corrective encode), `internal` |

`CONVERSION_TIMEOUT`, `CONVERSION_FAILED`, `CONVERTER_BUSY`, `FILE_BLOCKED` and `STORAGE_LIMIT_REACHED` appear in the conversion object's `error`, not as HTTP errors of `POST` (which already answered `202`). Existing codes reused: `CAPTCHA_INVALID`, `PRIVATE_REQUIRES_ACCOUNT`, `UPLOAD_KEY_SCOPE`, `STORAGE_LIMIT_REACHED`, `FILE_BLOCKED`.

---

## 13. Web (`web/`)

### 13.1 Convert page

`/app/convert` (dashboard) and `/convert` (public, same component without history). Steps, as the plan's Phase 3 item 9:
1. **Source:** drop or paste a file (uploaded through the normal upload, then converted), or pick from the library or an album (signed in), or `?source=<vanity>` (from entry points).
2. **Target:** chips from `/conversions/formats` for the source kind, presets first. Targets not allowed for the caller show with a lock and "Sign in" (anonymous `document → pdf`).
3. **Options:** a form generated from the target's option list (every `type` in §10.1 has a control), with a size estimate for `target_size` and the input size.
4. **Convert:** Turnstile for anonymous callers, then "Waiting in line: N ahead" while queued and the stage and a progress bar while running, polled (§8), with Cancel. A failed or timed-out conversion shows its message (a timeout says how long it ran, and which tier gets more) and **Try again**.
5. **Result card:** a preview with the viewer renderers (image, video, audio, PDF; album link for PDF pages), size before and after, Copy link, Download, "Convert again", "Add to album" (signed in). A generated password is shown once, as on the upload page.
- **History** (signed in): source, target, status, size change, output link, re-run and delete (§10.5), newest first, live-updating rows that are still running.
- **Batch:** Files table multi-select → **Convert…**, and album header **Convert all**: a target picker for the kinds selected, then one combined progress list (`GET /conversions?batch=`), with per-item results.

### 13.2 Entry points

- Viewer footer: **Convert** on any file the visitor can convert (a link to `files.gg/convert?source=<vanity>`; on a custom domain it opens files.gg in a new tab).
- Video with `playable: false`: "Convert to MP4 to play in browser" in the player area, starting the `play_everywhere` preset.
- Document without a preview: "Convert to PDF" (signed in) or "Sign in to preview and convert" (§9.2).
- Album header: **Convert all** (owner, signed in).
- Files table and file drawer menus: **Convert…**.

### 13.3 Document preview in the viewer

`assets.document` → the existing PDF renderer, with the original type in the header and the original file on Download (§9.2).

---

## 14. Config

| Variable | Default | Where |
|---|---|---|
| `REDIS_URL` | required | API, `converter*` |
| `REDIS_PASSWORD` | required | `redis`, and in `REDIS_URL` |
| `RATE_LIMITS` | §18.2, §18.3 | API (JSON, replaces `AUTH_RATE_LIMITS`) |
| `CONVERTER_PREMIUM_PROCESSES` / `CONVERTER_PROCESSES` / `CONVERTER_PREVIEW_PROCESSES` | 2 / 4 / 1 | the `converter*` services (§3.1) |
| `CONVERT_THREADS` | the service's `cpus` ÷ its processes, min 1 | the `converter*` services (§3.1) |
| `CONVERT_TMP_DIR` | `/convert-tmp` (a tmpfs) | the `converter*` services (§3.3) |
| `OFFICE_PROCESSES` | 2 | office |
| `OFFICE_SPOOL_DIR` | `/spool` | `converter*`, office |
| `OFFICE_TIMEOUT` | 120 | `converter*`, office |
| `CONVERSION_*` | §7.1 | API, converter |
| `DOCUMENT_PREVIEWS` | `1` | worker (scan completion), converter |

Compose (`docker-compose.yml`, the test and e2e composes): the `converter-premium`, `converter` and `converter-previews` services (one image, different queues, processes, `cpus` and `cpu_shares`, as notsobot's three `api-rq-worker-*` services), the `redis` service and its volume, the `office` service, the `office-spool` volume, and a tmpfs for each service's `CONVERT_TMP_DIR`. `docker-compose.test.yml` gets a `redis` too (the tests use a real one: RQ forks, which fakeredis can't follow). The e2e stack runs all of them, with one process each.

---

## 15. Tests

- **API:** formats document matches §1.2; option normalising and recipe hashes (test vectors: `{}` and `{"quality": 85}` for jpg hash the same; `trim_start: 1.00049` rounds to `1.000`); every row of §7.2 in order; access matrix of §5.1 (link, password with and without token, private, view-limited, hidden, removed, expired, blocked hash); output access of §5.3; cache hit returns `200` and creates a `File` without a job; cascade of §5.4 (remove, hide, unhide, blocked hash, multi-source); the tier queue picked per caller; queue position (`LPOS` plus the pool's earlier queues); the 2 s brief wait answers `200` for a quick job and `202` otherwise; enqueue after commit, and the sweeper (missing job re-enqueued once, queued too long → `CONVERTER_BUSY`, running with its job gone → `work_horse_lost`); the Postgres pipeline's jobs are untouched.
- **Worker class (§3.3), with a real Redis and `rq worker-pool`:** pools drain their queues in order; a time limit kills the horse and its tools and saves `CONVERSION_TIMEOUT` with `ran_seconds` / `queued_seconds`; cancel stops a running horse and skips a queued one; an `ApiError` in the horse is saved as `error`; a crash, a SIGKILL (OOM) and a lost horse each give the right `failure_reason`; the horse's directory is gone afterwards in every case; CPU time is charged for killed horses too; metrics counters land in Redis.
- **Converter (offline, real tools in the test image):** one conversion per target from small fixtures checked in under `api/tests/fixtures/convert/` (png, jpg with GPS EXIF, heic, svg with an external reference and a script that must not run, psd, animated gif, a 3 s mp4, a wav, a 3-page pdf, a docx, an xlsx with a `WEBSERVICE()` formula, a pptx); metadata really stripped; GIF → MP4 smaller; `target_size` never over the size and at least 85% of it (x264's two-pass undershoots by a few percent); cancel kills the child; timeout; CPU budget exhausted mid-job; `bad_output`.
- **Office:** the daemon in its container with no network: the xlsx `WEBSERVICE()` and a docx with a remote image produce a PDF and make no connection (the container has no interface but `lo`); timeout kills soffice; `too_many_pages`; spool cleanup.
- **Rate limits (§18), with a real Redis:** the Lua moving window (a refused hit isn't recorded; the window really moves; `peek` records nothing); several limits in one round trip; the global limit and each route limit; `client_key` order (user, key, IP, never the guest); internal lookups and staff skips; every scope of §18.3 with its value and code; failures-only counting for login and re-auth; Redis down: open limits let the request through, closed ones answer `503 RATE_LIMIT_UNAVAILABLE`; `Retry-After` on every 429; the two tables and the old stub are gone.
- **Worker:** `document` preview path signing and headers; `/convert` shell.
- **Web:** form generation for every option type; presets; anonymous lock and sign-in prompts; polling (1 s, 5 s hidden), queue position and stage display, timeout and Try again; cancel; result card per output kind; history; batch list; viewer Convert button, the not-playable prompt, the document preview header.
- **e2e:** new steps: image strip-metadata, GIF → MP4, video → mp4 with `target_size`, audio normalise, docx → PDF (signed in) and refused anonymous, docx preview shows in the viewer, PDF → album (signed in) and ZIP (anonymous), images → PDF from an album, batch, cancel, cache hit, moderation cascade, anonymous Turnstile and daily count.

---

## 16. Ops checklist (not code)

- Size the converter hosts: video transcodes are the heaviest load files.gg will have. Start with one converter host separate from the API.
- The `office` image is about 1 GB; pull it on deploy, not on first use.
- Watch the oldest queued conversion per queue (the admin summary, §3.3) and grow a pool's processes when it climbs, as notsobot does with `notsobot_job_queue_oldest_seconds`.
- Watch failure rates by `failure_reason`: `killed_SIGKILL` means horses are running out of memory (raise `mem_limit` or lower the processes), a spike in an exception type usually means a tool upgrade changed behaviour.
- Fonts: Microsoft's own fonts aren't redistributable; Carlito and Caladea are metric-compatible with Calibri and Cambria, Liberation with Arial, Times and Courier.

## 17. Still to verify at build time

- `resvg` and the LibreOffice `-nogui` packages' exact names and versions in Debian trixie.
- `pillow-heif` wheels for the converter's Python (3.14); if missing, build from sdist in a stage as `pdqhash` is.
- The current Discord free upload limit (10 MB assumed for the `discord` preset).
- That a tmpfs-backed named volume can be shared between two containers on the deploy Docker version.
- rq 3.0.0's hook for reaping the work horse (to use `os.wait4`), and that `ConvertJob._execute` still matches notsobot's fix on 3.0.0.
- `hiredis` wheels for the API's Python (3.15); it's optional for `redis`, so leave it out of the API image if there are none.

---

## 18. Rate limits on Redis (owner, 2026-11-25)

The owner decided to copy notsobot.api's limiter (`utilities/tools/ratelimit.py`, `app_limiter.py`) now that Redis is in the stack (§3.1), and to move every existing rate limit onto it. Before this, files.gg had only fixed-window counters in Postgres on a handful of sensitive actions (`safety_rate_limits`, `unlock_attempts`), no global limit, and a `wrappers.ratelimit` decorator that did nothing.

### 18.1 The limiter (`api/utils/ratelimit.py`)

A port of notsobot's, with the files.gg changes marked:
- **Moving windows in Redis,** one Lua script per check (notsobot's `MOVING_WINDOW_LUA`): per limit, a list of hit timestamps (ms, newest first), trimmed to the limit's size and expiring with its window. Redis's own `TIME`, so every process agrees. A refused request isn't recorded, so it doesn't push the window back. Every limit a request is under is checked in one round trip.
- **Limits are text,** `"<amount> per [<n>] <second|minute|hour|day>"` (`Limit.parse`), keyed `ratelimit:<scope>:<key>:<amount>/<seconds>`. Keys are ids or hashes only (user id, upload key id, the abuse IP hash, the email hash); no raw IP or email ever reaches Redis.
- **A global limit** on every routed request (404s aren't limited), and `@limiter.limit("…")` per route, stacked for more than one. Both run as request middleware after authentication, like notsobot's `init_app` (priority after the session and key lookups).
- **The key function** (`client_key`): the session's user id, else the upload key's id, else the abuse IP hash (milestone-4, IPv6 grouped by /64). **Never the guest id** (the browser chooses it). Returning None skips every limit: the Worker's internal lookups (`/internal/*`, the RPC key).
- **Request filters** (notsobot's `request_filter`): staff sessions skip the global and route limits, not the brute-force ones in §18.3.
- **`ctx_ratelimit_own=True`** routes skip the middleware and limit themselves in the handler with `await limiter.hit(request, scope, key, "…")`, for limits keyed by something other than the caller (an account's email, a file and an IP).
- **`peek`** (files.gg addition): the same script without recording, for limits that count failures only (login, re-auth): check with `peek` before the attempt, record with `hit` after it fails.
- **Failure modes** (files.gg change): notsobot lets every request through when Redis is down. Here each limit is `fail="open"` (default: the global and route limits) or `fail="closed"`. A Redis error on a closed limit answers `503 RATE_LIMIT_UNAVAILABLE` ("Try again in a moment"), so a Redis outage never switches off brute-force protection.
- **The response,** notsobot's `RateLimitExceeded` handler: `429` with `retry_after` (seconds, 3 decimals) in the body and a `Retry-After` header (whole seconds, at least 1). Global and route limits use code `RATE_LIMITED` ("You're doing that too fast"); the existing codes below keep their names and gain the header.
- `api/utils/ratelimit_sync.py` becomes the same thing for synchronous code (the domain API runs in a thread), on a sync Redis client.

### 18.2 Global and route limits (new)

| Limit | Value | Key | Fail |
|---|---|---|---|
| Global, every routed request | `50 per second` (notsobot's) | `client_key` | open |
| `GET /auth/guest` | `30 per minute` | IP | open |
| `POST /files`, `POST /uploads` | `60 per minute` | `client_key` | open |
| `POST /conversions`, `POST /conversions/batch` | `30 per minute` | `client_key` | open |
| `GET /conversions/<id>` | `5 per second` (the page polls once a second, §8) | `client_key` | open |
| `POST /reports`, `POST /reports/anonymous` | the report limits below | | |

Every value is overridable by env, `RATE_LIMITS` (JSON `{ "<scope>": "<limit text>" }`, which replaces `AUTH_RATE_LIMITS`). An invalid value refuses boot.

### 18.3 The existing limits, moved

Same values; the window becomes moving instead of fixed (so a burst across the hour no longer gets double).

| Scope | Value | Key | Fail | Code (unchanged) |
|---|---|---|---|---|
| `login_ip` | `30 per hour`, failures only | IP | **closed** | `TOO_MANY_ATTEMPTS` |
| `login_account` | `10 per hour`, failures only | email hash | **closed** | `TOO_MANY_ATTEMPTS` |
| `reauth` | `10 per hour`, failures only | user | **closed** | `TOO_MANY_ATTEMPTS` |
| `register` | `5 per hour` | IP | **closed** | `TOO_MANY_ATTEMPTS` |
| `forgot_ip` / `forgot_account` | `10` / `3 per hour` | IP / email hash | **closed** | (silent, as now: the answer is always the same) |
| `verify_resend` | `5 per hour` | user | open | `TOO_MANY_ATTEMPTS` |
| `discord` | `30 per hour` | IP | open | `TOO_MANY_ATTEMPTS` |
| `username_check` | `60 per hour` | IP | open | `TOO_MANY_ATTEMPTS` |
| `unlock` (file or album password) | `5 per minute` | file or album + IP | **closed** | `TOO_MANY_ATTEMPTS` |
| `access` (token refresh, `/view`) | `30 per minute` | file or album + IP | open | `TOO_MANY_ATTEMPTS` |
| `report` | `REPORT_RATE_PER_HOUR` (10) | user, or guest and IP | **closed** | as now |
| `report_message` | `REPORT_MESSAGE_RATE_PER_HOUR` (30) | user | **closed** | as now |
| `upload_key` | `UPLOAD_KEY_RATE_PER_HOUR` (600) | key | open | `TOO_MANY_UPLOADS` |
| `domain_add` | `10 per day` | user | open | `TOO_MANY_ATTEMPTS` |
| `domain_check` | `1 per minute` | domain | open | `DOMAIN_CHECK_RATE_LIMITED` |
| `export` | as now | user | open | as now |

`unlock` and `access` keep their key's privacy rule: the IP part is today's daily-rotating purpose hash (`view_hash.purpose_hash(…, 'unlock', today, ip)`), not the abuse IP hash.

### 18.4 What stays in Postgres

Quotas and caps that are accounting, not rate: `conversion_usage` (daily CPU time and count, §7), storage, open chunked uploads (`TOO_MANY_UPLOADS` by count), concurrent conversions, view limits. They must survive a Redis restart; a rate limit losing its window doesn't matter.

### 18.5 Removed

- `safety_rate_limits` and `unlock_attempts` are dropped in `0007_conversions.sql` (fresh launch: nothing to carry over), with their cleanup in the hourly safety task and `queries.count_attempt`.
- `wrappers.ratelimit`, the decorator that did nothing.
- `AUTH_RATE_LIMITS` (replaced by `RATE_LIMITS`).

---

## 19. Changelog, Terms and Privacy pages (owner, 2026-11-25)

The owner asked for a changelog, a Terms of Service and a Privacy Policy. Decided: the operator is a **placeholder** until a lawyer or the owner fills it in; the minimum age is **13, and 18 for adult content**; changelog entries are **Markdown in the repo**. The rest of the dashboard the owner asked about already exists: the overview and Files pages (Milestone 3), Settings (Milestone 6), and the Admin dashboard (Milestone 4: overview, queue, bugs, lookup, domains, bans, audit log, rescans), which gains conversion queue health here (§3.3).

### 19.1 Pages and routes

| Path | Page | Source |
|---|---|---|
| `files.gg/changelog` | Changelog | `CHANGELOG.md` at the repo root |
| `files.gg/legal/terms` | Terms of Service | `web/src/content/legal/terms.md` |
| `files.gg/legal/privacy` | Privacy Policy | `web/src/content/legal/privacy.md` |
| `files.gg/legal` | 302 to `/legal/terms` | |

- Public pages in the main web entry (not the dashboard bundle), readable signed out, with a table of contents, heading anchors, the "last updated" date, and print styles. Light and dark like the rest of the site.
- The Worker serves the app shell for these paths on `MAIN_HOST` only (not the CDN, the API or custom domains), with their own `<title>` and description. `changelog` joins the reserved vanities (`legal` already is).
- `/legal/terms` is already linked from the removed-file pages (`TERMS_URL` in `web/src/viewer/components/stateCopy.ts`); it now exists.
- **Markdown is converted at build time** by a small Vite plugin (`web/plugins/markdown.ts`, `marked` as a dev dependency): `import html from '…/terms.md?html'`. No Markdown parser ships to browsers, and the input is the repo's own files, so no sanitiser is needed. Headings get stable `id`s for anchors.

### 19.2 Links to them

- A site footer on the home page, the Convert page, the auth pages and the dashboard sidebar's bottom: Changelog · Terms · Privacy · Report abuse · Contact.
- The viewer footer (files.gg and custom domains): Terms · Privacy · Report, linking to files.gg.
- **Sign up** (email and Discord): "By creating an account, you agree to the Terms and the Privacy Policy, and confirm you're 13 or older." No checkbox: the button is the agreement.
- **Anonymous uploads and conversions:** "By uploading, you agree to the Terms." under the button.
- **Marking or viewing adult content** (the NSFW gate): "You must be 18 or older."
- The dashboard sidebar shows a dot on **Changelog** when the newest entry is newer than the last one this browser opened (`localStorage`, a convenience only).

### 19.3 The changelog

- `CHANGELOG.md`: newest first, one `## YYYY-MM-DD: <title>` section per release with short user-facing bullets (no internal names, no milestone numbers). Written as part of each release's commit.
- The first entry is the launch of the new files.gg: what it does (uploads up to 1 GB, private and password files, view limits, albums, previews, conversion, accounts, upload keys for ShareX, premium custom domains, reports). Nothing about the old site or its data.
- Each entry has an anchor (`/changelog#2026-12-01`).

### 19.4 Terms of Service: what the draft covers

Drafted from what files.gg really does (this contract and milestones 2–6), in plain language, with `[OPERATOR]`, `[OPERATOR ADDRESS]`, `[GOVERNING LAW]`, `[DMCA AGENT]` and `[CONTACT EMAIL]` placeholders and a visible "Draft: pending legal review" banner while any placeholder remains:
1. Who runs files.gg and how to reach them.
2. Eligibility: 13 or older; 18 or older to upload, mark or view adult content; parents' responsibility for minors.
3. Accounts, anonymous use, upload keys, and keeping credentials safe.
4. Your content stays yours; the licence files.gg needs to store, scan, process, preview, convert and serve it.
5. Acceptable use: the prohibited content and conduct from PLAN.md's trust & safety section (CSAM with zero tolerance and reports to NCMEC, non-consensual intimate imagery, malware and phishing, harassment, illegal goods, infringement, abuse of the service), and the duty to mark adult content.
6. **Scanning:** every upload is scanned (CSAM hash matching, malware, NSFW classification, link checks), private and password files included; passwords and view limits are access controls, not encryption.
7. Reports, moderation, strikes, notices and appeals, as built in milestone 4.
8. Copyright: notices and counter-notices to the designated agent, and repeat infringers.
9. Expiry, view limits, deletion, and the 14-day account deletion grace period.
10. Premium and custom domains (granted by staff for now; no payments).
11. Availability without warranty, limitation of liability, indemnity.
12. Termination, changes to the Terms (with the changelog), governing law, contact.

### 19.5 Privacy Policy: what the draft covers

Every statement is taken from the code and its configured defaults (the agent cites the setting for each number), with `[OPERATOR]`, `[PRIVACY CONTACT]` and `[EU/UK REPRESENTATIVE, if needed]` placeholders:
1. Who's responsible and how to reach them.
2. **What's collected and why:** account data (email, username, display name, argon2id password hash, linked Discord id); uploads and their metadata (names, sizes, hashes; photos keep their EXIF unless converted with "strip metadata"); the guest id for anonymous uploads (a random id stored in the browser); IP addresses only as keyed hashes for abuse limits and view counting, plus an encrypted uploader IP opened only for legal requests and abuse (kept `ABUSE_IP_KEEP_DAYS`, 30); reports and moderation records (`REPORT_RETENTION_DAYS`, 365) and evidence holds (`EVIDENCE_RETENTION_DAYS`, 365); sessions; rate-limit windows (hashes, minutes to a day).
3. **Cookies:** one strictly necessary session cookie when signed in, no tracking, analytics or advertising cookies, so no consent banner; the browser storage keys and what they're for.
4. **Service providers:** Cloudflare (CDN, Turnstile, custom domains), Backblaze B2 (storage, US), Postmark (account email), Discord (only if linked), Microsoft PhotoDNA (CSAM matching), Google Web Risk (link checks), and NCMEC when the law requires a report.
5. Retention and deletion: expiry, account deletion with its 14-day grace, exports kept `EXPORT_KEEP_DAYS` (7), backups and how long deleted data lingers in them.
6. Your rights: access and export, correction, deletion, objection; how to use them from Settings or by email; GDPR and UK GDPR legal bases and complaints to a supervisory authority.
7. Children: 13 or older, and the countries where the age for consenting to data processing is higher.
8. Transfers to the US, security measures, changes to the policy, contact.

### 19.6 No placeholders in production

`vite build` fails when `terms.md` or `privacy.md` still contains a `[PLACEHOLDER]`-style token and `FILESGG_ALLOW_LEGAL_PLACEHOLDERS` isn't set. `e2e/up.sh`, the dev server and the tests set it; a production build without it can't ship a draft by accident.

### 19.7 Tests

- **Web:** the three pages render from their Markdown (headings, anchors, table of contents); the draft banner shows with placeholders and not without; footer and sign-up links; the changelog dot.
- **Build:** the placeholder check fails a production build and passes with the variable.
- **Worker:** the three paths serve the shell on `MAIN_HOST` only; `/legal` redirects; `changelog` is reserved.
- **e2e:** the pages load signed out, and the removed-file page's Terms link resolves.

---

## 20. Guests: "fingerprint" is renamed (owner, 2026-11-25)

The anonymous uploader's id was called a *fingerprint*, which sounds like device fingerprinting (canvas hashes, tracking). files.gg never did that: it's a random id the API signs and the browser keeps. It's now a **guest**, everywhere.

### 20.1 The token and how it's sent

- `GET /auth/guest` (was `/auth/fingerprint`) answers `{ "guest": "<token>" }`: a new random id, or the caller's own re-signed. Rate limit scope `guest` (was `fingerprint`), keyed by IP, `30 per minute`.
- The browser keeps it in `localStorage` as `filesgg.guest` (was `filesgg.fingerprint`) and sends it as **`Authorization: Guest <token>`** (was `X-Fingerprint`): the same header and parser as upload keys (`Authorization: Key fgg_…`). Browsers never attach `Authorization` on their own, so it stays CSRF-safe.
- **`Guest` only ever identifies a guest; it never authenticates a user.**
  - On `/auth/login`, `/auth/register` and the Discord callbacks it names the uploads to claim (milestone-6 §4.2), next to the session the request creates.
  - On a request that also carries a session cookie, the session decides who the caller is and the guest is used only for claiming, as `X-Fingerprint` was.
  - An invalid or expired guest token is ignored, as an invalid fingerprint was: the caller is then a guest with no id, and endpoints that need one say so.
  - `Authorization: Key …` and `Guest` never come together; any other scheme stays `401`.
- The token class is `GuestToken` (itsdangerous, salt `guest`).

### 20.2 Names

| Was | Now |
|---|---|
| `files.fingerprint` | `files.guest_id` |
| `albums.owner_fingerprint`, `upload_sessions.owner_fingerprint`, `conversions.owner_fingerprint` | `owner_guest_id` |
| reports' `reporter_fingerprint` | `reporter_guest_id` |
| bans by `fingerprint` | bans by `guest` |
| rate-limit and usage subjects `f:<id>` | `g:<id>` |
| web `ensureFingerprint`, `FINGERPRINT_KEY` | `ensureGuest`, `GUEST_KEY` |

- The migrations are edited in place (nothing is deployed yet; the fresh-launch rule), with every index and constraint renamed to match. No rename migration.
- The Worker's CORS `Access-Control-Allow-Headers` drops `X-Fingerprint` (`Authorization` is already allowed for upload keys).
- User-facing text says "guest" where it named the id at all; most text already says "uploads from this browser" or "without an account", and stays.
- Earlier contracts keep their wording as the record of what was decided; a note at the top of each points here.

---

## 21. Upload defaults and conversion output options (owner, 2026-11-25)

Each account picks what its tool uploads and conversions get when they don't say: an expiry, who can open the file, and the adult-content mark. The Upload and Convert pages start from the same values. §5.3 and §5.5 point here.

### 21.1 The setting

- **Stored** in `users.upload_defaults` (`jsonb NOT NULL DEFAULT '{}'`, an object; added by `0007_conversions.sql`). `{}` is the plain default.
- **In the user object** (milestone-6 §2.1): `settings.upload_defaults = { "expires_in": <seconds> | null, "visibility": "link" | "private" | "password", "nsfw": <bool> }`, always all three, as they apply now (§21.2). New accounts: `{ "expires_in": null, "visibility": "link", "nsfw": false }`.
- **Changed with** `PATCH /users/@me { "settings": { "upload_defaults": { … } } }` (session cookie, CSRF header; upload keys get `403 UPLOAD_KEY_NOT_ALLOWED` as for every settings endpoint). Any of the three fields; the ones left out keep their value; the answer is the user object. The data export's `account.json` carries the stored object.
- **`visibility: "password"` is always a generated password per file** (a batch shares one, §10.6). No password is ever stored with the defaults.
- **Validation**, `400 INVALID_PARAMETERS` with `errors` keyed `settings.upload_defaults.<field>` (only the bad fields; nothing is saved):
  - `expires_in`: an integer number of seconds (not a boolean, string or fraction), at least an hour (`MIN_EXPIRY`), at most the account's `max_expiry` when it has one; `null` (never) only when the limits say `allow_no_expiry`. Today every signed-in account may keep files forever and has no maximum; the checks are there for plans that change that.
  - `visibility`: `link`, `password` or `private`.
  - `nsfw`: `true` or `false`.
  - any other key: "Unknown setting"; anything but an object: "Must be an object".

### 21.2 Checked again when used

Every use reads the stored object through `upload_defaults.of(user)`, which keeps each value the account's current `get_limits()` still allows and puts the plain default in place of any other: `link`, the limits' default expiry (never, or `max_expiry` when never isn't allowed), not adult. So a value that was allowed when it was set (a longer expiry on a plan that ended) never makes an upload fail; it quietly becomes the plain default. `GET /users/@me` shows the values in effect.

### 21.3 Where they apply, and in what order

A field the request sends always wins, field by field; the defaults fill only what it leaves out.

1. **Upload-key uploads** (`POST /files` and `POST /uploads` with `Authorization: Key`):
   - `expires_in` not sent: the default expiry.
   - none of `visibility`, `password`, `generate_password=true` sent: the default visibility (`password` sets `generate_password`). Sending a password or `generate_password=true` already says `password`.
   - `nsfw` not sent: the default mark (`nsfw=false` sent keeps it unmarked).
   - Then everything runs as for any upload: the expiry, access and NSFW checks, scanning, limits.
   - A key upload's `POST /files` answer always has `url_with_password`: the `#pw=` link when a password was generated, else the same as `url`. The `.sxcu` `URL` is therefore always `{json:url_with_password}` (this replaces milestone-6 §7.7's "`{json:url}` without `generate_password`"), so a password the defaults generate is in the link ShareX copies.
   - A key upload can't ask for "never" when the default has an expiry: the multipart fields have no value for it. The ShareX dialog's choices left at **Account default** follow these defaults.
2. **Conversions** (`POST /conversions`, `POST /conversions/batch`), signed in:
   - None of `visibility`, `password`, `generate_password` sent: a protected source's output is `private` (§5.3, unchanged); otherwise the default visibility (`password` generates one, returned once on the response that created it).
   - `expires_in` not in the body: the default expiry, for protected sources too. `expires_in: null` sent: never (`400 EXPIRY_NOT_ALLOWED` for anyone whose limits don't allow it, guests included).
   - `nsfw` isn't a conversion field: an output's mark follows its source (§5.4), whatever the default says.
   - View limits aren't part of the defaults; the request may set its own (signed in only).
3. **Guests' conversions** are unchanged: `link` (or a generated password for a protected source), 21 days, no view limit.
4. **Website uploads with the session cookie get no server defaults.** The Upload page sends what it shows, and its pickers start from the defaults, so an upload that sends nothing is still `link`, never, unmarked.

### 21.4 Web

- **Settings → Uploads** (`/app/settings/uploads`, signed in, a tab after Profile; hidden for suspended accounts like Profile and Domains): **Expires** (Never when allowed, 1 hour, 1 day, 7 days, 21 days, plus the saved value when it's none of these), **Who can open it** (Anyone with the link; Password: a new one generated for each file; Only me) and **Mark uploads as adult content** (enabled when `nsfw_allowed`). **Save defaults** sends the three fields; "Upload defaults saved." or the field's error, as the other tabs.
- **Upload page:** signed in, the pickers start from the defaults (a non-preset expiry as a custom date that far away; Password with Generate on; the adult mark only when allowed). Changing one stops following them, as before.
- **Convert page:** under the options, **New file** shows the Upload page's pickers (`UploadOptions` with `conversion`): Expires, Who can open it, the password (typed or generated; no "Stay unlocked for" or "Password works until", which §10.3 doesn't take), and the view limit for signed-in callers. No adult-content checkbox. Guests: Anyone with the link or Password, 1 hour to 21 days, no view limit.
  - They start from what the API would do: a protected source's output as Only me (signed in) or a generated password (guests), else the upload defaults (signed in) or a link for 21 days (guests). A batch starts protected when every file is, and says when some files' outputs will stay private; "One PDF" starts protected when any image is.
  - **Untouched, the request carries no output fields**, so the API's rules stay the single source of truth. Once one changes, it carries all of them as shown: `visibility`, `expires_in` (`null` for never), `password` or `generate_password`, and `view_limit` with `view_limit_action` when set.
  - The result card shows a generated password once, and keeps it while the conversion is polled (the `GET` answers don't carry it).
- **Create key dialog:** "Files expire after" and "Who can open them" start at **Account default** (an explicit "Anyone with the link" is offered too), with a link to Settings → Uploads.
- The mock API (`npm run dev`) keeps the defaults per account and applies them to key uploads and conversions the same way.

### 21.5 Tests

- API (`tests/test_upload_defaults.py`): the round trip and partial updates; each validation error; the limits re-check (a stored value past a lowered `max_expiry`, and stored junk, fall back); conversions using the defaults (a protected source still `private`, request fields winning, `null` as never, no NSFW, one password per batch); guests unchanged; key uploads (single and chunked) using the defaults with request fields winning and `url_with_password`; session uploads unaffected.
- Web: the Settings tab (save, a non-preset value, a field error); the pickers' defaults and their fallbacks; the Upload page starting from them; the Convert page's output pickers (untouched sends nothing; changed sends the fields; batches; guest limits; protected sources; the password kept while polling); the mock API.
