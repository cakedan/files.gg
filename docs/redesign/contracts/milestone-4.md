# Milestone 4 contract (trust & safety)

This is the shared contract between `api/`, `cf-worker/` and `web/` for Milestone 4. It covers:
- the `scan` job and publication gating: nothing new is served until it passes;
- CSAM hash matching (PhotoDNA behind a vendor-neutral interface) and what happens on a match;
- NSFW classification and labelling;
- malware and abuse checks beyond `api/utils/filetypes.py`;
- the report system, notices and appeals;
- moderation: staff, the admin queue, actions and the audit log;
- what the Worker, the viewer and the dashboard do with all of it.

The design behind each item is in [`../PLAN.md`](../PLAN.md) ("Accepted file types", "Hardening cdn.files.gg", "Trust & safety", Phase 3 "My reports" and "Notices", Phase 5 "Safety gates before launch", §4 items 6–8). This file pins the **exact formats**. When this file and the plan disagree, this file wins for Milestone 4. Fix the plan afterwards. Everything in [`milestone-3.md`](milestone-3.md) (and what it keeps of [`milestone-2.md`](milestone-2.md)) still holds unless it's changed here.

**This is an engineering contract, not legal advice.** Every legal step is a checklist item in §15, not code. Get legal advice before launch (PLAN.md §4 item 8).

**Not in Milestone 4:**
- the download interstitial and its `?d=` tokens, the hot-file circuit breaker and the new-account limits (PLAN.md "Hardening" part E);
- the archive file-tree viewer, Markdown, CSV, JSON and font viewers;
- Web Push, "Translate" and server-side canned responses;
- `abuse@` creating reports automatically (the mailbox is forwarded to staff, §15);
- automatic CyberTipline submission (child-safety staff file reports by hand and record them, §3.6);
- StopNCII, TCAP and GIFCT integrations (the `HashMatcher` interface leaves room for them);
- video hashing (TMK+PDQF), matching videos inside archives, and matching images embedded inside PDFs;
- third-party malware feeds and lookups: ClamAV uses its official signatures only (§5.2). abuse.ch's MalwareBazaar hash lookups and URLhaus signatures (through `fangfrisch`) are candidates for later (§5.6 "Future: abuse.ch"), and Sanesecurity's feeds aren't planned;
- the `users` table redesign (Milestone 6). Staff get their own table (§9.1).

---

## Decisions made in this contract

The plan left these open. Each is marked **(chosen: …)** where it appears. Review them before building.

1. **Where state lives:** scan state is per content (`file_hashes`), moderation state is per file and per album, and NSFW is computed from both (§1, §4.4).
2. **Every new hash is gated,** not only images, video and archives (§2.1).
3. **Strict order `scan` → `probe` → `derive`.** Nothing reads a blob for metadata or previews before it passes (§2.1).
4. **Queues and services:** `scan` gets its own queue and a dedicated `scanner` service, and rescans get a `rescan` queue and a `rescanner` service, so a slow derive or a rescan backlog never delays a new upload's scan (§2.2).
5. **Unscanned files:** the shell renders a `pending` state (200, `no-store`, auto-reload) and the CDN answers `404 no-store`. Hidden and removed are `410`. CSAM-blocked content looks exactly like a missing file (`404`) (§2.4).
6. **Rejections after upload** of anonymous files (NSFW, encrypted archive, malware, blocked types) soft-delete the file with a `deleted_reason`, and the owner's `GET` returns `410 UPLOAD_REJECTED { reason }` (§2.5).
7. **Fail closed, with one exception:** Web Risk is supplementary and fails open (recorded as `skipped`). Everything else keeps the file `pending` and retries forever through a sweeper (§2.6).
8. **Rescans:** ClamAV at +24 h and +7 d for non-media kinds (and Web Risk at +24 h when it was `skipped`); CSAM re-matching at +7 d for images, video and animated files; anything else only when an admin triggers it. There's no automatic detection of "high-severity signature updates" (§2.7).
9. **Staff are a new `staff` table** (role `moderator` or `admin`, plus a `child_safety` capability), granted with a CLI, instead of a `users.flags` bit (§9.1).
10. **Staff see protected and removed media through a CDN `staff:` grant** valid for 10 minutes, never for CSAM-blocked content (§3.6, §10.3).
11. **NSFW model (decided 2026-11-25):** Marqo `nsfw-image-detection-384` (ViT-Tiny at 384 px, Apache-2.0 for code and weights), exported once to ONNX with `timm` and `torch.onnx` in a pinned build step, run with ONNX Runtime on CPU inside the sandboxed child (on Python 3.14 until `onnxruntime` ships Python 3.15 wheels). Score = the model's NSFW probability, maximum over the classified images. Automatic mark at **≥ 0.85** as the starting value, re-picked on a labelled set before launch, with no review band (§4).
12. **NSFW `link` files never redirect to the CDN** from `files.gg/<vanity>`, for any user agent (§10.1).
13. **What's matched:** images; animated files (8 frames); video (1 frame per 10 s, 8 to 32 frames); audio cover art; the first 3 pages of PDFs; up to 100 images (≤ 20 MiB each) inside unencrypted archives, at nesting depth ≤ 1 (§2.3).
14. **PDQ near-matches** (distance ≤ 31, quality ≥ 50) against blocked content **hold** the file for review. They never count as a confirmed CSAM match on their own (§3.5).
15. **An image or video that can't be decoded for matching** is served download-only (`serve_inline: false`), never inline (§2.3).
16. **ClamAV:** every detection blocks, except `PUA.*` and `Heuristics.*`, which flag for review. YARA rules are loaded by `clamd` itself. **(decided 2026-11-25)** Signatures are ClamAV's official databases only, through `freshclam`; no third-party feeds in Milestone 4 (§5.2, §5.6).
17. **Archive bombs:** a declared unpacked total over 20 GiB, or a ratio over 1000:1, blocks the archive. Over 10,000 entries it's scanned partially and gets a warning (§5.3).
18. **Upload restrictions** mean no uploads at all. 3 upheld warnings in 90 days restrict uploads for 30 days; the next upheld warning suspends the account. 3 upheld copyright notices suspend it (repeat-infringer rule) (§8.4).
19. **Suspended accounts** can sign in and read and acknowledge their notices, nothing else (§8.4).
20. **IPs:** a stable keyed hash (HMAC, IPv6 by /64) is kept for 30 days for bans, rate limits and distinct-reporter counting. The raw uploader IP is kept **sealed to an offline key** for 30 days, only for CyberTipline reports. This needs legal review (§1, §3.6).
21. **Evidence** goes to a separate B2 bucket with Object Lock, retained 365 days (§3.6).
22. **Report link:** `files.gg/<vanity>/report` and `files.gg/a/<vanity>/report`, plus the form at `files.gg/report`. `report` becomes a reserved vanity segment (§7.2, §10.1).
23. **Cases:** reports and scanner flags are grouped into one open **case** per target. Moderators claim cases, not single reports (§9.2).
24. **Distinct reporters** are different accounts, or different fingerprints, **and** never share an IP hash (§7.4).
25. **Staff appear as "files.gg staff"** in report threads, never by name (§7.6).
26. **`GET /users/@me/badges`** replaces the plan's `GET /users/@me/reports/unread` and also carries the notices and staff counts (§8.3).
27. **Auto-hides** (P0 and report thresholds) send the owner a non-appealable "under review" notice, **except for CSAM**, which sends nothing (§8.1).
28. **A CSAM report on an album** hides the album and every item in it (§7.4).
29. **Appeals** can't be decided by the moderator who took the action while another eligible staff member exists (`SAME_MODERATOR`) (§9.4).
30. **Copyright counter-notices** go through the appeal endpoint with the statutory fields. Restoring after the waiting period is a manual staff action (§8.2).
31. **CSAM blocks can't be lifted through the API** (§9.3).
32. **The admin UI** lives at `/app/admin/*` as a lazy chunk of the dashboard. Every `/admin/*` API answers non-staff with the same 404 as an unknown route (§9, §11.3).
33. **`albums.nsfw`** becomes the explicit mark (owner or moderator). An album's payload `nsfw` is that mark **or** any shown item being NSFW (§4.4).
34. **`security.txt`** is served on both `files.gg` and `cdn.files.gg` (§10.4).
35. **Flagged links can't be opened from files.gg:** the link interstitial shows the warning and offers Copy only (§11.1).
36. **Deferred from the plan** to after Milestone 4: the download interstitial, the hot-file circuit breaker, new-account limits, Web Push, Translate, automatic `abuse@` reports, automatic CyberTipline submission, and abuse.ch hash lookups (the "Not in Milestone 4" list above). The hardening plan's part E needs its own contract before launch.

---

## 0. Ground rules

- **Fresh launch.** Milestone 3's decisions hold: no migrated data, no backward compatibility. Migration `0003_trust_safety.sql` assumes empty tables, so new `NOT NULL` columns need no backfill.
- **Protected files are scanned exactly like public ones** (PLAN.md "Not end-to-end encryption"). Visibility never changes what's scanned.
- **Errors** keep the Milestone 3 shape: `{ code: "STRING", message, status, ...details }`. Payloads are snake_case, times in epoch seconds.
- **Hash-matched CSAM is never shown to anyone,** staff included, and is never probed, derived, served or put in a ZIP.

---

## 1. Schema: `api/migrations/0003_trust_safety.sql`

One transaction. Snowflake ids are `bigint`; times are `timestamptz`; every foreign key named below is real (`ON DELETE SET NULL` for audit references, so the trail survives deletions; PLAN.md schema fix 3).

**`file_hashes` gains** (the scan is per content):

| Column | Notes |
|---|---|
| `scan_state text NOT NULL DEFAULT 'pending'` | `pending`, `passed`, `flagged`, `held` or `blocked` (§2.1). Check constraint. |
| `scan_reason text` | The reason code when `flagged`, `held` or `blocked` (§2.3). `NULL` otherwise. |
| `scan jsonb` | The last scan's results (§2.8). `NULL` until scanned. |
| `scanned_at timestamptz` | Last completed scan or rescan. |
| `next_rescan_at timestamptz` | When the next scheduled rescan is due (§2.7). `NULL` = none. |
| `nsfw_score real` | `0`–`1`, or `NULL` when nothing was classified. |
| `nsfw_auto boolean NOT NULL DEFAULT false` | `nsfw_score >= NSFW_THRESHOLD`. |
| `serve_inline boolean NOT NULL DEFAULT true` | `false` when an image or video couldn't be decoded for matching (§2.3). |

**`file_hash_pdq`** (perceptual hashes of the images that were matched):

| Column | Notes |
|---|---|
| `hash_id bigint` → `file_hashes` `ON DELETE CASCADE`, `frame integer` | Primary key together. `frame` numbers the matched images in scan order. |
| `pdq bit(256) NOT NULL`, `quality smallint NOT NULL` | Meta's PDQ hash and its quality (0–100). |

Index for the sweep: none needed while the table is small; matching is `bit_count(pdq # $1) <= 31` (Postgres 14+).

**`files` gains:**

| Column | Notes |
|---|---|
| `moderation_state text NOT NULL DEFAULT 'visible'` | `visible`, `hidden` or `removed`. Check constraint. |
| `moderation_rule text`, `moderated_at timestamptz` | The rule (§8.1) behind the last hide or remove. |
| `nsfw_marked boolean NOT NULL DEFAULT false` | Marked by the uploader. |
| `nsfw_override text` | `nsfw` or `safe`, set by staff or by report thresholds. `NULL` = none. Check constraint. |
| `nsfw_override_source text` | `moderator` or `reports`. Non-null exactly when `nsfw_override` is. |
| `deleted_reason text` | Why `deleted_at` was set: `NULL` (owner or expiry), `moderator`, or an upload-rejection code (§2.5). |
| `uploader_abuse_ip_hash bytea` | §1 "IP hashes". Cleared after 30 days. |
| `uploader_ip_sealed bytea` | The raw IP, sealed (§3.6). Cleared after 30 days. |

**`upload_sessions` gains** `nsfw_marked boolean NOT NULL DEFAULT false`, `owner_abuse_ip_hash bytea` and `owner_ip_sealed bytea`, copied to the file at finalize.

**`albums` changes:**
- `nsfw` now means **marked** (by the owner or staff), not derived (§4.4). Adds `nsfw_source text` (`owner` or `moderator`, non-null exactly when `nsfw` is true).
- Adds `moderation_rule text`, `moderated_at timestamptz` (`moderation_state` already exists).
- Adds `link_warnings text[] NOT NULL DEFAULT '{}'` (Web Risk hits in its title, description and captions, §5.7).

**New tables:**

| Table | Columns |
|---|---|
| `blocked_hashes` | `id` identity PK; `blake2b`, `sha1`, `md5 text NOT NULL`, `UNIQUE (blake2b, sha1, md5)`; `size bigint`; `reason text` (`csam`, `ncii`, `terrorism`, `malware`, `moderator`); `source text` (`photodna`, `standin`, `staff`, `clamav`); `action_id` → `moderation_actions`; `created_at`. Survives blob garbage collection, so re-uploads stay blocked. |
| `blocked_hash_pdq` | `blocked_hash_id` → `blocked_hashes` `ON DELETE CASCADE`, `frame`, `pdq bit(256)`, `quality smallint`. PK (`blocked_hash_id`, `frame`). |
| `staff` | `user_id` PK → `users` `ON DELETE CASCADE`; `role text` (`moderator`, `admin`); `child_safety boolean NOT NULL DEFAULT false`; `granted_by` → `users` `SET NULL`; `granted_at`. |
| `moderation_cases` | `id`; `kind text` (`file`, `album`, `user`, `hash`, `bug`, `appeal`); `priority smallint` 0–3; `status text` (`open`, `closed`); one target FK: `file_id`, `album_id`, `user_id`, `hash_id` (`SET NULL`), or `warning_id` → `user_warnings` for appeals; `child_safety boolean` (only child-safety staff see it); `needs_second_review boolean`; `assignee_id` → `users` `SET NULL`; `claimed_at`; `outcome text` (`actioned`, `dismissed`); `outcome_reason text`; `cybertip_report_id text`, `cybertip_filed_at` (§3.6); `created_at`, `updated_at`, `closed_at`. **Partial unique indexes:** one `open` case per (`kind`, target). |
| `reports` | As PLAN.md "Report system", with real FKs: `id`; `kind` (`file`, `album`, `user`, `bug`); `file_id` / `album_id` / `user_id` (CHECK: exactly one for file, album and user, none for bug); `album_part text` (`whole`, `title`, `description`, `captions`; album reports only); `reason`; `priority`; `status` (`open`, `resolved`, `dismissed`); `reporter_user_id` → `users` `SET NULL`; `reporter_fingerprint bigint`; `reporter_abuse_ip_hash bytea`; `contact_email text`; `details text` (≤ 2,000); `dmca jsonb` (§7.3); `case_id` → `moderation_cases`; `resolution_action text`; `reopen_count smallint NOT NULL DEFAULT 0`; `created_at`, `updated_at`, `resolved_at`, `reopened_at`, `closed_at`. |
| `report_messages` | `id`; `report_id` → `reports` `CASCADE`; `author_user_id` → `users` `SET NULL`; `is_staff boolean`; `body text` (≤ 2,000); `created_at`. |
| `report_reads` | `report_id` → `reports` `CASCADE`, `user_id` → `users` `CASCADE`, `last_read_at`. PK (`report_id`, `user_id`). |
| `content_flags` | `id`; `hash_id`, `file_id`, `album_id` (`SET NULL`); `source text` (`scan`, `rescan`, `reports`, `owner`); `reason text` (§2.3 codes, or a report reason); `details jsonb`; `case_id`; `created_at`, `resolved_at`. |
| `moderation_actions` | The audit log (§9.5). `id`; `actor_user_id` → `users` `SET NULL`; `actor_kind text` (`staff`, `system`, `cli`); `action text`; `rule text`; targets `file_id`, `album_id`, `user_id`, `hash_id`, `report_id`, `case_id`, `warning_id` (all `SET NULL`); `note text` (staff-only); `details jsonb`; `reverses_action_id` → `moderation_actions`; `created_at`. Append-only: the app never updates or deletes rows. |
| `user_warnings` | The notices (§8). `id`; `user_id` → `users` `CASCADE`; `action_id` → `moderation_actions`; `rule`; `message text`; `target jsonb` (snapshot: `{ kind, id, vanity?, name? }`); `appealable boolean`; `counts_as_strike boolean`; `acknowledged_at`; `appeal_state text` (`none`, `open`, `granted`, `denied`); `appeal_message text`; `appeal_counter_notice jsonb`; `appealed_at`, `appeal_decided_at`; `created_at`. |
| `user_restrictions` | `id`; `user_id` → `users` `CASCADE`; `kind text` (`uploads`, `suspended`); `rule`; `action_id`; `starts_at`; `ends_at` (`NULL` = until lifted); `lifted_at`; `lifted_by_action_id`. |
| `bans` | `id`; `fingerprint bigint` **or** `abuse_ip_hash bytea` (CHECK: exactly one); `rule`; `action_id`; `created_at`; `expires_at` (`NULL` = until lifted); `lifted_at`. |
| `safety_rate_limits` | `scope text` (`report`, `report_message`), `key text` (`user:<id>`, `fp:<fingerprint>` or `ip:<hex hash>`), `window_start`, `count`. PK (`scope`, `key`, `window_start`). Like `unlock_attempts`; windows older than an hour are deleted. |
| `evidence_holds` | `id`; `case_id`; `hash_id` (`SET NULL`); `blake2b`, `sha1`, `md5`, `size`; `bucket text` (`files` or `evidence`); `storage_key text`; `reason text` (`csam`, `moderator`); `retain_until`; `snapshot jsonb` (§3.6); `created_at`; `released_at`. |

**Blob garbage collection** (`jobs/gc.py` `delete_blob`) skips a hash while an `evidence_holds` row with `bucket = 'files'`, `released_at IS NULL` and `retain_until > now()` references it.

**IP hashes.** The daily-key IP hash from Milestone 2 can't support bans (its key is gone after a day). Trust & safety uses a stable keyed hash:

```
abuse_ip_hash = HMAC-SHA256( ABUSE_HASH_SECRET, "filesgg-abuse-ip-1" + "\n" + normalize(ip) )

normalize(ip): IPv4-mapped IPv6 → the IPv4 address; IPv4 → dotted quad;
               IPv6 → its /64 network, compressed lowercase ("2001:db8::/64")
```

Stored for uploads (`uploader_abuse_ip_hash`) and reports (`reporter_abuse_ip_hash`), cleared after **30 days** (`ABUSE_IP_KEEP_DAYS`), kept in `bans` while the ban lasts. Test vectors in §14.

---

## 2. Scanning pipeline and publication gating

### 2.1 States and order

`file_hashes.scan_state`:

| State | Meaning | Public? | Next |
|---|---|---|---|
| `pending` | Not scanned yet, scanning, or retrying | **No** | `passed`, `flagged`, `held` or `blocked` |
| `passed` | Every check ran and found nothing | Yes | Rescans may move it to `flagged`, `held` or `blocked` |
| `flagged` | Public, with a finding for staff to review (§2.3) | Yes | Staff: `passed` (clear) or `blocked` |
| `held` | Not public until staff decide (a PDQ near-match, §3.5) | **No** | Staff: `passed` or `blocked` |
| `blocked` | Never served | **No** | Staff: `passed` (not for CSAM, §9.3) |

- **(chosen: every new hash is gated)**, whatever its type. One rule is easier to get right than a list of types.
- **(chosen: strict order)** `scan` → (`passed` or `flagged`) → `probe` → `derive`. `probe` and `derive` refuse to run unless `scan_state` is `passed` or `flagged`, as a second guard. A hash that's `held` and later cleared gets its `probe` queued then.
- `finalize_upload` and the single-request path queue **`scan`** for a new hash where they queued `probe` in Milestone 3.

### 2.2 The `scan` job

- **Payload:** `{ "hash_id": "<id>" }`. Keyed by hash, never by file. Enqueued with `NOT EXISTS` deduplication (one runnable `scan` per hash), like `album_collage`.
- **Queue:** `scan`. **(chosen: a dedicated `scanner` service)** in `docker-compose.yml`, from the `worker` image target, with `WORKER_QUEUES=scan`. Rescans (`rescan` jobs, §2.7) run on the `rescan` queue in a `rescanner` service with `WORKER_QUEUES=rescan`. The existing `worker` keeps `default,media`. The queue claims across its queues by `run_at`, and a worker runs one job at a time, so sharing a process would let a 90 s derive or a rescan backlog delay a new upload's scan.
- **Max attempts:** 10, with the queue's normal backoff. The sweeper (§2.6) takes over after that.
- **Split** (as Milestone 3's media jobs):
  - **the sandboxed child** (`python -m media.process scan <input> <outdir> <hints>`): everything that parses the upload. It sniffs the type, decodes images and frames, writes the images to be matched as JPEG files into `<outdir>`, computes PDQ, runs the NSFW model, lists archives, checks Office files and PDFs, and extracts URLs. It has no secrets and makes no network calls;
  - **the job process:** everything that talks to a service: `blocked_hashes`, the `HashMatcher` (§3), ClamAV (§5.2) and Web Risk (§5.7). Then it writes the results in one transaction.
- **Sandbox limits for `scan`:** wall clock **120 s**, CPU **90 s**, address space **2 GiB** (ONNX Runtime needs more than 1.5 GiB of address space), no core files. The rest is Milestone 3's sandbox (`-protocol_whitelist file,pipe`, the demuxer whitelist, Pillow's bomb limit, no ImageMagick).
- **Child output** (the last JSON line on stdout):

```json
{
  "sniffed": "image/jpeg",
  "decodable": true,
  "images": [{ "file": "m-000.jpg", "frame": 0, "source": "image", "at_ms": null, "width": 1024, "height": 768 }],
  "pdq": [{ "frame": 0, "hash": "<64 hex>", "quality": 92 }],
  "nsfw": { "score": 0.031, "classified": 1, "model": "marqo-vit-tiny-384@3f9a1c2e" },
  "archive": null, "office": null, "pdf": null, "polyglot": [],
  "urls": []
}
```

`source` is `image`, `frame`, `cover`, `pdf_page` or `archive_entry`. `archive`, `office` and `pdf` are §5's findings, or `null` when not applicable.

### 2.3 What `scan` checks, by kind

The child decides by **every type the bytes or the name say it is**: the libmagic-sniffed type, the declared mimetype and the extension. A polyglot is checked as each type it parses as (§5.5).

| Kind | Matched against CSAM lists (§3) | NSFW (§4) | Malware checks (§5) | URLs (§5.7) |
|---|---|---|---|---|
| Image (including HEIC, TIFF, PSD) | the image | the image | ClamAV | — |
| Animated (gif, apng, animated webp) | 8 frames, evenly by index | the same frames | ClamAV | — |
| Video | **1 frame per 10 s, at least 8, at most 32**, evenly spaced (ffmpeg seeks) | 8 of those, evenly spaced | ClamAV (≤ 512 MiB) | — |
| Audio | the embedded cover art, if any | the cover art | ClamAV | — |
| PDF | renders of the first 3 pages (`pdftoppm`, fit 1024×1024) | the same renders | ClamAV, PDF checks | from `/URI` actions and the text |
| Office (OOXML, OLE) | — | — | ClamAV, Office checks | — |
| Archive | up to **100 image entries**, ≤ 20 MiB each, at depth ≤ 1, not encrypted | — | ClamAV, archive checks | — |
| Text | — | — | ClamAV | from the text (first 1 MiB) |
| Other | — | — | ClamAV | — |

- **(chosen: those frame counts and limits; see Decisions 13.)** Images are sent to matchers downscaled to fit **1024×1024**, re-encoded as JPEG quality 90.
- **Undecodable media:** if neither Pillow nor ffmpeg can decode an image or video for matching, nothing is matched, the result is `decodable: false`, and **(chosen)** the hash gets `serve_inline = false`: the CDN serves it only as `attachment`, and the payload's `kind` becomes `file` (§6.1). Browsers that can render what our decoders can't are the gap this closes.
- **Reason codes** (`file_hashes.scan_reason`), with the outcome each causes:

| Code | Outcome | Cause |
|---|---|---|
| `csam_match` | `blocked` | The `HashMatcher` matched (§3.6) |
| `hash_list` | `blocked` | Exact match in `blocked_hashes` (any reason) |
| `pdq_near_match` | `held` | PDQ near-match against `blocked_hash_pdq` (§3.5) |
| `malware` | `blocked` | ClamAV detection (not PUA or heuristic) |
| `unwanted_software` | `flagged` | ClamAV `PUA.*` or `Heuristics.*` |
| `blocked_type` | `blocked` | A blocked type found by sniffing, inside an archive, or as an Office macro (§5.1, §5.3, §5.4) |
| `archive_bomb` | `blocked` | §5.3 thresholds |
| `pdf_dangerous` | `blocked` | `/Launch`, `/RichMedia`, or an embedded file of a blocked type (§5.5) |
| `pdf_javascript` | `flagged` | `/JavaScript`, `/JS`, `/OpenAction` or `/AA` (§5.5) |
| `polyglot_archive` | `flagged` | An image or PDF with an archive appended (§5.5) |
| `web_risk` | `flagged` | A Web Risk hit on an extracted URL (§5.7) |

When several apply, the strongest wins (`blocked` > `held` > `flagged`), and the code is the first in the table's order. Every finding is still recorded in `scan` (§2.8).

### 2.4 What everyone sees, per state

The API computes one **effective file state** (first match wins). Owner payloads show it as `safety.state` (§6.2). The Worker's internal lookup carries a reduced form (§6.3).

| # | Condition | `safety.state` | Lookup `safety.state` |
|---|---|---|---|
| 1 | `scan_state = 'blocked'` | `blocked` | `blocked` |
| 2 | `files.moderation_state = 'removed'` | `removed` | `removed` |
| 3 | `files.moderation_state = 'hidden'` | `hidden` | `hidden` |
| 4 | `scan_state = 'held'` | `hidden` (reason `review`) | `hidden` |
| 5 | `scan_state = 'pending'` | `pending` | `pending` |
| 6 | `scan_state = 'flagged'` | `flagged` | `ok` |
| 7 | otherwise | `ok` | `ok` |

**Surfaces** (staff grants, §10.3, are separate):

| Lookup state | Viewer shell (`files.gg/<vanity>`) | CDN file and previews | Public API (`GET /files/<vanity>`) | Albums and ZIP | Owner (dashboard) |
|---|---|---|---|---|---|
| `ok` | as today (plus NSFW, §4.6) | as today | the payload | shown | normal |
| `pending` | **`pending`**, 200, `private, no-store` | `404`, `private, no-store` | `409 FILE_PENDING { retry_after: 5 }` | not shown | "Checking…" badge; bytes not served |
| `hidden` | **`removed`**, reason `review`, **410** | `410`, `private, no-store` | `410 FILE_REMOVED { reason: "review" }` | not shown | "Hidden" badge, notice |
| `removed` | **`removed`**, **410** | `410`, `private, no-store` | `410 FILE_REMOVED { reason }` | not shown | "Removed" badge, notice |
| `blocked` | `missing`, **404** | `404` | `404 UNKNOWN_FILE` | not shown | "Blocked" badge, notice (signed in, not CSAM) |

- **Access still comes first.** A `private` file is `missing` for everyone but its owner, whatever its state. On the CDN the access check (signature) runs before the state check, so a protected file's state never leaks to someone without access.
- **Public `reason`** on removed pages: `review` (hidden or held), `copyright` (rule `copyright`), `malware` (rules `malware` and `phishing`, and scan blocks shown as removed), otherwise `terms`.
- **Wait times** (targets, not promises): images and audio ≤ 3 s at p95 after the blob is stored; PDFs and archives ≤ 10 s; video ≤ 60 s for 1 GiB. A hash still `pending` after **10 minutes** (`SCAN_STALLED_AFTER`) counts as stalled (§2.6).
- **The owner can't view the bytes while pending,** as the plan says ("uploader included"). The owner payload still has the metadata and URLs; the CDN refuses them until the state is `ok`.

### 2.5 New uploads of known content, and rejections

At file creation (single-request upload before the blob is stored, or `finalize_upload` before the `File` row), after the existing type checks:

1. **`blocked_hashes` has the triple** → refuse. A `csam` entry gives `403 FILE_BLOCKED` and also runs the uploader steps of §3.6 (restriction, bans, a P0 case with the attempt's metadata; the bytes are already preserved). Other reasons give `403 FILE_BLOCKED`, or `400 MALWARE_DETECTED` for `malware`. Nothing is stored.
2. **Known hash, `scan_state = 'blocked'`** → the same as 1, by its `scan_reason`.
3. **Anonymous uploader, known hash with `nsfw_auto`** (or the upload has `nsfw=true`) → `403 NSFW_REQUIRES_ACCOUNT`. Nothing is stored.
4. **Anonymous uploader, known hash whose scan has the `encrypted_archive` warning** → `403 ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT`.
5. **Banned fingerprint or IP hash** (§9.3), or a signed-in user with an `uploads` or `suspended` restriction → `403 BANNED`, `403 UPLOADS_RESTRICTED { until }` or `403 ACCOUNT_SUSPENDED`. Checked first, before reading the body where possible.
6. Otherwise the file is created. A known `passed` or `flagged` hash is public at once; `pending` stays pending and queues nothing new.

For a chunked upload, 1–4 at finalize fail the session with `error` set to the code (`GET /uploads/<id>` shows it, as for `FILE_TYPE_NOT_ALLOWED` today).

**Rejections after the fact (chosen).** When a scan finishes, per file of the hash:
- **Anonymous files** that are now `blocked`, or `nsfw_auto`, or have the `encrypted_archive` warning: soft-deleted at once with `deleted_reason` = `FILE_BLOCKED`, `MALWARE_DETECTED`, `FILE_TYPE_NOT_ALLOWED`, `NSFW_REQUIRES_ACCOUNT` or `ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT`. The normal delete path runs (album removal, `delete_blob` when it was the last reference; holds still apply).
- **Signed-in files** keep their row. `blocked` shows as such with a notice (§8), except CSAM.
- **`GET /users/@me/files/<id>`** for a file deleted with a rejection code answers `410 UPLOAD_REJECTED { reason: "<code>" }` for **24 hours**, then `404 UNKNOWN_FILE`. The upload page uses this (§11.2).

### 2.6 Failing closed

- **Required checks** (a failure keeps the hash `pending` and the job retries): `blocked_hashes`, the `HashMatcher` (when the kind is matched), PDQ, the NSFW classifier (when the kind is classified), ClamAV, archive, Office and PDF checks.
- **The one optional check (chosen: fail open):** Web Risk (§5.7). If it's unconfigured, times out or errors, the result is `skipped` with an `error`, and the scan can still pass. The +24 h rescan tries it again (§2.7). Milestone 4 has no other supplementary checks (§5.6).
- **Matcher errors:** `MatcherUnavailable` (network, 5xx, 429, timeouts) is a retry. Anything the matcher can't accept (for example an image below its minimum size) is `unmatchable` for that image, which doesn't fail the scan.
- **The sweeper** (`scan_sweeper`, scheduled every **5 minutes**): re-queues every `pending` hash with no runnable `scan` job (its job failed after 10 attempts, or was lost). So a hash is retried until it's resolved; it's never published by giving up.
- **Stalled scans:** hashes `pending` for over 10 minutes are counted in `GET /admin/summary` (`scans_stalled`), and admin pages show a banner while it's above 0 (§11.3). No case is opened per file.

### 2.7 Rescans

A **`rescan`** job: `{ "hash_id": "<id>", "checks": ["clamav", "csam", "pdq", "web_risk"] }` on the `rescan` queue. It runs only the named checks, then applies outcomes like a scan, with two differences:
- it can only **escalate** (`passed` → `flagged`, `held` or `blocked`; `flagged` → `held` or `blocked`). It never returns a hash to `pending`, and a signature or finding that staff cleared (§9.3) is ignored;
- a newly `blocked` or `held` hash that was public opens a case (§9.2), notifies owners (§8), clears album collages that used it (§6.4), and for `csam_match` runs §3.6.

**When (chosen):**

| Trigger | Checks | Applies to |
|---|---|---|
| `next_rescan_at`: +24 h, then +7 d after the first scan, then `NULL` | `clamav`; at +24 h also `web_risk` when the last one was `skipped` | live hashes whose kind isn't image, video, audio or animated |
| `next_rescan_at`: +7 d after the first scan, then `NULL` | `csam`, `pdq` | live images, animated files and videos |
| A `blocked_hashes` row with PDQs is added | `pdq` (database only, no blob reads: a `pdq_sweep` job compares the new PDQs with `file_hash_pdq`) | every hash |
| A malware report on a file (§7.4) | `clamav`, queued at once | that hash |
| `POST /admin/rescans` (§9.6) | any | filtered by kind and upload date |

"Live" means at least one file with `deleted_at IS NULL`. The `rescan_scheduler` (every 10 minutes) queues due rescans, at most 1,000 per run, with `run_at` spread over the next 10 minutes.

### 2.8 `file_hashes.scan` (per-hash results)

```json
{
  "version": 1,
  "at": 1795603600,
  "sniffed": "application/zip",
  "decodable": true,
  "checks": {
    "hash_list":     { "result": "clean" },
    "csam":          { "result": "clean", "matcher": "photodna", "images": 12, "unmatchable": 0 },
    "pdq":           { "result": "clean", "frames": 12 },
    "nsfw":          { "result": "done", "score": 0.12, "classified": 8, "model": "marqo-vit-tiny-384@3f9a1c2e" },
    "clamav":        { "result": "clean", "engine": "1.5.5", "db": "daily 27512" },
    "archive":       { "result": "clean", "entries": 120, "partial": false, "encrypted": false, "depth": 1 },
    "office":        { "result": "skipped" },
    "pdf":           { "result": "skipped" },
    "web_risk":      { "result": "skipped" }
  },
  "findings": [{ "check": "clamav", "code": "unwanted_software", "detail": "PUA.Win.Packer.Upx-1" }],
  "cleared": [],
  "warnings": ["encrypted_archive"],
  "link_warnings": []
}
```

- `result` is `clean`, `match` (csam, pdq, hash_list), `detected` (clamav), `flag`, `block`, `done` (nsfw), `skipped` (not applicable, or an optional check that didn't run, with `error`) or `error` (only while retrying).
- **CSAM matches record no vendor details here.** Only `"result": "match"`; the details go to the case and the evidence hold (§3.6).
- `warnings` (shown to visitors, §6.1): `encrypted_archive`, `archive_partially_scanned`, `unwanted_software`, `too_large_to_scan` (a non-media blob over `CLAMAV_MAX_BYTES`; signed-in only, since anonymous files are ≤ 25 MB).
- `link_warnings`: at most 20 flagged URLs (§5.7).
- `cleared`: findings staff cleared, as `{ check, detail }`, ignored by rescans.

---

## 3. CSAM hash matching

PhotoDNA was chosen on 2026-11-25 (PLAN.md §4 item 7), built behind a vendor-neutral interface. **Cloudflare's CSAM Scanning Tool is on regardless** (§15). Never build a detector or train anything on such material.

### 3.1 The `HashMatcher` interface (`api/safety/matchers/__init__.py`)

```python
@dataclass(frozen=True)
class MatchImage:
    frame: int                 # the scan's frame number (file_hash_pdq.frame)
    source: str                # image | frame | cover | pdf_page | archive_entry
    jpeg: bytes                # fit 1024x1024, JPEG q90, made by the sandboxed child
    width: int
    height: int

@dataclass(frozen=True)
class MatchHit:
    frame: int
    list_id: str | None        # the vendor's list or source name, if it gives one
    vendor_ref: str | None     # the vendor's tracking id for this request

@dataclass(frozen=True)
class MatchOutcome:
    matcher: str               # 'photodna' | 'standin'
    hits: list[MatchHit]       # empty = no match
    unmatchable: list[int]     # frames the vendor refused as input (too small, ...)
    vendor_refs: list[str]     # every tracking id, matched or not, for the evidence record

class MatcherUnavailable(Exception): ...   # retry; the hash stays pending

class HashMatcher(Protocol):
    name: str
    def match(self, images: Sequence[MatchImage]) -> MatchOutcome: ...
```

- **Selected by `CSAM_MATCHER`** (`photodna` or `standin`). It's required in `docker-compose.yml` (`${CSAM_MATCHER:?}`). **`standin` refuses to start unless `FILESGG_DEV_TOOLS=1`**, so production can't run without a real matcher by accident.
- The matcher is called from the job process, never from the sandboxed child. It never receives filenames, user ids or anything but the images.
- Another vendor (Thorn Safer, StopNCII, TCAP) is another implementation; several can run in sequence later (any hit is a match).

### 3.2 PhotoDNA adapter (`api/safety/matchers/photodna.py`)

**Checked 2026-11-25 against Microsoft's public pages. The API reference itself isn't public:** it's in the API Management developer portal (`developer.microsoftmoderator.com`), which only onboarded subscribers can use. So the request and response shape below is **corroborated, not confirmed**. It matches independent client code that calls the live service, but no Microsoft document says it. **Confirm every field, limit and status code in the portal** before relying on it, and record the confirmed version here.

What Microsoft's public pages confirm ([Cloud Service](https://www.microsoft.com/en-us/photodna/cloudservice), [FAQ](https://www.microsoft.com/en-us/photodna/faq), [Documentation](https://www.microsoft.com/en-us/photodna/documentation), [Terms of use](https://www.microsoft.com/en-us/photodna/termsofuse), last updated May 2018):

| | |
|---|---|
| **Access** | Apply with the form at `https://myphotodna.microsoftmoderator.com/Profile`. A third-party vetting service reviews each application case by case, and approval is at Microsoft's sole discretion. Intended for online service providers hosting user-generated content, not law enforcement. API keys are issued after vetting. |
| **Cost** | Free for qualified organisations, with "a limited number of transactions per month". The terms say high-volume use is charged as Azure Content Moderator transactions. Content Moderator retires on 2027-03-15 ([notice](https://azure.microsoft.com/updates/azure-content-moderator-retirement/)); the terms say PhotoDNA isn't an Azure service, and no PhotoDNA retirement is announced. Ask about both when onboarding. |
| **Terms** | A 30-day subscription term (renewal isn't described). Internal use only: it can't be resold as a managed service. Only for stopping child sexual abuse material. Microsoft may throttle, monitor and audit use, and sends NCMEC aggregate reports that name the customer; this doesn't replace files.gg's own reporting duty. No support and no SLA. |
| **Auth** | A subscription key from the portal. The page doesn't name the header. |
| **Privacy** | "This service does not store customer images at any time" (FAQ). |
| **Not published** | The endpoint, the header name, request and response fields, status codes, image size and format limits, and the monthly transaction allowance or rate limit. |

| Config | Default | Notes |
|---|---|---|
| `PHOTODNA_SUBSCRIPTION_KEY` | (required with `CSAM_MATCHER=photodna`) | Sent as `Ocp-Apim-Subscription-Key`. Corroborated: it's the Azure API Management default header, the portal runs on API Management, and independent clients use it. |
| `PHOTODNA_MATCH_URL` | `https://api.microsoftmoderator.com/photodna/v1.0/Match` | Corroborated by independent clients, which also use regional hosts (for example `uk-api.microsoftmoderator.com`). Configurable so a corrected URL needs no deploy. |
| `PHOTODNA_TIMEOUT` | `10` (s) | Per request. |
| `PHOTODNA_MAX_RPS` | `5` | Client-side rate limit per scanner process. The real quota and monthly allowance aren't published; set this from what the portal says. |

- **Request (corroborated):** `POST <PHOTODNA_MATCH_URL>?enhance=<bool>`, `Content-Type: image/jpeg` (independent clients also send `image/png`, `image/gif` and `image/bmp`), the image bytes as the body. One request per `MatchImage`. What `enhance` does isn't public; independent clients send `true`. Confirm it in the portal and default to what Microsoft recommends.
- **Response (corroborated):** JSON with `Status` (`Status.Code`; 3000 is success, which no public source confirms), `IsMatch` (boolean), `MatchDetails.MatchFlags[]` (each with `Source`, for example a hotline or list name, and `Violations[]`, its categories) and `TrackingId`.
- **Mapping:** success with `IsMatch: true` → a `MatchHit` (`vendor_ref` = `TrackingId`, `list_id` = the `Source` values in `MatchDetails.MatchFlags`, joined with `,` in their order, for example `NCMEC,IWF`). Success with `false` → no hit. A documented "invalid image" status (for example too small; the minimum size isn't published) → `unmatchable`. Any other status, a timeout, a 429 or a 5xx → `MatcherUnavailable`.
- **Hash-only mode:** PhotoDNA can also be licensed as a library that hashes locally and matches hashes, so images never leave files.gg. Microsoft's public pages mention on-premise licensing only for law enforcement (through `pdnasup@microsoft.com`), so this option for a service provider is unconfirmed. If access comes with that option, it's a second adapter (`photodna_hash`) behind the same interface. Which one is used is decided with Microsoft.
- **Privacy:** images are sent to Microsoft. The Privacy policy must say so (§15).

### 3.3 The stand-in matcher (`api/safety/matchers/standin.py`)

For tests and local dev only, until PhotoDNA access is approved. It never uses real material.

- **List:** `STANDIN_MATCH_FILE` (default `api/tests/fixtures/standin/match-list.txt`): one entry per line, `#` comments allowed:
  - `blake2b:<hex>`: matches when the scanned blob's blake2b is this value (all its images are hits, frame 0 first);
  - `pdq:<64 hex>`: matches a `MatchImage` whose PDQ is within distance 31 of it.
- **Fixtures:** `api/tests/fixtures/standin/` holds **generated** test images: a 512×512 image with the text "FILESGG STANDIN MATCH" on a magenta and black checkerboard (`match.png`), its 50%-scaled JPEG (`match-small.jpg`, which must match through PDQ), and a plain grey image (`clean.png`). A script (`make_fixtures.py`) regenerates them and the list.
- **`STANDIN_MODE`:** `list` (default), or `unavailable` (every call raises `MatcherUnavailable`), to test failing closed.
- `vendor_ref` is `standin-<frame>-<first 8 hex of the image's sha256>`.

### 3.4 PDQ

- Computed by the sandboxed child for every `MatchImage` with `pdqhash` (Cython bindings to Meta's reference C++ code; bindings MIT, the bundled PDQ code under Meta's own licence).
- **Packaging (checked on PyPI 2026-11-25):** the newest release, `pdqhash` 0.2.8 (2025-05-28), has wheels for macOS and Windows only, cp310 to cp313. **There are no Linux wheels for any Python, and none for 3.15,** so the worker image always builds it from the sdist. That needs `g++` in a build stage; of the build requirements, `cython` (3.3.2) and `numpy` (2.5.5) publish cp314 and cp315 manylinux wheels for `x86_64` and `aarch64`, and `setuptools` and `wheel` are pure Python. The code has nothing version-specific, but no build on 3.14 or 3.15 has been tested: the worker image build is the test. A fix for Linux wheels was merged upstream on 2026-11-23 but isn't released.
- **No maintained alternative** has wheels either: Meta's `threatexchange` and Thorn's `perception` both depend on `pdqhash`.
- **Input:** pass a C-contiguous `uint8` RGB array (`np.ascontiguousarray`). An open upstream report (pull request #12) shows 0.2.8 returning wrong hashes for non-contiguous arrays, such as transposed views.
- Stored in `file_hash_pdq` for every scanned hash, and in `blocked_hash_pdq` for hashes blocked for `csam`, `ncii`, `terrorism` or by `moderator`.
- **Hashes with quality < 50 are stored but never matched** (Meta's guidance for unreliable hashes).

### 3.5 PDQ near-matches (chosen: hold, never auto-confirm)

A scanned image within distance **≤ 31** (`PDQ_MATCH_DISTANCE`) of a `blocked_hash_pdq` row, without an exact or vendor match:
- the hash becomes `held` (`pdq_near_match`) and stays unpublished;
- a case opens: **P0 with `child_safety = true`** when the blocked entry's reason is `csam`, otherwise P1;
- staff decide with `confirm_csam` (child-safety staff, §3.6), `block_hash` or `clear_flag`.

### 3.6 On a match

Triggered by a `HashMatcher` hit (initial scan or rescan), by a re-upload of a `csam` entry in `blocked_hashes` (§2.5), or by child-safety staff confirming a report or a held file (`confirm_csam`). All steps are automatic and in this order; each is idempotent, so a retry finishes what failed.

1. **Block.** `scan_state = 'blocked'`, `scan_reason = 'csam_match'`. Every file of the hash is effectively `blocked` (§2.4), so it looks missing everywhere at once (lookups are cached for 5 s). No `probe` or `derive` runs; any derived assets (a rescan hit) are deleted from B2 and `file_hash_assets`. Album collages that used it are cleared (§6.4).
2. **Remember.** Insert `blocked_hashes` (`reason: csam`, `source: photodna | standin | staff`) with the PDQs into `blocked_hash_pdq`, then queue a `pdq_sweep`.
3. **Preserve evidence.** Server-side copy `files/<hash_id>` to the evidence bucket (`S3_BUCKET_EVIDENCE`) at `csam/<case_id>/<hash_id>`, with **Object Lock retention in compliance mode until `now + EVIDENCE_RETENTION_DAYS`** (default 365; the period is a legal question, §15). Then write `evidence_holds` (`bucket: evidence`) with the snapshot below. Only after both succeed, delete `files/<hash_id>` (all versions) from the files bucket.
4. **Restrict the uploaders.** For every file of the hash: a signed-in owner gets a `suspended` restriction (rule `csam`, no end, **no notice detail and no appeal**). Each file's fingerprint (anonymous uploads) and `uploader_abuse_ip_hash` get a `bans` row with no expiry. Every other file and album of those owners becomes `hidden` (rule `csam`) pending child-safety review.
5. **Open the case.** One `moderation_cases` row: `kind: hash`, **P0**, `child_safety = true`, with the hits' `vendor_ref`s in an action's `details`. It never carries an image URL.
6. **Record.** `moderation_actions`: `csam_match` (system), `block`, `preserve_evidence`, `suspend_user`, `ban` rows, all linked to the case.

**The evidence snapshot** (`evidence_holds.snapshot`):

```json
{
  "matcher": "photodna",
  "vendor_refs": ["…"],
  "hits": [{ "frame": 0, "source": "image", "list_id": "…" }],
  "hash": { "blake2b": "…", "sha1": "…", "md5": "…", "size": 123456 },
  "files": [{
    "id": "…", "vanity": "…", "filename": "…", "mimetype": "…", "uploaded_at": 1795603600,
    "visibility": "link", "user_id": "…" , "fingerprint": null,
    "account": { "email": "…", "username": "…", "created_at": 1795000000 },
    "abuse_ip_hash": "<hex>", "ip_sealed": "<base64>", "views": 0
  }]
}
```

`ip_sealed` is the uploader's raw IP sealed with a libsodium **sealed box** to `EVIDENCE_PUBLIC_KEY`. The private key is kept **offline** by the child-safety lead and is never on any server. Files hold the sealed IP for 30 days only (`files.uploader_ip_sealed`). **(chosen; needs legal review, §15.)**

**Staff access:**
- **Hash-matched content is never displayable.** No API returns a URL for it, no staff grant is ever signed for it, and the files bucket no longer has it.
- Its case is visible only to staff with `child_safety`. They see the snapshot minus `ip_sealed`, and the vendor references.
- **The CyberTipline report** is filed by child-safety staff, outside files.gg, through NCMEC's process once files.gg is registered (§15). They then record it: `POST /admin/cases/<id>/cybertip { "report_id": "…" }` sets `cybertip_report_id` and `cybertip_filed_at`, and logs `cybertip_filed`. `GET /admin/summary` counts child-safety cases without a recorded report.
- **Evidence access** (for a law-enforcement request) is a break-glass procedure with the evidence bucket's separate key, outside the app (§15).

**A report of CSAM** (reason `csam`) isn't a match. It hides the target at once (§7.4) and opens a P0 child-safety case. Child-safety staff can open the media there (blurred and greyscale by default, §11.3), then use `confirm_csam` (runs steps 1–6 with `source: staff`) or close it with another action.

---

## 4. NSFW classification

### 4.1 The model (chosen)

**Decided 2026-11-25: Marqo `nsfw-image-detection-384`.**

| | |
|---|---|
| **Model** | Marqo `nsfw-image-detection-384`, from Hugging Face `Marqo/nsfw-image-detection-384`: a `timm` ViT-Tiny/16 at 384×384 input, fine-tuned from `vit_tiny_patch16_384.augreg_in21k_ft_in1k`. Its head has two classes, `NSFW` and `SFW`, and the classifier uses **one number: the `NSFW` probability**. The vendor reports 98.56% accuracy on its own 20,000 held-out images (real photos, drawings, "Rule 34", memes and AI images). |
| **Licence** | Apache-2.0, for code and weights (the model card). |
| **Maintenance** | Static since 2024-11-27, published by a company (Marqo) (checked 2026-11-25). |
| **Artefact** | The source is the Hugging Face repository at a **pinned commit** (a full revision hash, never `main`): `model.safetensors` (22.4 MB, float32) and `config.json`. The export step (below) records that commit and the SHA-256 of both files, and refuses to export if a download doesn't match them. |
| **Format** | **No official ONNX file is published.** (Third-party copies aren't used.) The ONNX file is produced once by a pinned build step, `api/tools/export_nsfw_model.py`, and re-run only when the pin changes. See "Export" below. The result is **checked in** as `api/media/models/nsfw-marqo-vit-tiny-384.onnx` (about 22 MB in float32), with its preprocessing file `api/media/models/nsfw-marqo-vit-tiny-384.json` next to it. Both **SHA-256s are pinned** in `api/media/nsfw.py`, and the child refuses either file if it doesn't match. The model id in results is `marqo-vit-tiny-384@<first 8 hex of the ONNX file's SHA-256>`. |
| **Runtime** | ONNX Runtime (CPU execution provider), `intra_op_num_threads=2`, `inter_op_num_threads=1`, inside the sandboxed `scan` child. The child needs only `onnxruntime`, NumPy and Pillow; `torch` and `timm` are never imported at runtime. **No `onnxruntime` wheel exists for Python 3.15** (checked on PyPI 2026-11-25): the newest release, 1.32.0 (2026-11-13), has cp311 to cp314 wheels (plus free-threaded cp313t and cp314t), including `manylinux_2_28` for `x86_64` and `aarch64`, and no sdist. **So the worker target pins Python 3.14**, as an exception to the version policy, until a cp315 wheel ships. For scale: Python 3.14.0 was released 2025-10-07 and the first cp314 wheels came with 1.24.1 on 2026-02-05, about four months later; Python 3.15.0 was released 2026-10-09. |
| **Preprocessing** | Follows the model card and timm's data config for this model, **read from the preprocessing JSON, never hard-coded.** The JSON records `input_size`, `interpolation`, `mean`, `std`, `crop_pct` and `crop_mode` from timm's `resolve_data_config`. The child reproduces timm's evaluation transform with Pillow and NumPy: RGB; resize with that interpolation so the shorter side is `size / crop_pct`; centre-crop to `size`; scale to `[0, 1]`; normalise with `mean` and `std`; NCHW float32, batch first. (The model card describes a bicubic resize to 384×384 with mean and std 0.5; the JSON is what counts.) |
| **Speed** | Not measured. ViT-Tiny at 384 px costs more compute per image than small CNN classifiers, and a scan classifies at most 8 images. Measure the CPU time per image in the scan sandbox before launch (§15). |

**Export** (`api/tools/export_nsfw_model.py`, a build step, not part of any image):
- **Environment:** a separate virtual environment from `api/tools/export-requirements.txt`, which pins exact versions of `torch`, `timm`, `huggingface_hub`, `onnx` and `onnxruntime` with hashes (installed with `pip install --require-hashes`). That environment's Python version is whatever those pins support; it's independent of the worker's 3.14. None of this tooling is in the runtime image.
- **Steps:**
  1. Download `model.safetensors` and `config.json` at the pinned commit with `huggingface_hub`, and check both SHA-256s against the values recorded in the script.
  2. Build the model with `timm` from those files, in `eval()` mode.
  3. Read `timm.data.resolve_data_config` for the model, and find the output index of the `NSFW` label in the model's config. Stop if there's no `NSFW` label.
  4. Export with `torch.onnx.export`: opset 17, one input `pixel_values` (NCHW float32, `input_size` from the config) with a dynamic batch axis, one output `logits`. The child applies softmax and takes the `NSFW` index.
  5. Verify: `onnx.checker.check_model` passes, and on the test fixture images (§14.5), ONNX Runtime's `NSFW` probability (after the child's own Pillow and NumPy preprocessing) is within `1e-3` of PyTorch's (after timm's own transform).
  6. Write the preprocessing JSON: `input_size`, `interpolation`, `mean`, `std`, `crop_pct`, `crop_mode`, `nsfw_index`, plus provenance (the repository, the pinned commit, both source SHA-256s, the `torch`, `timm` and `onnx` versions and the opset).
  7. Print the SHA-256 of the ONNX file and of the JSON, to be pinned in `api/media/nsfw.py`.
- **Re-exporting** may not reproduce the same bytes, so the checked-in files are the artefacts of record. A re-export is a deliberate change: new files, new pinned SHA-256s, and a new model id.

- **Score:** `score` is the model's `NSFW` probability, per image, and the hash's `nsfw_score` is the **maximum** over the classified images. There's no separate suggestive class, so suggestive content isn't recorded.
- **Threshold:** `nsfw_auto = nsfw_score >= NSFW_THRESHOLD`, **starting at 0.85** (PLAN.md). **(chosen: no review band.)** 0.85 wasn't picked for this model, so it's re-picked on a labelled set before launch (§15).
- **Before launch:** measure precision and recall on a labelled set of **legal** adult and non-adult images (including drawings, swimwear and medical images), re-pick `NSFW_THRESHOLD` from the results, and measure the CPU time per image inside the `scan` sandbox (2 GiB address space, 90 s CPU). The vendor's accuracy figure comes from its own dataset. If the model isn't good enough, the plan's fallback is a hosted API behind the same `nsfw.classify()` function.

**Other options (checked 2026-11-25; not adopted).** Both are classifiers on Hugging Face that would run on CPU through ONNX Runtime, if the Marqo model's measurements fall short:

| | Falconsai `nsfw_image_detection` | Freepik `nsfw_image_detector` |
|---|---|---|
| **Licence** | Apache-2.0 | MIT (Freepik Company S.L., 2025) |
| **Architecture** | ViT-Base/16, 224×224 | EVA-02 Base/14, 448×448 (trained in bfloat16) |
| **Weights** | 343 MB float32 | 173 MB bfloat16 |
| **Classes** | `normal`, `nsfw` | `neutral`, `low`, `medium`, `high` |
| **Preprocessing** | RGB, bilinear 224×224, mean and std 0.5, NCHW | RGB, bicubic 448×448, CLIP mean and std, NCHW |
| **ONNX** | Third-party exports exist (`onnx-community/nsfw_image_detection-ONNX`, no licence stated); export with Hugging Face Optimum instead | Third-party exports only; export with `timm` |
| **Accuracy (vendor's own test set)** | Not published; weakest on borderline content in Freepik's comparison | Best in its own comparison against Falconsai and AdamCodd |
| **Maintenance** | Card updated 2026-09-07; a 2026 successor is gated | Static since 2025-05-09 |
| **CPU cost** | High (ViT-Base) | Highest (ViT-Base at 448 px) |

- Freepik is the more accurate choice if CPU time allows; its graded output would let `high` (and perhaps `medium`) count as explicit.

### 4.2 What's classified

The images listed in §2.3's NSFW column: images, 8 frames of animated files, 8 video frames, audio cover art, and the first 3 PDF pages. Archives, text and other kinds aren't classified (`nsfw_score = NULL`). Previews (`thumb`, `poster`, `cover`) aren't re-classified: they're made from the same content.

### 4.3 The policy (decided 2026-11-24)

Adult content is allowed, always marked NSFW, and **only signed-in users may upload it.**
- **Anonymous upload with `nsfw=true`:** `403 NSFW_REQUIRES_ACCOUNT` before anything is uploaded.
- **Anonymous upload that de-duplicates onto an `nsfw_auto` hash:** `403 NSFW_REQUIRES_ACCOUNT`, nothing stored (§2.5).
- **Anonymous upload that scans as `nsfw_auto`:** rejected after the fact: the file is soft-deleted with `deleted_reason = 'NSFW_REQUIRES_ACCOUNT'`, and the upload page shows "Sign in to upload sensitive media" (§2.5, §11.2). The hash keeps its result, so a signed-in upload of the same bytes is accepted and marked.
- **Signed-in upload that scans as `nsfw_auto` without `nsfw_marked`:** accepted and marked (`nsfw_source: auto`). It also counts toward the "unmarked" rule: **3 such files in 30 days** (`NSFW_UNMARKED_WARN`) gives the uploader an automatic notice (rule `adult_unmarked`, a strike, appealable). Strikes lead to restrictions (§8.4).

### 4.4 The `nsfw` flag

**Files** (computed, never fanned out):

```
nsfw        = (nsfw_override = 'nsfw')
              OR (nsfw_override IS NULL AND (nsfw_marked OR hash.nsfw_auto))
nsfw_source = 'moderator' | 'reports'   when nsfw_override is set (its nsfw_override_source)
              'uploader'                when nsfw_marked
              'auto'                    when hash.nsfw_auto
              null                      otherwise
```

**Albums:** payload `nsfw = albums.nsfw OR any shown item is nsfw`. `albums.nsfw` is the explicit mark, by the owner (`nsfw_source: owner`) or staff (`moderator`).

### 4.5 Who can change it

| Who | Can |
|---|---|
| Uploader (signed in) | Mark at upload (`nsfw=true` on `POST /files`, `POST /uploads`) or later (`PATCH /users/@me/files/<id> { nsfw }`, bulk `POST /users/@me/files/nsfw`). Unmark only when `nsfw_source` is `uploader`; otherwise `409 NSFW_LOCKED`. |
| Uploader, auto-flagged | Ask for review: `POST /users/@me/files/<id>/nsfw-review { message? }` → `202`. Opens a P3 case (`content_flags.source = owner`), once per file (`409 APPEAL_NOT_ALLOWED` after). |
| Album owner | `PATCH /users/@me/albums/<id> { nsfw }`. Unmarking an album whose items are NSFW leaves the payload `nsfw` true. |
| Report thresholds | `nsfw_override = 'nsfw'`, source `reports`, after 2 distinct "Unmarked adult content" reports (§7.4). |
| Moderator | `mark_nsfw` / `unmark_nsfw` (sets `nsfw_override` to `nsfw` or `safe`, source `moderator`). Overrides everything, either way. |
| Anonymous owner | Can't mark (`403 NSFW_REQUIRES_ACCOUNT`). |

### 4.6 How NSFW is treated everywhere

| Surface | Behaviour |
|---|---|
| **Viewer** (`files.gg/<vanity>`) | An interstitial before anything loads: "This file may contain sensitive content" with **Show** and **Leave**, and "Always show sensitive media" (`localStorage["filesgg.showSensitive"] = "1"`). No media request is made before Show. |
| **Album page** | One interstitial for the whole album (the existing `NsfwGate`), skipped with the same setting. Inside, NSFW items aren't blurred again. |
| **og tags** | NSFW files and albums: no `og:image`, `og:video` or `og:audio`; `og:description` starts with "Sensitive content"; `twitter:card` `summary` (already built in the Worker). |
| **CDN redirect** | NSFW `link` files are **never** redirected from `files.gg/<vanity>` to the CDN, for any user agent (chosen). The shell's text card is all an embed gets. |
| **CDN** | Bytes and previews are served normally. NSFW is a label, not a block. |
| **Album payload** | A public NSFW album omits `collage` (owner payloads keep it). |
| **ZIP** | Unchanged: NSFW items are included. The Download all button is behind the album's interstitial. |
| **Dashboard tiles** | Blurred (`filter: blur(16px)`) with an eye-off icon; hover clips don't play; the drawer opens with the interstitial. The "Always show" setting applies here too. |
| **Admin pages** | Everything is blurred and greyscale by default, NSFW or not (§11.3). |

---

## 5. Malware and abuse checks beyond `filetypes.py`

### 5.1 Upload time (synchronous, in the API)

`filetypes.py` keeps its three checks (extension, declared type, executable magic). Added:
- **libmagic sniffing** of the first 64 KiB already read for `sniff_executable` (`python-magic`; `libmagic1` goes into the **base** image, since the API needs it). If the sniffed type is in `BLOCKED_MIMETYPES` → `400 FILE_TYPE_NOT_ALLOWED`. The sniffed type is passed to `scan` in its hints.
- The sniffed type **doesn't replace** the stored mimetype. A mismatch is recorded in `scan.sniffed` and handled by checking every type (§2.3).
- The checks from §2.5 (blocked hashes, known NSFW and encrypted hashes, bans, restrictions).

### 5.2 ClamAV

**Deployment** (`docker-compose.yml`):

```yaml
  clamav:
    image: clamav/clamav:1.5.5-debian@sha256:85f35b3eee903dbd96c5ca250c5aa13d230d97987c0f876f7d46f001f9414239   # digest as of 2026-11-23
    restart: unless-stopped
    environment:
      CLAMAV_NO_MILTERD: "true"
    volumes:
      - ./.data/clamav:/var/lib/clamav
      - ./clamav/clamd.conf:/etc/clamav/clamd.conf:ro
      - ./clamav/rules:/var/lib/clamav-rules:ro       # YARA rules, linked into the database dir at start
    expose: ["3310"]
    healthcheck: { test: ["CMD", "clamdcheck.sh"], interval: 60s, timeout: 10s, retries: 3, start_period: 6m }
    mem_limit: 4g
```

- **Version (checked 2026-11-25):** ClamAV **1.5.5** (2026-11-18) is the newest stable release; 1.4.7, from the same day, is the older supported line. The official image is `clamav/clamav` on Docker Hub. Its plain tags (`1.5.5`, `1.5`, `stable`, `latest`) are Alpine and **`amd64` only**; the `-debian` tags (`1.5.5-debian`, the same image as `clamav/clamav-debian:1.5.5`) are built for `amd64`, `arm64` and `ppc64le`, so this contract uses `1.5.5-debian`. The `_base` tags ship without signature databases; the others are rebuilt regularly, so their digests change often (the mounted database volume makes the bundled copy irrelevant either way). The image runs `freshclam` and `clamd` itself, includes `clamdcheck.sh` and declares a 6-minute healthcheck start period for the first database download. Milter is off by default.

- `scanner` and `rescanner` depend on `clamav` being healthy and get `CLAMAV_HOST=clamav`, `CLAMAV_PORT=3310`. Only they reach it; it's never published.
- **`clamd.conf` settings that matter:** `StreamMaxLength 512M`, `MaxFileSize 512M`, `MaxScanSize 1024M`, `MaxRecursion 10`, `MaxFiles 10000`, `AlertExceedsMax yes` (content past these limits reports `Heuristics.Limits.Exceeded.*`, which becomes the `archive_partially_scanned` warning instead of a silent `OK`; security fix 2026-11-25), `DetectPUA yes`, `HeuristicAlerts yes`, `AlertBrokenExecutables yes`, `AlertOLE2Macros yes`, `AlertEncrypted no` (§5.3 handles encryption), `AlertPhishingSSLMismatch no`, `AlertPhishingCloak no`, `SelfCheck 600` (reloads updated databases).
- **Signatures (decided 2026-11-25): ClamAV's official databases only,** through the image's own `freshclam`. There are no third-party feeds and no feed sidecar in Milestone 4 (§5.6 "Future: abuse.ch"). **YARA** rules (PLAN.md "common droppers") from `clamav/rules/` in the repo are loaded by `clamd` itself, so there's no second engine. The initial rule set is an ops item (§15).
- **Protocol:** the job process streams the blob with `zINSTREAM\0`, 64 KiB chunks each prefixed by a 4-byte big-endian length, then a zero-length chunk. The reply `stream: OK` is clean; `stream: <name> FOUND` is a detection; anything else, or a timeout (`CLAMAV_TIMEOUT`, 120 s), is a retry.
- **Size:** blobs over `CLAMAV_MAX_BYTES` (512 MiB) aren't sent. For image, video and audio that's `skipped`; for anything else it adds the `too_large_to_scan` warning.
- **Outcome (chosen):** a signature name starting with a prefix in `CLAMAV_FLAG_ONLY_PREFIXES` (default `PUA.,Heuristics.`) → `flagged`, `unwanted_software`. Every other detection → `blocked`, `malware`.

### 5.3 Archives

Applies when any of the types (§2.3) is zip, 7z, rar, tar, gzip, bzip2, xz or zstd (including `.tgz` and similar).

- **Listing without extracting,** in the sandboxed child, through libarchive (the `libarchive-c` bindings, reading entries as a stream), plus Python's `zipfile` for zip encryption flags. `bsdtar` and `libarchive` come from Debian's `libarchive-tools` in the worker image.
- **Caps:**
  - **10,000 entries:** listing stops there, the result is `partial: true` and the `archive_partially_scanned` warning (chosen: not a block, because large legitimate archives exist);
  - **nesting depth 3:** a nested archive entry (≤ 100 MiB) is streamed into the child's temp dir and listed in turn;
  - **bombs (chosen):** a declared unpacked total over **20 GiB**, or over **1000×** the archive's size, blocks it (`archive_bomb`).
- **Blocked entries:** any path segment of any entry with an extension in `filetypes.BLOCKED_EXTENSIONS` (so `Foo.app/Contents/…` counts), plus `.dex`, blocks the archive (`blocked_type`). For unencrypted entries, the first 64 KiB of each are read and checked with `sniff_executable` too.
- **Images inside:** up to 100 image entries (by extension or sniffing), ≤ 20 MiB each, at depth ≤ 1, are decoded into `MatchImage`s for §3. They aren't classified for NSFW.
- **Encrypted archives** (any encrypted entry, or encrypted headers):
  - anonymous uploads: rejected (`ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT`, §2.5);
  - signed-in uploads: allowed, with the `encrypted_archive` warning ("This archive is encrypted and couldn't be scanned"). Encrypted entries' names are still checked.
- **ClamAV** scans the whole archive too, with its own recursion limits (§5.2).
- **Fixtures to verify detection:** zip with ZipCrypto, zip with AES, 7z with and without header encryption, rar5 with and without header encryption.

### 5.4 Office documents

`oletools` in the sandboxed child (`olevba`, `oleid`, `msodde`), for OOXML and OLE files by any of their types:
- **Block** (`blocked_type`): VBA macros (an OOXML `vbaProject.bin`, even in a plain `.docx` or `.xlsx`; OLE VBA streams), Excel 4.0 (XLM) macros, DDE fields, and external template or OLE links over `http(s)` or UNC.
- Nothing is flagged; there's no warn tier for Office.

### 5.5 PDFs and polyglots

**PDFs** (a pdfid-style keyword scan):
- Over the raw bytes **and** over `qpdf --qdf --object-streams=disable` output (so keywords inside object streams are seen), with name escapes (`/J#61vaScript`) normalised first. `qpdf` comes from Debian in the worker image.
- **Block** (`pdf_dangerous`): `/Launch`, `/RichMedia`, and an `/EmbeddedFile` whose name or sniffed content is a blocked type.
- **Flag** (`pdf_javascript`): `/JavaScript`, `/JS`, `/OpenAction`, `/AA`. pdf.js never runs them (`enableScripting: false`).
- **URLs:** `/URI` actions and `http(s)://` in the extracted text (§5.7).

**Polyglots and type mismatches:**
- Every type the file parses as is checked (§2.3). An image whose bytes sniff as an archive is also checked as an archive; one that sniffs as a PE is already blocked.
- **An image or PDF with an archive appended** (a ZIP end-of-central-directory record, or a 7z or RAR signature, found after the format's own end marker) → `flagged`, `polyglot_archive`, and the appended archive goes through §5.3, which can block it.
- **Image + HTML or script** polyglots get nothing extra: the CDN's sandbox CSP and `nosniff` already stop them running (PLAN.md "Hardening" part A). The Phase 5 test suite checks this.

### 5.6 Future: abuse.ch (not in Milestone 4)

**Decided 2026-11-25:** Milestone 4 uses no abuse.ch service. ClamAV runs on its official signatures only (§5.2), and Web Risk is the only supplementary check (§2.6). Two abuse.ch services are candidates for later:
- **MalwareBazaar** hash lookups: a supplementary, fail-open check in the `scan` job process for kinds other than image, video, audio and text (archives' nested files not looked up), with a hit blocking as `malware`.
- **URLhaus** ClamAV signatures, through a `fangfrisch` sidecar. `fangfrisch` 1.9.3 (2026-10-22, GPL-3.0-or-later) has no official Docker image, so it would need a small pinned one that runs `fangfrisch initdb` once, then `fangfrisch refresh` on a loop, writing into the `clamav` database volume.

**What they need:**
- **A free abuse.ch Auth-Key** from the Authentication Portal (`https://auth.abuse.ch/`). Authentication became mandatory for all abuse.ch APIs on 2025-06-30, and one key works for every abuse.ch API.
- **Terms that fit.** abuse.ch's [terms of use](https://abuse.ch/terms-of-use/) (updated 2026-10-21) limit free use to volumes "reasonably expected for non-commercial or non-profit purposes", say commercial or for-profit use may need a paid subscription through Spamhaus ([abuse.ch commercial API](https://www.spamhaus.com/data-access/abusech-api/)), and prohibit high-volume automated harvesting. The MalwareBazaar [FAQ](https://bazaar.abuse.ch/faq/) says the same. **Once files.gg has premium plans, ask abuse.ch or Spamhaus whether its use needs a subscription** before turning either service on.

**Request formats, for reference** (checked 2026-11-25):
- **MalwareBazaar** ([API docs](https://bazaar.abuse.ch/api/)): `POST https://mb-api.abuse.ch/api/v1/` with form fields `query=get_info` and `hash=<sha1>` (SHA-256, SHA-1 or MD5 are accepted), and the header `Auth-Key: <key>`. `hash_not_found` means clean. A found hash returns `query_status: ok` with a `data` array (`sha256_hash`, `signature`, `file_type`, `tags`, …), with `signature` as the detail. The docs' `get_info` table lists only the error values (`http_post_expected`, `hash_not_found`, `illegal_hash`, `no_hash_provided`); `ok` is the success value the other endpoints document, so treat `ok` with a non-empty `data` as the hit and anything else as an error. No rate limit is published for `get_info`.
- **URLhaus:** the key goes in the download URL. `fangfrisch` fetches `https://urlhaus-api.abuse.ch/v2/files/exports/<key>/urlhaus_clamav.ndb` every 10 minutes.

Sanesecurity's feeds were also considered and dropped: they publish no licence or commercial-use terms, most target email, and several carry a medium or high false-positive risk.

### 5.7 Web Risk (links in text, PDFs and album text)

- **Google Web Risk** Lookup API (the commercial version of Safe Browsing). **(chosen: optional, fail open.)** Configured by `WEB_RISK_API_KEY`; in dev, `WEB_RISK_STANDIN_FILE` lists URLs that count as hits.
- **Request** (checked against the [Lookup API docs](https://docs.cloud.google.com/web-risk/docs/lookup-api) and [`uris.search` reference](https://docs.cloud.google.com/web-risk/docs/reference/rest/v1/uris/search) 2026-11-25; `v1` is current): `GET https://webrisk.googleapis.com/v1/uris:search?threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE&uri=<url-encoded url>&key=<key>`, one URL per request, empty body. The URL needn't be canonicalised. `SOCIAL_ENGINEERING_EXTENDED_COVERAGE` is also available and not used. A response with `threat` (`threat.threatTypes[]`, `threat.expireTime`) is a hit; `{}` is clean.
- **Pricing** ([pricing](https://cloud.google.com/web-risk/pricing), checked 2026-11-25): `uris.search` is **free for the first 100,000 calls a month per billing account, then $0.50 per 1,000**. A billing account is required. **Never call `threatLists.computeDiff`** from the same project: doing so reprices `uris.search` at $50 per 1,000 (the Update API rate).
- **Quotas** ([quotas](https://docs.cloud.google.com/web-risk/quotas)): `uris.search` allows 6,000 requests a minute per Google Cloud project, shared across all callers. At `WEB_RISK_MAX_URLS = 100`, the free tier covers about 1,000 link-heavy files a month; set a budget alert.
- **Commercial use:** Web Risk is Google's commercial product; the free Safe Browsing API is [non-commercial only](https://developers.google.com/safe-browsing/v4/usage-limits) and isn't an option for files.gg.
- **Warning rules** ([user warnings](https://docs.cloud.google.com/web-risk/docs/user-warnings), mandatory): warnings must use hedged wording ("suspected", "potentially", "may be"), carry the line "Advisory provided by Google" linked to Google's Web Risk advisory page, and link to a learn-more page for the threat type. A warning may be shown only while the matching response is still within its `expireTime`. **(open:** `link_warnings` stores URLs only (`text[]`), so it can't tell when a match expires. Either store each URL's `expireTime` with it and re-check expired ones with a `web_risk` rescan, or show the Google-attributed text only for fresh matches and treat older ones as files.gg's own block, without the attribution.**)** Any claim that files.gg protects users must say the protection isn't perfect (both false positives and false negatives happen). §11.1's copy follows these rules.
- **URLs:** `http` and `https` only, deduplicated, at most **100 per file** (`WEB_RISK_MAX_URLS`), in order of appearance.
- **Applies to:** text files (first 1 MiB), PDFs, and album titles, descriptions and captions. Album text is checked by an `album_text_scan { "album_id" }` job on the `scan` queue, queued (deduplicated, `run_after` 5 s) whenever they change. **Album text is never gated:** albums stay public while it runs.
- **On a hit:** the file is `flagged` (`web_risk`) and its first 20 hit URLs go into `scan.link_warnings`; an album gets `albums.link_warnings`. Either opens a **P1** case (reason `malware`). The viewer won't open those links (§11.1).

### 5.8 Summary: block, warn or flag

| Check | Block (`blocked`) | Hold (`held`) | Flag for review (`flagged`, public) | Warn visitors (`warnings`) |
|---|---|---|---|---|
| Blocklisted types (name, declared, sniffed) | yes, synchronous | | | |
| CSAM matcher | yes, plus §3.6 | | | |
| Exact blocked hash | yes | | | |
| PDQ near-match | | yes | | |
| ClamAV | other detections | | `PUA.*`, `Heuristics.*` | `unwanted_software` |
| Archive: blocked entry or bomb | yes | | | |
| Archive: encrypted | anonymous (rejected) | | | signed-in: `encrypted_archive` |
| Archive: over 10,000 entries | | | | `archive_partially_scanned` |
| Office: macros, XLM, DDE, external links | yes | | | |
| PDF: `/Launch`, `/RichMedia`, embedded blocked files | yes | | | |
| PDF: `/JavaScript`, `/OpenAction`, `/AA` | | | yes | |
| Polyglot with an appended archive | (if the archive blocks) | | yes | |
| Web Risk | | | yes | flagged links listed in `link_warnings` |
| Non-media blob over 512 MiB | | | | `too_large_to_scan` |

Flagged and held findings open a case with priority P1 (malware, web risk, PDQ near-match not CSAM), P2 (unwanted software) or P3 (PDF JavaScript, polyglot).

---

## 6. Payload changes

### 6.1 The file payload (every place that returns it)

| Field | Type | Notes |
|---|---|---|
| `nsfw` | boolean | Real now (§4.4). |
| `warnings` | string[] | `scan.warnings` (§2.8). Usually empty. |
| `link_warnings` | string[] | Up to 20 URLs Web Risk flagged (§5.7). Usually empty. |
| `kind` | string | `file` when `serve_inline` is false, whatever the type (§2.3). |

The public payload never says why a file is flagged, never carries `nsfw_score`, and never describes CSAM.

### 6.2 Owner additions (owner file, upload responses)

Upload responses (`POST /files`, finalized uploads) now include `safety` too, since the uploader is the caller.

```json
"safety": {
  "state": "ok | pending | flagged | hidden | removed | blocked",
  "reason": null,
  "notice_id": null,
  "nsfw_source": "auto",
  "nsfw_locked": true,
  "nsfw_review": "none | open | done"
}
```

- `reason`: the rule (§8.1) for `hidden` and `removed` (`review` for held or auto-hidden), the scan reason code (§2.3) for `flagged` and `blocked`. For anything CSAM-related the owner only ever sees `review` (hidden) or `FILE_BLOCKED` (blocked).
- `notice_id`: the notice (§8) explaining it, when there is one.
- `nsfw_source`: as in §4.4, or `null`.
- `nsfw_locked`: true when the uploader can't unmark (§4.5).
- `nsfw_review`: the uploader's review request (§4.5): `none`, `open` (a case is open) or `done` (decided; the result shows in `nsfw` and a notice).

**New owner endpoints:**

| Request | Response |
|---|---|
| `GET /users/@me/files/<id>` | The owner file. A file deleted with a rejection code: `410 UPLOAD_REJECTED { reason }` for 24 h (§2.5). |
| `PATCH /users/@me/files/<id> { nsfw }` | The owner file (§4.5). |
| `POST /users/@me/files/nsfw { file_ids, nsfw }` | `200 { "items": [owner file], "skipped": [ids] }`. At most 100 ids; ids you don't own, or can't unmark, are skipped. |
| `POST /users/@me/files/<id>/nsfw-review { message? }` | `202` (§4.5). |
| `PATCH /users/@me/albums/<id> { nsfw }` | The owner album. |

**Upload parameters:** `nsfw=true` on `POST /files` (multipart and raw) and `nsfw` on `POST /uploads`.

**Owner album** gains `nsfw_marked` (= `albums.nsfw`), `safety: { state: "ok | hidden | removed", reason, notice_id }`, and `link_warnings`. Each item's `shown` is also `false` while the item isn't `ok` or `flagged`, and each item has its owner `safety`.

**Hidden, removed and blocked files** can still be renamed, moved between albums, deleted and have their access changed by the owner. That doesn't make them visible.

### 6.3 Worker ↔ API: internal lookups

`GET /internal/files/<vanity>` adds:

```json
"safety": { "state": "ok | pending | hidden | removed | blocked", "reason": "review | terms | copyright | malware | null" },
"serve_inline": true
```

- `reason` is the **public** reason (§2.4), only for `hidden` and `removed`.
- `storage` and `previews` stay as they are, except for a `csam_match` hash: then the API answers **404**, exactly like an unknown vanity, so the Worker has nothing to serve or sign for.
- **The Worker treats a lookup without `safety` as `pending`** (fail closed).

`GET /internal/albums/<vanity>` adds:
- `safety`: `{ state: "ok | hidden | removed", reason }` for the album itself;
- `pending_count`: the number of items that would be shown once they're `ok`;
- the album is returned (instead of 404) when it has no items to show but `pending_count > 0`, with `album.items: []`.

Items in `album.items`, `items_access` and `items_storage` are **only** items whose effective state is `ok` (flagged counts as ok). Album `nsfw` follows §4.4.

The lookup cache stays **5 s**. The cache key version becomes **`v4`**.

### 6.4 Albums and collages

- **Which items an album shows** (milestone-3 §4) adds: the item's effective state is `ok` or `flagged`.
- An album whose own `moderation_state` is `hidden` or `removed` shows the `removed` state (410) on its page, and its collage and ZIP are `410`.
- **Collages never show content that left:** when an item stops being shown for a moderation or scan reason, the same transaction sets that album's `collage_key = NULL` and queues `album_collage`. Collage previews are cached as immutable, so the old URL keeps working in caches that already have it; the payload stops pointing at it within 5 s.
- `GET /albums/<vanity>` for a hidden or removed album: `410 ALBUM_REMOVED { reason }`. With nothing shown but items pending: the payload with `items: []` and `pending_count`.

---

## 7. Report system

### 7.1 Who can report what

| Target | Signed in | Anonymous (Turnstile, action `report`) | Notes |
|---|---|---|---|
| File | yes | yes | Any file you can reach by its link: `link` and `password` files, whatever their state. A `private` file is `404 UNKNOWN_FILE` to everyone but its owner. |
| Album | yes | yes | The album as a whole, or one `part`: `title`, `description` or `captions`. A report about one item targets that file. |
| User | yes | no | By user id, from admin pages and (Milestone 6) profiles. |
| Bug | yes | yes | No target. Goes to the bug queue. |

- **Not your own:** a signed-in owner, or the anonymous fingerprint that owns it, gets `400 CANNOT_REPORT_YOURSELF`.
- **Staff** can report like anyone else; their reports aren't special.
- Turnstile's action list (milestone-2 §8) adds `report`.

### 7.2 Where

- A **Report** button in the viewer footer, in the album header, and in the ⋯ menu of a dashboard drawer for files you don't own (album items).
- **`files.gg/<vanity>/report`** and **`files.gg/a/<vanity>/report`**: the report page for that file or album (embeds' "Report" link). **(chosen)** `report` becomes a reserved vanity segment (`blacklisted_ids`), so no vanity can contain it, and the suffix is unambiguous even for multi-segment vanities.
- **`files.gg/report`**: the public form, which takes any `files.gg` or `cdn.files.gg` URL.

### 7.3 Reasons and the request

| `reason` | Label | Priority | Applies to | Automatic effect (§7.4) |
|---|---|---|---|---|
| `csam` | Child sexual abuse material | P0, child safety | file, album, user | Hide at once |
| `ncii` | Intimate images shared without consent | P0 | file, album, user | Hide at once |
| `violence` | Violence, terrorism or credible threats | P1 | file, album, user | Hide after 2 distinct reports |
| `malware` | Malware or phishing | P1 | file, album | Hide after 2 distinct reports; rescan at once |
| `adult_unmarked` | Adult content not marked as sensitive | P2 | file, album | Mark NSFW after 2 distinct reports |
| `copyright` | Copyright (DMCA) | P2 | file, album | None. Needs `dmca`. |
| `harassment` | Harassment or private information | P2 | file, album, user | Hide after 3 distinct reports |
| `spam` | Spam | P3 | file, album, user | Hide after 3 distinct reports |
| `other` | Something else | P3 | file, album, user | None |
| `bug` | A problem with files.gg | P3 | bug only | None |

Thresholds are config (`REPORT_THRESHOLDS`, §13). User reports never hide anything automatically.

```
POST /reports              (signed in)
POST /reports/anonymous    (X-Fingerprint optional, turnstile_token required)
```

```json
{
  "target": { "type": "file", "vanity": "abc123" }
          | { "type": "album", "vanity": "Ab3dE6gH", "part": "whole" }
          | { "type": "user", "id": "123456789012345678" }
          | { "type": "bug" }
          | { "type": "url", "url": "https://cdn.files.gg/previews/thumb/abc123.webp?v=5" },
  "reason": "malware",
  "details": "…",
  "contact_email": "…",
  "dmca": { … },
  "turnstile_token": "…"
}
```

- **`url` targets** resolve server-side: `files.gg/<vanity>[.<ext>]`, `files.gg/<vanity>/report`, `files.gg/a/<vanity>[/<n>][/report]` (with `<n>`, the album's item n, 1-based), and every CDN path from milestone-3 §3. Anything else is `400 INVALID_REPORT_TARGET`. Query strings and fragments are ignored.
- **`details`:** ≤ 2,000 characters, plain text (control characters other than `\n` stripped). Required for `other`, `bug` and `copyright` (`400 DETAILS_REQUIRED`, with `errors.details`).
- **`contact_email`:** anonymous only, optional, ≤ 254 characters, syntax-checked. Ignored when signed in.
- **`dmca`** (required for `copyright`, `400 DMCA_FIELDS_REQUIRED` with `errors` per field), following 17 U.S.C. § 512(c)(3):

| Field | Notes |
|---|---|
| `name`, `address`, `phone`, `email` | The complaining party's contact details. `email` is required even when signed in. |
| `work` | Identification of the copyrighted work (≤ 2,000). |
| `urls` | The files.gg URLs of the infringing material (1–50). They must resolve like `url` targets. |
| `good_faith` | `true`: the good-faith statement. |
| `accurate_and_authorised` | `true`: accuracy, and authority to act, under penalty of perjury. |
| `signature` | The full legal name as an electronic signature. |

  A DMCA notice listing several URLs creates one report per file.

**Responses:**
- Signed in: `201 { "report": <report> }`. A duplicate (an `open` report by you on the same target): `200 { "report": <report>, "duplicate": true }`, and the new `details` are added to its thread as your message.
- Anonymous: `201 { "id": "…", "status": "open" }`. No thread. A duplicate (same fingerprint or IP hash, same target, open): `200` with the same shape, and nothing new is stored.
- `csam` reports, both kinds, also return `"escalated": true`. The UI then shows only "Thank you. This has been escalated."

### 7.4 What happens on submit

1. Rate limits (§7.7), Turnstile (anonymous), target resolution, `CANNOT_REPORT_YOURSELF`.
2. The report is stored with `priority` from the table, `reporter_abuse_ip_hash`, and the reporter's fingerprint (anonymous).
3. It joins the target's open **case**, or opens one (§9.2). The case's priority is the highest of its open reports and flags.
4. **Distinct reporters (chosen):** two reports count as distinct when their reporter keys differ (`user:<id>`, or `anon:<fingerprint or none>`) **and** they don't share an `abuse_ip_hash`. Only open reports with the same reason count.
5. **Automatic effects**, by the target's reason count:
   - **hide** sets `moderation_state = 'hidden'` (rule = the reason; public reason `review`), logs `auto_hide`, and sends the owner a non-appealable notice ("Hidden while we review a report"), **except for `csam`**, which sends nothing;
   - **(chosen)** a `csam` report on an **album** hides the album and every item in it;
   - **mark NSFW** sets `nsfw_override = 'nsfw'`, source `reports`, logs `auto_nsfw`; the case stays open for a moderator to confirm;
   - **`malware`** reports also queue an immediate `rescan` with `clamav` ("hidden at once if ClamAV agrees": a detection blocks it, §2.7).
6. Nothing ever tells the uploader who reported.

### 7.5 The report (reporter's view)

```json
{
  "id": "…",
  "kind": "file",
  "target": { "type": "file", "vanity": "abc123", "url": "https://files.gg/abc123", "part": null },
  "reason": "malware",
  "status": "open",
  "closed": false,
  "escalated": false,
  "can_reopen": false,
  "unread": 1,
  "created_at": 1795603600,
  "updated_at": 1795607200,
  "resolved_at": null,
  "last_message_at": 1795607200
}
```

- `target` never includes the uploader, the filename or the file's current state (beyond `url`).
- `escalated` reports (`csam`) show their status, but staff never post details into the thread.

### 7.6 Statuses, threads and "My reports"

| Status | Means | Reporter can |
|---|---|---|
| `open` | Waiting for staff | Add messages |
| `resolved` | Staff acted on it | Add messages until closed |
| `dismissed` | Staff found nothing to act on | Add messages until closed; **Reopen** once, within 14 days |
| closed (`closed: true`) | 30 days after `resolved_at`, set by the `report_closer` task | Read only |

**Endpoints** (signed in):

| Request | Response |
|---|---|
| `GET /users/@me/reports?status&query&offset&limit` | `{ "count", "items": [report] }`. `query` matches the target vanity or URL; `limit` 1–100 (default 25); newest first. |
| `GET /users/@me/reports/<id>` | `report` |
| `GET /users/@me/reports/<id>/messages` | `{ "items": [{ "id", "author": "you" \| "staff", "body", "created_at" }] }`, oldest first. Marks the report read. |
| `POST /users/@me/reports/<id>/messages { body }` | `201` message. `409 REPORT_CLOSED` when closed. |
| `PATCH /users/@me/reports/<id> { "status": "open" }` | `report`. Only from `dismissed`, once (`reopen_count`), within `REPORT_REOPEN_DAYS` (14) of `resolved_at`; else `409 REOPEN_NOT_ALLOWED`. It rejoins (or reopens) the target's case. |

- **(chosen)** Staff messages show as **"files.gg staff"**, never a name.
- `unread` counts staff messages newer than your `report_reads.last_read_at`, plus status changes.
- **Anonymous reporters** with a `contact_email` get one email (Postmark, `email_templates.py`) when the report is resolved or dismissed: neutral, no details of the action or the uploader. The address is deleted 90 days after the report closes.
- **Retention:** closed reports and their messages are deleted after `REPORT_RETENTION_DAYS` (365), except those on a `child_safety` case, which follow the evidence hold. `reporter_abuse_ip_hash` is cleared after 30 days.

### 7.7 Rate limits

| Limit | Default | Error |
|---|---|---|
| Reports per account | 10 an hour | `429 MAX_REPORTS { retry_after }` |
| Reports per fingerprint, and per IP hash | 10 an hour each | `429 MAX_REPORTS { retry_after }` |
| Report messages per account | 30 an hour | `429 MAX_MESSAGES { retry_after }` |
| Appeals | once per notice | `409 APPEAL_NOT_ALLOWED` |

Counted in `safety_rate_limits` (§1), in 1-hour windows. **`csam` reports aren't rate-limited** for signed-in reporters, and only by Turnstile for anonymous ones.

---

## 8. Notices and appeals

### 8.1 When a notice is created

A notice (`user_warnings` row) goes to a **signed-in** owner when an action hits their content or account:

| Action | Notice | Appealable | Strike |
|---|---|---|---|
| `hide` (moderator) | yes | yes | no |
| `auto_hide` (report thresholds, P0) | yes, "Hidden while we review a report" | no | no |
| `remove`, `delete` | yes | yes | yes |
| `mark_nsfw`, `auto_nsfw` | yes | yes | no |
| Scan `blocked` (initial or rescan) | yes | yes | no |
| `adult_unmarked` rule (§4.3) | yes | yes | yes |
| `block_hash` (owners of the hash's other files) | yes | yes | no |
| `restrict_uploads`, `suspend_user` | yes | yes | — |
| Anything CSAM-related | **no detail**: a `suspended` restriction with rule `csam` shows only "Your account has been suspended" | **no** | — |

Anonymous owners get no notices; their file pages show the removed state.

**Rules** (`rule`, with the text notices show):

| `rule` | Text |
|---|---|
| `csam` | (never shown) |
| `ncii` | Intimate images shared without consent |
| `violence` | Violence, terrorism or credible threats |
| `malware` | Malware or harmful software |
| `phishing` | Phishing or scams |
| `adult_unmarked` | Adult content that wasn't marked as sensitive |
| `copyright` | Copyright infringement |
| `harassment` | Harassment |
| `private_info` | Sharing someone's private information |
| `spam` | Spam |
| `other` | Breaking the Terms of Service |

### 8.2 The notice and appeals

```json
{
  "id": "…",
  "action": "remove",
  "rule": "malware",
  "rule_text": "Malware or harmful software",
  "message": "Optional text from staff.",
  "target": { "kind": "file", "id": "…", "vanity": "abc123", "name": "setup-helper.zip" },
  "created_at": 1795603600,
  "acknowledged_at": null,
  "appeal": { "state": "none", "can_appeal": true, "appealed_at": null, "decided_at": null, "message": null }
}
```

`target.kind` is `file`, `album` or `account`. `appeal.message` is staff's reply to a decided appeal.

| Request | Response |
|---|---|
| `GET /users/@me/warnings?unacknowledged&offset&limit` | `{ "count", "unacknowledged", "items": [notice] }`, newest first |
| `POST /users/@me/warnings/acknowledge { ids }` | `200 { "acknowledged": [ids] }` (ids that aren't yours are skipped) |
| `POST /users/@me/warnings/<id>/appeal { message, counter_notice? }` | `200` notice. `message` ≤ 2,000, required. Once per notice (`409 APPEAL_NOT_ALLOWED`). |

- **An appeal** opens a case (`kind: appeal`, priority P2, `needs_second_review = true`) for a different moderator (§9.4).
- **Copyright counter-notices (chosen):** a `copyright` notice's appeal requires `counter_notice` (17 U.S.C. § 512(g)(3)): `name`, `address`, `phone`, `email`, `material` (what was removed and where it was), `mistake_statement: true` (good-faith belief, under penalty of perjury, that it was removed by mistake or misidentification), `jurisdiction_consent: true`, `service_consent: true` (accepts service of process from the complainant), `signature`. Forwarding it to the complainant and restoring after the statutory waiting period are **manual staff steps**, not automatic.
- **Granted** reverses the action (§9.3), sets `appeal_state = 'granted'`, and the notice stops counting as a strike. A `delete` can't be reversed, so granting its appeal only removes the strike. **Denied** keeps everything. Either way the owner sees `appeal.message`.

### 8.3 Badges

```
GET /users/@me/badges → { "reports_unread": 2, "notices_unacknowledged": 1,
                          "restrictions": [{ "kind": "uploads", "until": 1797000000, "notice_id": "…" }],
                          "staff": { "open": 12, "p0": 1, "mine": 3 } | null }
```

**(chosen)** This replaces the plan's `GET /users/@me/reports/unread`. `staff` is present only for staff (P0 counts only child-safety cases for child-safety staff, NCII P0s for everyone). `GET /users/@me` also gains `staff: { role, child_safety } | null` and `restrictions`.

### 8.4 Strikes, restrictions and suspension

- **Strikes:** notices with `counts_as_strike` that weren't granted on appeal, within **90 days** (`STRIKES_WINDOW_DAYS`).
- **3 strikes → uploads restricted for 30 days** (`RESTRICT_DAYS`), automatically (action `restrict_uploads`, system). **(chosen)** Restricted means **no uploads at all** (`403 UPLOADS_RESTRICTED { until }`); everything else works.
- **A further strike while restricted, or within 90 days after → suspension** (`suspend_user`, system, a P2 case for staff to review).
- **Repeat infringers:** 3 upheld `copyright` notices, ever → suspension.
- **Suspended accounts (chosen):** can sign in, and use `GET /users/@me`, `GET /users/@me/badges`, the warnings endpoints (including appeal, unless the rule is `csam`) and logout. Everything else gives `403 ACCOUNT_SUSPENDED`. Their content stays as it is unless a moderator acts on it, except for CSAM (§3.6).

---

## 9. Moderation

### 9.1 Staff (chosen: a `staff` table)

- **Why not `users.flags`:** roles, a capability and an audit trail don't fit one bit, and the `users` table stays unchanged until Milestone 6.
- **Granting:** only on the server: `python -m tools.staff grant <user_id> --role moderator|admin [--child-safety]`, `revoke <user_id>`, `list`. Each writes `grant_staff` / `revoke_staff` to `moderation_actions` with `actor_kind: cli` and the operator's `--by <name>` in `details`. There's no API to grant staff in Milestone 4.
- **Every `/admin/*` endpoint** answers a non-staff caller (signed out, or signed in without a `staff` row) with the **same 404 as an unknown route**. A staff member without the needed permission gets `403 FORBIDDEN`.

| Permission | `moderator` | `admin` | `child_safety` (with either role) |
|---|---|---|---|
| Queue: P1–P3, NCII P0, appeals, bugs | yes | yes | |
| Child-safety cases (CSAM reports, matches, CSAM-linked holds) | | | yes |
| Hide, unhide, remove, restore, mark and unmark NSFW, delete with hold, clear flag | yes | yes | |
| Block and unblock hashes (not CSAM) | yes | yes | |
| Restrict uploads, ban a fingerprint or IP hash for up to 30 days | yes | yes | |
| Suspend and unsuspend users, permanent bans, lift bans | | yes | |
| Open media through staff grants (§10.3) | yes, not child-safety cases | yes, not child-safety cases | yes, for child-safety cases (never hash-matched) |
| `confirm_csam`, record CyberTipline reports | | | yes |
| Rescans, the staff list, the whole audit log | | yes | |

### 9.2 Cases and the admin queue

A **case** groups everything about one target: its open reports, scanner flags (`content_flags`) and appeals. One open case per target (`file`, `album`, `user`, `hash`); bugs and appeals get one case each.

- **Priority:** the highest of its parts (P0 = 0). **Ordering:** P0 first, then by `created_at` (oldest first).
- **Goals, staff only** (PLAN.md "Promise less"): P0 within 24 h, everything else within 7 days. `past_goal` counts in the summary.

| Request | Response |
|---|---|
| `GET /admin/summary` | `{ "open": { "p0", "p1", "p2", "p3" }, "unassigned", "mine", "past_goal": { "p0", "other" }, "appeals", "bugs", "scans_stalled", "cybertip_unrecorded", "newest_p0_at" }`. Child-safety counts only for child-safety staff. |
| `GET /admin/cases?status=open&priority&reason&kind&assignee=me\|none\|<id>&needs_second_review&cursor&limit` | `{ "items": [case summary], "next_cursor" }` |
| `GET /admin/cases/<id>` | the case (below) |
| `POST /admin/cases/<id>/claim` | the case. `409 CASE_CLAIMED { assignee_id }` if someone else holds it; admins can take it with `{ "force": true }`. |
| `POST /admin/cases/<id>/release` | the case |
| `POST /admin/cases/<id>/messages { report_id, body }` | `201`. A staff message in one report's thread. |
| `POST /admin/cases/<id>/close { outcome, reason, reporter_message? }` | the case. `outcome`: `actioned` (its reports become `resolved`) or `dismissed` (`dismissed`). `reporter_message` (default: a neutral canned text) goes into each signed-in reporter's thread. |
| `POST /admin/cases/<id>/appeal { decision, message }` | the case. `decision`: `grant` or `deny` (§8.2, §9.4). |
| `POST /admin/cases/<id>/cybertip { report_id }` | the case (§3.6) |
| `PATCH /admin/cases/<id> { needs_second_review }` | the case |

**Case summary:** `id`, `kind`, `priority`, `status`, `target` (`{ type, id, vanity?, name?, state }`), `reasons` (`{ "<reason>": count }`), `report_count`, `distinct_reporters`, `flags` (reason codes), `assignee` (`{ id, username }` or `null`), `needs_second_review`, `child_safety`, `created_at`, `age_seconds`.

**Case:** the summary plus `reports` (each with `reason`, `details`, `album_part`, `dmca`, `created_at`, `reporter`: `{ user_id?, signed_in, account_age_days? }`, never IP hashes), `flags` in full, `actions` (the audit rows for the target), `target_detail` (§9.6) and, for appeals, the notice and the original action.

### 9.3 Actions

```
POST /admin/actions
{
  "action": "remove",
  "target": { "type": "file" | "album" | "user" | "hash", "id": "…" },
  "rule": "malware",
  "note": "staff-only text",
  "message": "optional text for the owner's notice",
  "notify": true,
  "case_id": "…",
  "duration": 2592000,
  "hold_days": 90,
  "also_block_hash": false
}
→ 200 { "action": <audit row>, "notice_ids": ["…"] }
```

| `action` | Targets | Effect | Reversed by |
|---|---|---|---|
| `hide` / `unhide` | file, album | `moderation_state` `hidden` / `visible` | each other |
| `remove` / `restore` | file, album | `removed` / `visible` | each other |
| `mark_nsfw` / `unmark_nsfw` | file, album | file: `nsfw_override`; album: `albums.nsfw` | each other |
| `delete` | file, album | Soft delete (`deleted_reason = 'moderator'`) plus an `evidence_holds` row in the files bucket for `hold_days` (default 90, at most 365). With `also_block_hash`, also `block_hash`. | not reversible |
| `block_hash` / `unblock_hash` | hash (or a file, meaning its hash) | `scan_state = 'blocked'` (`hash_list`), `blocked_hashes` and PDQs; every owner of the hash gets a notice. `unblock_hash` sets `passed` and queues `probe`. | each other; **never for CSAM (chosen)** |
| `clear_flag` | hash | `flagged` or `held` → `passed`, with the findings recorded in `scan.cleared`; closes the hash's flags. | `block_hash` |
| `confirm_csam` | file, hash | §3.6 with `source: staff` | not reversible |
| `restrict_uploads` / `unrestrict_uploads` | user | A `user_restrictions` row (`duration`, default 30 days) / lift it | each other |
| `suspend_user` / `unsuspend_user` | user | `suspended` (no `duration` = until lifted) / lift. Admin only. | each other; not CSAM suspensions |
| `ban` / `unban` | fingerprint or IP, through `/admin/bans` (below) | A `bans` row / lift it | each other |

- `rule` is required for every action that hides, removes, deletes, marks, blocks, restricts, suspends or bans (`400 INVALID_ACTION` otherwise, and for an action that doesn't apply to the target).
- `notify` (default `true`) sends the notice from §8.1. CSAM-related actions never notify.
- **System actions** (logged with `actor_kind: system`): `scan_block`, `scan_hold`, `scan_flag`, `csam_match`, `auto_hide`, `auto_nsfw`, `preserve_evidence`, `pdq_sweep_hit`, `restrict_uploads` and `suspend_user` from strikes.
- **Granting an appeal** runs the reversing action, with `reverses_action_id` set.
- **Bans** have their own endpoints, because staff never see raw IPs or IP hashes, so a ban names where the fingerprint or IP hash comes from:
  - `POST /admin/bans { "kind": "fingerprint" | "ip", "from": { "file_id" } | { "report_id" } | { "fingerprint" }, "duration"?, "rule", "note"? }` → `201` ban. `ip` needs a source that still has an IP hash (under 30 days old); otherwise `400 INVALID_ACTION`. Moderators can ban for up to 30 days; no `duration`, or a longer one, is admin only.
  - `GET /admin/bans?active=true&cursor` → `{ "items": [{ id, kind, source, rule, created_at, expires_at, lifted_at }], "next_cursor" }` (the source, never the hash).
  - `DELETE /admin/bans/<id>` lifts one (admin).
  
  Bans stop uploads and album creation (`403 BANNED`). They don't stop reports, unlocks or viewing.

### 9.4 Appeals and second review

- An appeal case can't be decided by the staff member who took the original action while another staff member with the needed permission exists: `409 SAME_MODERATOR`.
- The queue's "needs second review" filter shows appeals and cases a moderator flagged.

### 9.5 The audit log

- **Every** action, claim, release, case close, staff message, staff-grant URL signing (`view_content`, one row per signing, with the file and the kinds signed), rescan request and CLI change writes one `moderation_actions` row. Rows are never updated or deleted by the app.
- `GET /admin/audit?actor_id&action&file_id&album_id&user_id&case_id&cursor&limit` → `{ "items": [{ id, actor: { id, username, kind }, action, rule, target, note, details, reverses_action_id, created_at }], "next_cursor" }`. **Admins** see everything; **moderators** see only the rows of a case or target they open, through the case. Child-safety rows are visible only to child-safety staff.

### 9.6 Lookup and target detail

| Request | Response |
|---|---|
| `GET /admin/lookup?q=` | `{ "files": […], "albums": […], "users": […] }`, up to 10 each. `q` is a vanity, any files.gg or CDN URL, a user id, an exact email or a username. |
| `GET /admin/files/<id>` | Staff file detail: the owner file payload; `owner` (`{ user_id?, username?, fingerprint?, account_created_at?, anonymous }`); the hash's `scan` (findings, with CSAM details omitted), `scan_state`, `nsfw_score`; other files of the same hash (count, and ids for admins); albums; reports and cases; actions; **`staff_urls`**: `{ "content": "<url>", "previews": { "<kind>": "<url>" } }`, signed with the staff grant for 10 minutes (absent for child-safety cases unless the caller has `child_safety`, and always absent for hash-matched content). Each call logs `view_content`. |
| `GET /admin/albums/<id>` | The owner album shape plus moderation fields and every item's `safety`; items carry `staff_urls` like files. |
| `GET /admin/users/<id>` | `user` (id, username, email, created_at, verified), `staff`, `restrictions`, `warnings` (strike count), `counts` (files, albums, reports made, reports against), and the newest 50 files. |
| `POST /admin/rescans { checks, kinds?, uploaded_after? }` | `202 { "queued": n }`. Admin only. |
| `GET /admin/staff` | `{ "items": [{ user_id, username, role, child_safety, granted_at }] }`. Admin only. |

---

## 10. Worker changes (`cf-worker/`)

### 10.1 Routing and shells

**New routes** on `files.gg`, matched before the vanity lookup, in this order after `/convert`:
1. `/report` → `data-page="report"`, `#report-data` = `{ "type": "any" }`.
2. `/a/<vanity>/report` → `data-page="report"`, `#report-data` = `{ "type": "album", "vanity": "<vanity>" }`.
3. `/<vanity>/report` (the path ends in `/report`; the vanity is everything before it, minus any `.ext`) → `data-page="report"`, `#report-data` = `{ "type": "file", "vanity": "<vanity>" }`.
4. `/.well-known/security.txt` (§10.4).

Report pages are always **200**, with no lookup, the default meta tags and `Cache-Control: no-cache`. They never say whether the vanity exists; the API answers that when the form is sent.

**Shell states** (extends web/README.md §2 and milestone-2 §4):

| Case | `data-page` | `data-state` | Script tag | HTTP | Cache |
|---|---|---|---|---|---|
| File `pending` (not private) | `file` | `pending` | `#file-data` = `{ "vanity": "…", "pending": true }` | 200 | `private, no-store` |
| File `hidden` or `removed` (not private) | `file` | `removed` | `#file-data` = `{ "vanity": "…", "removed": "review" \| "terms" \| "copyright" \| "malware" }` | **410** | `no-cache` |
| File `blocked`, or private in any state | `file` | `missing` | `null` | 404 | as today |
| File `ok`, NSFW | `file` | `file` | the payload (`nsfw: true`) | 200 | as today |
| Album `hidden` or `removed` | `album` | `removed` | `#album-data` = `{ "vanity": "…", "removed": "<reason>" }` | **410** | `no-cache` |
| Album with no shown items and `pending_count > 0` | `album` | `pending` | `#album-data` = `{ "vanity": "…", "pending": true }` | 200 | `private, no-store` |
| Report page | `report` | (omit) | `#report-data` | 200 | `no-cache` |

- **Decision order for files** (first match wins):
  1. the API is unreachable → `unavailable`;
  2. not found, or expired → `missing`;
  3. `safety.state` is `blocked` → `missing`;
  4. visibility `private` → `missing`;
  5. `pending` → `pending`;
  6. `hidden` or `removed` → `removed`;
  7. visibility `password` → `locked`;
  8. otherwise `file`, with the CDN redirect rules.
  
  Albums follow the same order, with `pending` meaning "nothing shown yet, `pending_count > 0`".
- **Meta tags:** `pending` → `og:title` "Checking this file · files.gg", no image. `removed` → `og:title` "This file was removed · files.gg" ("This album was removed" for albums), no image. Neither includes the filename.
- **The CDN redirect** (`shouldRedirectToCdn`) only happens for `ok` `link` files that aren't NSFW (§4.6).
- The lookup cache key becomes `v4` (§6.3). A lookup without `safety` is treated as `pending`.

### 10.2 CDN (`cdn.files.gg`)

Per request: **parse → lookup (404 / 503 as today) → staff grant (§10.3) → access check (signature, as today) → safety state → serve.**

| Lookup `safety.state` | `/files/…` and `/previews/…` |
|---|---|
| `ok` | as today |
| `pending` | `404`, `private, no-store` |
| `hidden`, `removed` | `410`, `private, no-store` |
| `blocked` | `404`, `private, no-store` |

- **`serve_inline: false`** forces `Content-Disposition: attachment` on the file itself, and previews aren't served (`404`), whatever the type.
- **Albums:** an album whose `safety.state` isn't `ok` answers `410` (`private, no-store`) for its collage and ZIP. The ZIP contains only the items in the lookup, which are only `ok` items (§6.3). NSFW changes nothing on the CDN.
- **Errors carry no body detail** beyond the status (as today), except the ZIP's `ZIP_TOO_LARGE`.

### 10.3 The staff grant

A third grant for `/files/…` and `/previews/…` (milestone-3 §3 "Signed URLs"):

```
https://cdn.files.gg/files/abc123.png?staff=555555555555555555&expires=1795603600&sig=<signature>

grant = "staff:" + <staff user id> + ":" + <file id>
```

- Same signature formula and secret (`CDN_SIGNING_SECRET`), signed for one path. Only the API signs, only from the admin endpoints (§9.6), and every signing is logged.
- **Valid when** the signature matches the grant built from `staff=` and the lookup's `file.id`, `expires > now`, and **`expires <= now + 600`** (staff URLs live at most 10 minutes).
- **A valid staff URL skips the access check and the safety check,** so staff can see private, pending, hidden, removed and (non-CSAM) blocked content. Hash-matched content is never in a lookup (§6.3), so there's nothing to serve. `serve_inline: false` still forces `attachment`.
- Always `Cache-Control: private, no-store`. Never edge-cached (`cacheWrite: false`).
- `staff=` with an invalid signature is treated like any other bad signature (`401` for password files, `404` otherwise).

### 10.4 `security.txt`

Served from `web/public/.well-known/security.txt` (built into `web/dist`) at `/.well-known/security.txt` on **both** `files.gg` (as a root file) and `cdn.files.gg` (the one non-file path the CDN serves; with the CDN security headers), as `text/plain; charset=utf-8`:

```
Contact: mailto:security@files.gg
Contact: mailto:abuse@files.gg
Expires: <launch date + 1 year, ISO 8601>
Preferred-Languages: en
Canonical: https://files.gg/.well-known/security.txt
Policy: https://files.gg/legal/security
```

`Expires` must be renewed yearly (§15). The policy page is part of the legal pages.

---

## 11. Web changes (`web/`)

### 11.1 Viewer

- **Boot** (`boot.ts`): new states `pending`, `removed` (file and album) and the `report` page, parsed from §10.1's shapes. Anything malformed stays `missing`. `FileData` gains `nsfw`, `warnings` and `linkWarnings`.
- **Pending card:** "Checking this file…" and "This usually takes a few seconds." The page reloads itself after 2, 3, 5, 8 and 13 s, then every 15 s up to 2 minutes in total, then shows "Still checking. Large videos can take a minute or two." with **Retry**. No API polling.
- **Removed card** (per `removed`):
  - `review`: "This file is unavailable while it's reviewed.";
  - `terms`: "This file was removed for violating the Terms.";
  - `copyright`: "This file was removed after a copyright notice.";
  - `malware`: "This file was removed because it could harm your device."
  
  Albums say "album" instead of "file". Each has a link to the Terms.
- **NSFW interstitial** for files (§4.6), sharing a generalised `NsfwGate` with the album page: "This file may contain sensitive content", **Show**, **Leave**, and an "Always show sensitive media" checkbox that sets `filesgg.showSensitive`. Nothing under it mounts (no image, video, PDF or text fetch) before Show.
- **Warnings** (from `warnings`), as a banner above the card:
  - `encrypted_archive`: "This archive is encrypted and couldn't be scanned. Only download files from people you trust.";
  - `unwanted_software`: "files.gg's scanner flagged this file as potentially unwanted software.";
  - `archive_partially_scanned` and `too_large_to_scan`: "This file was too large to scan completely."
  
  With `unwanted_software` or `encrypted_archive`, Download asks for confirmation first.
- **Links (chosen):** a URL in `link_warnings` can't be opened from files.gg. The PDF viewer's "You're leaving files.gg" interstitial shows "This link may be dangerous: it's suspected of hosting malware, phishing or unwanted software.", a **Learn more** link for the matched threat type, and "Advisory provided by Google" linked to Google's Web Risk advisory page (wording rules in §5.7), with **Copy link** only. Album descriptions and captions render flagged URLs as plain text with a warning icon instead of links.
- **Report:** a **Report** button in the file footer and the album header opens the report dialog (a lazy chunk, `src/viewer/report/`), also used full-page by `data-page="report"`. The dialog:
  - picks a reason from §7.3's table for the target type (album: a `part` picker too);
  - has details (required for `other`, `bug` and `copyright`), a contact email when signed out, and the DMCA fields for `copyright`;
  - runs managed Turnstile (action `report`) when signed out;
  - sends `Authorization` from `filesgg.token` when present (`POST /reports`), otherwise `POST /reports/anonymous`;
  - confirms with "Report sent", plus "See it in My reports" (signed in) or "Sign in to hear back" (anonymous). For `escalated`: "Thank you. This has been escalated." and nothing else.
  
  The `report` page with `type: "any"` asks for the URL first.
- Footer actions for **owners** don't change, except a pending, hidden or removed file never reaches the viewer (the shell shows the state).

### 11.2 Dashboard

- **Sidebar badges:** My reports (`reports_unread`), Notices (`notices_unacknowledged`), and Admin for staff (`staff.open`, red when `p0 > 0`). From `GET /users/@me/badges`, fetched on load, every 60 s while visible, and on focus.
- **Notices banner:** on every dashboard page while `notices_unacknowledged > 0`: "You have N notices about your files or account" with a link to Notices. A suspended account sees only Notices, with "Your account has been suspended" (and an appeal button when allowed).
- **Upload restriction:** the Upload page shows "Uploads are restricted until <date>" and disables the dropzone while `restrictions` includes `uploads`.
- **My reports** (`/app/reports`): the list with status filter chips (open, resolved, dismissed) and search, 25 a page; a detail view with the target link, status, the thread (you vs. "files.gg staff"), a reply box (hidden once closed), and **Reopen** when `can_reopen`.
- **Notices** (`/app/notices`): newest first; each shows the action, rule text, target link, date, staff message, **Acknowledge** (and "Acknowledge all"), and **Appeal** when `can_appeal` (a dialog with the message; for `copyright`, the counter-notice fields), then the appeal state and staff reply.
- **Files and albums:**
  - NSFW tiles blurred with an eye-off icon (§4.6);
  - a "Checking…" badge on `pending` files, polled with `GET /users/@me/files/<id>` every 5 s while one is visible on the page (stops after 10 minutes);
  - "Hidden", "Removed" and "Blocked" badges linking to the notice; "Flagged" isn't shown to owners as a badge, only its `warnings`;
  - row and bulk actions **Mark as sensitive** / **Unmark** (disabled with a tooltip when `nsfw_locked`), and **Ask for review** on auto-marked files;
  - the album editor: a "Mark album as sensitive" switch, item badges, and a note on items that aren't shown yet because they're being checked.
- **Upload page:**
  - an "Adult content (NSFW)" checkbox for signed-in users (sends `nsfw=true`); signed out it isn't shown, with the hint "Sign in to upload sensitive media";
  - after a file finishes uploading, its row shows "Checking…" and polls `GET /users/@me/files/<id>` every 1 s for 30 s, then every 5 s up to 10 minutes, until `safety.state` leaves `pending`. Then it shows the link (ok, flagged), or the error for `410 UPLOAD_REJECTED { reason }`:

| `reason` | Message |
|---|---|
| `NSFW_REQUIRES_ACCOUNT` | Sign in to upload sensitive media. |
| `ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT` | Sign in to upload encrypted archives. |
| `MALWARE_DETECTED` | This file looks like malware, so it wasn't uploaded. |
| `FILE_TYPE_NOT_ALLOWED` | This file contains a type that isn't allowed on files.gg. |
| `FILE_BLOCKED` | This file can't be uploaded. |

- **`mock-api.ts`** gains every endpoint in this contract, including a staff user and a case of each kind, so `npm run dev` works without the API.

### 11.3 Admin pages (`/app/admin/*`)

- **(chosen)** Part of the dashboard app, as a **lazy chunk** (`src/app/admin/`), so non-staff never download it. Routes are added under `/app/admin` and render `NotFoundPage` unless `GET /users/@me` has `staff`. The API enforces access regardless (§9.1).

| Route | Page |
|---|---|
| `/app/admin` | Overview: the summary counts, past-goal counts, stalled scans, unrecorded CyberTipline reports (child safety) |
| `/app/admin/queue` | The case queue: columns priority, age, reasons, target, reporter count, target state, assignee; filters for status, reason, kind, assignee and "needs second review" |
| `/app/admin/cases/:id` | A case: target preview, reports and flags, history, claim and release, the action panel (§9.3) with rule picker and notice text, report thread messages with canned responses (a static list in `src/app/admin/canned.ts`), close, appeal decision, CyberTipline record |
| `/app/admin/files/:id`, `/app/admin/albums/:id`, `/app/admin/users/:id` | Target detail (§9.6) with the action panel |
| `/app/admin/lookup` | Search (`GET /admin/lookup`) |
| `/app/admin/bans` | Active bans, lift (admin) |
| `/app/admin/audit` | The audit log (admin) |
| `/app/admin/bugs` | Bug reports (the queue filtered to `kind: bug`) |

- **Moderator safety:** every image, video and poster in admin pages renders with `filter: blur(24px) grayscale(1)` and no hover playback until **Reveal** is clicked on that item. Reveal is per item and resets when leaving the page. Videos don't autoplay. Hash-matched cases render a "Not displayable" placeholder and never request a URL.
- **P0 banner:** on every admin page while `p0 > 0`: "N child-safety or P0 cases are open" linking to the queue filtered to P0.
- **Browser notifications (chosen: no Web Push in Milestone 4):** an opt-in "Notify me about new P0 cases" toggle (`Notification.requestPermission()` on click; the choice is stored in `localStorage["filesgg.admin.notify"]`). While any admin page is open, `GET /admin/summary` is polled every 30 s, and a notification fires when `newest_p0_at` increases. The notification text names no content: "New P0 case on files.gg".
- **The stalled-scans banner:** "Scanning is behind: N files waiting over 10 minutes", for admins, while `scans_stalled > 0`.

---

## 12. Error codes

New codes (the existing `CAPTCHA_INVALID` and `FILE_TYPE_NOT_ALLOWED` gain the uses noted):

Added by the 2026-11-25 security review, alongside the codes below:
- **the warning `encrypted_pdf`:** rendered like `encrypted_archive`, with the download confirmation;
- **the staff flag `scan_failing`:** a hash whose scan keeps failing (5 times by default) is held for staff instead of being retried forever.

| Code | HTTP | Details | Where |
|---|---|---|---|
| `NSFW_REQUIRES_ACCOUNT` | 403 | | Anonymous `nsfw=true`, anonymous de-duplication onto an NSFW hash, an anonymous owner marking NSFW |
| `ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT` | 403 | | Anonymous de-duplication onto a known encrypted archive |
| `ENCRYPTED_PDF_REQUIRES_ACCOUNT` | 403 | | Anonymous upload of a PDF with a user password (security review, 2026-11-25: treated like an encrypted archive) |
| `FILE_BLOCKED` | 403 | | Upload of blocked content (CSAM and others; never says which) |
| `MALWARE_DETECTED` | 400 | | Upload of content known as malware |
| `FILE_TYPE_NOT_ALLOWED` | 400 | | Also: a blocked sniffed type at upload |
| `UPLOAD_REJECTED` | 410 | `reason` (one of the five upload codes) | `GET /users/@me/files/<id>` within 24 h of a rejection after scanning |
| `FILE_PENDING` | 409 | `retry_after` | Public file API, unlock and `/view` on a pending file |
| `FILE_REMOVED` | 410 | `reason` | Public file API, unlock and `/view` on a hidden or removed file |
| `ALBUM_REMOVED` | 410 | `reason` | Public album API, unlock and `/view` |
| `NSFW_LOCKED` | 409 | | Unmarking a file marked by the classifier, reports or staff |
| `CANNOT_REPORT_YOURSELF` | 400 | | Reports |
| `INVALID_REPORT_TARGET` | 400 | | Reports: unknown target type, unparseable URL, wrong reason for the target |
| `DETAILS_REQUIRED` | 400 | `errors: { details }` | Reports |
| `DMCA_FIELDS_REQUIRED` | 400 | `errors: { <field>: message }` | Copyright reports and counter-notices |
| `MAX_REPORTS` | 429 | `retry_after` | Reports |
| `MAX_MESSAGES` | 429 | `retry_after` | Report messages |
| `UNKNOWN_REPORT` | 404 | | My reports |
| `REPORT_CLOSED` | 409 | | Messages on a closed report |
| `REOPEN_NOT_ALLOWED` | 409 | | Reopen |
| `UNKNOWN_WARNING` | 404 | | Notices |
| `APPEAL_NOT_ALLOWED` | 409 | | A second appeal, an unappealable notice, a second NSFW review request |
| `ACCOUNT_SUSPENDED` | 403 | `until` (`null` = until lifted) | Every endpoint a suspended account can't use (§8.4) |
| `UPLOADS_RESTRICTED` | 403 | `until` | Uploads, `POST /uploads`, album creation |
| `BANNED` | 403 | | Uploads and album creation from a banned fingerprint or IP ("Uploads from this device or network aren't allowed") |
| `TOO_MANY_UPLOADS` | 429 | `limit` | Upload rate limits (security review, 2026-11-25) |
| `VANITY_EXHAUSTED` | 409 | | A custom vanity pattern with no free values left (it used to hang the upload) |
| `UNKNOWN_CASE` | 404 | | Admin |
| `CASE_CLAIMED` | 409 | `assignee_id` | Admin claim |
| `SAME_MODERATOR` | 409 | | Appeal decisions |
| `INVALID_ACTION` | 400 | | Admin actions that don't apply to the target, or miss `rule` |

Messages are sentence case, as in `api/utils/errors.py`.

---

## 13. Config and limits

All environment variables, read through one `safety_settings()` (like `limits.defaults()`), with these defaults:

| Variable | Default | Notes |
|---|---|---|
| `CSAM_MATCHER` | (required) | `photodna` or `standin` (`standin` needs `FILESGG_DEV_TOOLS=1`) |
| `PHOTODNA_SUBSCRIPTION_KEY`, `PHOTODNA_MATCH_URL`, `PHOTODNA_TIMEOUT`, `PHOTODNA_MAX_RPS` | see §3.2 | |
| `STANDIN_MATCH_FILE`, `STANDIN_MODE` | see §3.3 | |
| `PDQ_MATCH_DISTANCE` | `31` | |
| `NSFW_THRESHOLD` | `0.85` | Starting value for the Marqo model; re-picked on a labelled set before launch (§4.1, §15) |
| `NSFW_UNMARKED_WARN` | `3` (in 30 days) | |
| `SCAN_WALL`, `SCAN_CPU`, `SCAN_ADDRESS_SPACE` | `120`, `90`, `2147483648` | |
| `SCAN_STALLED_AFTER` | `600` (s) | |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT` | `clamav`, `3310`, `120` | |
| `CLAMAV_MAX_BYTES` | `536870912` | |
| `CLAMAV_FLAG_ONLY_PREFIXES` | `PUA.,Heuristics.` | |
| `ARCHIVE_MAX_ENTRIES`, `ARCHIVE_MAX_DEPTH` | `10000`, `3` | |
| `ARCHIVE_MAX_UNPACKED`, `ARCHIVE_MAX_RATIO` | `21474836480`, `1000` | |
| `ARCHIVE_MAX_MATCHED_IMAGES`, `ARCHIVE_MAX_IMAGE_BYTES` | `100`, `20971520` | |
| `WEB_RISK_API_KEY` | (unset = skipped) | |
| `WEB_RISK_STANDIN_FILE` | (unset) | Dev only |
| `WEB_RISK_MAX_URLS` | `100` | |
| `REPORT_THRESHOLDS` | `{"violence":2,"malware":2,"adult_unmarked":2,"harassment":3,"spam":3}` | JSON. `csam` and `ncii` always act at 1. |
| `REPORT_RATE_PER_HOUR` | `10` | Per account, fingerprint and IP hash |
| `REPORT_MESSAGE_RATE_PER_HOUR` | `30` | |
| `REPORT_REOPEN_DAYS`, `REPORT_CLOSE_AFTER_DAYS`, `REPORT_RETENTION_DAYS` | `14`, `30`, `365` | |
| `STRIKES_WINDOW_DAYS`, `STRIKES_RESTRICT`, `RESTRICT_DAYS` | `90`, `3`, `30` | |
| `HOLD_DAYS_DEFAULT`, `HOLD_DAYS_MAX` | `90`, `365` | Moderator deletes |
| `EVIDENCE_RETENTION_DAYS` | `365` | Legal question (§15) |
| `S3_BUCKET_EVIDENCE`, `S3_EVIDENCE_ACCESS_KEY_ID`, `S3_EVIDENCE_SECRET_ACCESS_KEY` | (required) | A key that can write to and copy into the evidence bucket, but **not read or delete** from it |
| `EVIDENCE_PUBLIC_KEY` | (required) | libsodium public key (base64) for sealed IPs |
| `ABUSE_HASH_SECRET` | (required) | `openssl rand -hex 32`. Rotating it makes old bans and hashes useless. |
| `ABUSE_IP_KEEP_DAYS` | `30` | Also the sealed IP's lifetime |
| `STAFF_URL_TTL` | `600` (s) | The Worker also caps it at 600 |

`docker-compose.yml` makes the required ones `${VAR:?}`, adds the `clamav`, `scanner` and `rescanner` services (no feed sidecar, §5.2), and gives only `scanner` and `rescanner` the matcher, ClamAV, Web Risk and evidence settings. The API gets `ABUSE_HASH_SECRET`, `EVIDENCE_PUBLIC_KEY` and the matcher settings it needs to validate config.

**Images:** the **base** target adds `libmagic1` and `python-magic` (the API sniffs at upload) and PyNaCl (sealing). The **worker** target adds `libarchive-tools` (and `libarchive-c`), `qpdf`, `onnxruntime`, `pdqhash` (built from its sdist in a build stage with `g++`, §3.4), `oletools`, and the checked-in ONNX model with its preprocessing JSON (§4.1). All pinned exactly, per the version policy. The export tooling (`torch`, `timm`, `huggingface_hub`, `onnx`) is never installed in any image. **The worker target runs Python 3.14**, not 3.15, until `onnxruntime` publishes cp315 wheels (§4.1); every worker dependency must have cp314 wheels or build on 3.14.

**`GET /users/@me/limits`** adds `nsfw_allowed` (`true` signed in and not restricted, `false` anonymous).

**Scheduled tasks** (`jobs/tasks.py`): `scan_sweeper` (5 min), `rescan_scheduler` (10 min), `report_closer` (1 h), `safety_retention` (daily: IP hashes and sealed IPs past 30 days, contact emails, old reports, expired holds), `safety_rate_limits_cleanup` (1 h).

---

## 14. Test vectors

### 14.1 Staff grant signatures

Secret `test-cdn-signing-secret`, the formula from milestone-3 §3 (`"filesgg-cdn-1" \n path \n expires \n grant`, HMAC-SHA256, base64url without padding). Both the API and the Worker must reproduce these exactly. Check them with "now" earlier than `expires` and within 600 s of it.

| URL path and query | grant | sig | Expected |
|---|---|---|---|
| `/files/abc123.png?staff=555555555555555555&expires=1795603600` | `staff:555555555555555555:1234567890123456789` | `xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk` | accepted (file id `1234567890123456789`) |
| `/previews/thumb/abc123.webp?staff=555555555555555555&expires=1795603600` | `staff:555555555555555555:1234567890123456789` | `iFEB3jhXpXydlpjhc4oefiKwO4n2afK7iXj3MJ4mIVY` | accepted |
| `/files/abc123.png?staff=555555555555555555&expires=1795603600` | (signed for `staff:555555555555555556:1234567890123456789`) | `yw_60Ca7UMA3Y07HsKVPtC9j-1TwPAo3rx7Ne4r2Epw` | **rejected**: the grant built from `staff=` doesn't match |
| the first row, checked when now = `1795602900` | | | **rejected**: `expires` is more than 600 s away |

The existing milestone-3 vectors still pass unchanged.

### 14.2 Abuse IP hashes

Secret `test-abuse-hash-secret`, hex output:

| IP | normalized | `abuse_ip_hash` |
|---|---|---|
| `203.0.113.7` | `203.0.113.7` | `a066857f2c5094fa4d5bd59bf031051e48131a610ccec3498859cfb8b5116f6a` |
| `::ffff:203.0.113.7` | `203.0.113.7` | `a066857f2c5094fa4d5bd59bf031051e48131a610ccec3498859cfb8b5116f6a` |
| `2001:db8::1` | `2001:db8::/64` | `99bb79de0d1a09f4cf06d6f990b73af2636a74ffd22e8b6db9540b74964fda64` |
| `2001:0DB8:0000:0000:abcd::9` | `2001:db8::/64` | `99bb79de0d1a09f4cf06d6f990b73af2636a74ffd22e8b6db9540b74964fda64` |

### 14.3 Effective state (§2.4)

| `scan_state` | file `moderation_state` | visibility | Shell | CDN | Owner `safety.state` |
|---|---|---|---|---|---|
| `pending` | `visible` | `link` | `pending` 200 | 404 | `pending` |
| `pending` | `visible` | `private` | `missing` 404 | 404 (no signature) | `pending` |
| `passed` | `hidden` | `password` | `removed` (`review`) 410 | 401 without signature, 410 with a valid one | `hidden` |
| `flagged` | `visible` | `link` | `file` 200 | 200 | `flagged` |
| `held` | `visible` | `link` | `removed` (`review`) 410 | 410 | `hidden` |
| `blocked` (`malware`) | `removed` | `link` | `missing` 404 | 404 | `blocked` |
| `blocked` (`csam_match`) | any | any | `missing` 404 (lookup 404) | 404 | `blocked` (reason `FILE_BLOCKED`) |
| `passed` | `visible` | `link`, NSFW | `file` 200, no CDN redirect for bots | 200 | `ok` |

### 14.4 NSFW (§4.4)

| `nsfw_auto` | `nsfw_marked` | `nsfw_override` | `nsfw` | `nsfw_source` | Uploader can unmark |
|---|---|---|---|---|---|
| false | false | `NULL` | false | `null` | — |
| false | true | `NULL` | true | `uploader` | yes |
| true | false | `NULL` | true | `auto` | no (`NSFW_LOCKED`) |
| true | true | `NULL` | true | `uploader` | no: unmarking leaves `auto` |
| true | false | `safe` (moderator) | false | `moderator` | — |
| false | false | `nsfw` (reports) | true | `reports` | no |

Score example: three frames whose `NSFW` probabilities are 0.15, 0.92 and 0.01 give `nsfw_score = 0.92`, so `nsfw_auto = true` at the starting threshold of 0.85.

### 14.5 Scanning fixtures

Generated in tests, never committed as live malware or real abuse material:
- **Stand-in CSAM:** `match.png` and `match-small.jpg` (§3.3) must block with `csam_match` and run §3.6 against MinIO buckets (the evidence bucket with Object Lock enabled); `clean.png` must pass; `STANDIN_MODE=unavailable` must leave the hash `pending` and the CDN at 404.
- **ClamAV:** the EICAR test string, written by the test at runtime, must block with `malware`. A file built to match a test `PUA.` signature in a test-only database must flag.
- **Archives:** a zip containing `setup.exe`; a zip containing `game/bin/tool.EXE`; a zip containing an ELF named `readme.txt`; a nested zip at depth 2 containing a `.scr`; an encrypted zip (ZipCrypto and AES) uploaded anonymously and signed in; a zip bomb by ratio (a small zip declaring 30 GiB); a zip with 10,001 empty entries.
- **Office:** a `.docx` with `vbaProject.bin`; a `.xlsx` with an XLM macro sheet; a `.docx` with a remote template.
- **PDF:** one with `/JavaScript` (flag); with `/J#61vaScript` in an object stream (flag); with `/Launch` (block); with an embedded `.exe` (block).
- **Polyglots:** a PNG with a zip appended (flag, and the zip is inspected); a PNG with a zip containing an `.exe` appended (block); a GIF that's also HTML (passes; the Phase 5 suite checks the CDN headers).
- **NSFW:** the classifier is mocked in unit tests (a fixed score per fixture); one integration test runs the real model on a non-adult image and checks the score is below `NSFW_THRESHOLD` and that the ONNX and preprocessing JSON hashes match. The export step's equivalence check (§4.1) uses these fixture images too.

---

## 15. Ops and legal checklist (not code)

**None of these are code.** They gate launch (PLAN.md Phase 5 "Safety gates") and need an owner and a date each. The legal items need a lawyer.

**Child safety**
- [ ] Enable **Cloudflare's CSAM Scanning Tool** on the zone, with a monitored notification address.
- [ ] Apply for **PhotoDNA Cloud Service** access (`https://myphotodna.microsoftmoderator.com/Profile`; third-party vetting, free for qualified organisations). Record the confirmed endpoint, header, fields, status codes, image limits, monthly allowance, rate limit and test images in §3.2, and ask how the 30-day term renews and whether the 2027 Content Moderator retirement affects billing above the free allowance.
- [ ] **Register with NCMEC** as an electronic service provider for **CyberTipline** reporting, and learn the reporting process (what to include, timelines).
- [ ] Test the reporting path **end to end with the vendor's test images** (never real material): match → block → evidence → case → report filed and recorded.
- [ ] Generate the **evidence key pair**; the private key stays offline with the child-safety lead, with a documented backup. Put the public key in `EVIDENCE_PUBLIC_KEY`.
- [ ] Create the **evidence bucket** in B2 with Object Lock (compliance mode) and a key that can't read or delete **in the evidence bucket**. That key also needs **read access to the files bucket**, because the preservation step is a server-side copy from it. Write the break-glass procedure for law-enforcement requests.
- [ ] Confirm with counsel: the **preservation period** (`EVIDENCE_RETENTION_DAYS`), keeping **sealed uploader IPs** for 30 days, and what to include in reports.
- [ ] Name the child-safety staff, and give moderators wellbeing support and the blur-by-default tooling.

**Legal**
- [ ] Register a **DMCA designated agent** with the US Copyright Office's online system, and publish the agent's details. **Fee:** $6 per designation, amendment or resubmission until 2027-01-04; **$25 from 2027-01-05** (final rule of 2026-11-18, FR doc. 2026-23415). **Term:** a designation expires **three years** after registration unless it's amended or resubmitted, which restarts the three years (37 CFR 201.38(c)(4)). Set a renewal reminder.
- [ ] Update the **Terms**: prohibited content, the NSFW rules (adult content allowed, always marked, signed-in only), enforcement, strikes, the repeat-infringer policy, appeals.
- [ ] Update the **Privacy policy**: scanning of every upload including protected files, the third parties that receive data (Microsoft PhotoDNA, Google Web Risk, Cloudflare), IP hashing and sealed IPs, report retention, evidence preservation.
- [ ] Publish the **security policy** page linked from `security.txt`.
- [ ] **UK and EU duties** (Online Safety Act, Digital Services Act): what applies at files.gg's size.
- [ ] **Age verification:** whether hosting marked adult content requires it anywhere files.gg has users (PLAN.md §4 items 6 and 8).
- [ ] Review the public report copy: no time-bound promises ("We review every report. Child-safety reports are prioritised.").

**Mail and reputation**
- [ ] Set up `abuse@`, `security@` and `dmca@files.gg` with Cloudflare Email Routing, forwarding to a staffed mailbox (automatic reports from `abuse@` are a later step).
- [ ] Set `security.txt`'s `Expires` and a yearly reminder to renew it.
- [ ] Verify `files.gg` and every subdomain in **Google Search Console**; subscribe to **Safe Browsing** alerts and Cloudflare abuse notifications, routed to the staffed mailbox.
- [ ] Consider partnerships: **StopNCII.org** (NCII hashes) and **Tech Against Terrorism TCAP** alerts; GIFCT later.

**Services and keys**
- [ ] A **Google Web Risk** billing account and API key (pricing and quotas checked 2026-11-25, §5.7: 100,000 free `uris.search` calls a month, then $0.50 per 1,000), with a budget alert. Never enable `threatLists.computeDiff` on that project.
- [ ] Pick the initial **YARA** rule set for `clamav/rules/` (§5.2). ClamAV uses its official signatures only.
- [ ] **Measure the NSFW model** (Marqo `nsfw-image-detection-384`, §4.1) before launch, on a labelled set of legal adult and non-adult images (including drawings, swimwear and medical images): **precision and recall** across candidate thresholds, then re-pick `NSFW_THRESHOLD` (starting value 0.85) and record the result here. Also measure the **CPU time per image** inside the `scan` sandbox (2 GiB address space, 90 s CPU), including an 8-frame video and a 3-page PDF, and confirm it fits.
- [ ] Run the NSFW **export step** once (§4.1), commit the ONNX file and its preprocessing JSON, and pin both SHA-256s and the Hugging Face commit.
- [ ] Set the files bucket's lifecycle to **keep only the latest version**, so deletes (including CSAM removal) really remove bytes.
- [ ] Grant the first staff with `python -m tools.staff`.

**Before the public launch**
- [ ] The Phase 5 `cdn.files.gg` hardening test suite passes (HTML, SVG, a PDF with `/JavaScript`, a polyglot, a renamed `.exe`, an archive containing an `.exe`, an encrypted archive, a macro `.docx`, a bidi-trick filename), plus securityheaders.com and the `__Host-` cookie check.
- [ ] The report system is live end to end: file, album, user and bug reports, signed in and anonymous, My reports, Notices and appeals, the admin queue with P0 banners and browser notifications.
