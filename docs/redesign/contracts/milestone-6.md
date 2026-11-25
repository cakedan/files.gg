# Milestone 6 contract (accounts)

> Later renamed: the anonymous uploader's *fingerprint* is now a *guest* (`guest_id`, `Authorization: Guest`); see milestone-5.md §20.

This is the shared contract between `api/`, `cf-worker/` and `web/` for Milestone 6. It covers:
- the account model: unique usernames, display names, email verification, argon2id passwords;
- web sessions (an HttpOnly cookie on `files.gg`) and their revocation;
- login methods: email and password, and Discord as a linked identity;
- the sign-in pages;
- upload keys for ShareX, scripts and apps;
- the dashboard's Integrations and Settings (profile, login methods, sessions, data export, account deletion with a grace period);
- premium entitlements, granted by staff for now, and the limits they raise;
- custom domains on Cloudflare for SaaS, with "Only my files" and domain-only mode;
- how all of it fits Milestone 4's trust and safety rules.

The design behind each item is in [`../PLAN.md`](../PLAN.md): Phase 0 "Auth"; Phase 1 "Accounts and identities", "Unique usernames, no discriminators", "Human verification and upload keys", "Limits", "Custom domains (premium)" and "Hardening `cdn.files.gg`" part B; Phase 3 "Integrations" and "Settings"; §4 items 1, 9, 14 and 18. This file pins the **exact formats**. When this file and the plan disagree, this file wins for Milestone 6. Fix the plan afterwards. In particular, the plan's "No auth cookie, ever" (Hardening part B) is replaced by the host-only session cookie in §3, decided by the owner on 2026-11-25. Everything in [`milestone-4.md`](milestone-4.md), [`milestone-3.md`](milestone-3.md) and what they keep of [`milestone-2.md`](milestone-2.md) still holds unless it's changed here.

Vendor details (Discord, Cloudflare, ShareX, argon2-cffi, Turnstile) were checked against the vendors' own pages on 2026-11-25. Sources are cited where they matter and listed in §18, with everything that couldn't be confirmed.

**Not in Milestone 6:**
- paid plans and billing (premium is granted by staff, §9);
- apex (root) custom domains, which need Cloudflare's Enterprise apex proxying (§10.1);
- signing in on custom domains (owner passes cover it, as the plan decided);
- public profile pages;
- uploaded avatars (§2.4);
- the "default text editor" setting (there's no editor yet; Monaco's "open in editor" mode is still unbuilt);
- an iOS Shortcut for upload keys;
- GitHub secret scanning partnership for `fgg_` and `fgs_` tokens (the formats are ready for it, §7.1; enrolment is a later ops step);
- Web Push and email notifications beyond the ones listed in §2.7;
- login with GitHub or Google (the `user_identities` table already allows them).

---

## Decisions made in this contract

The plan left these open. Each is marked **(chosen: …)** where it appears. Those marked **(owner, 2026-11-25)** were decided by the project owner after the first draft; the rest are engineering choices. Review them before building.

1. **(owner, 2026-11-25) Web sessions are an HttpOnly cookie,** `__Host-filesgg_session` (`Secure`, `HttpOnly`, `Path=/`, no `Domain`, `SameSite=Lax`), holding an opaque `fgs_` session token that's stored hashed in a `sessions` table. It exists only on `files.gg`. The dashboard and the `files.gg` viewer call the API **same-origin** at `files.gg/api/…`, and the Worker forwards the cookie only there. The API never accepts a session from an `Authorization` header (§3).
2. **(owner, 2026-11-25) CSRF:** `SameSite=Lax`, plus a required `X-Filesgg-Csrf: 1` header on every state-changing request that carries the session cookie and on every `/auth/*` `POST`, plus `Origin` and `Sec-Fetch-Site` checks when the browser sends them. Without them: `403 CSRF` (§3.6).
3. **(owner, 2026-11-25) Session lifetime:** a session ends 30 days after its last use, and 180 days after sign-in at the latest. At most 50 sessions per account; the 51st sign-in ends the oldest (§3.3).
4. **Token formats:** sessions are `fgs_` and upload keys `fgg_`, each 30 random base62 characters plus a 6-character base62 CRC32 checksum (40 characters in all), so secret scanners can find them and the API rejects typos without a database lookup (§7.1).
5. **Revocation is by row, not by version:** there's no `token_version` or `last_password_reset_at`. Signing out ends one session row and clears the cookie; "Sign out everywhere" ends every session including the current one; a password change ends the others; a password reset ends all and starts a new one (§3.4).
6. **Re-authentication:** changing the email or password, unlinking Discord and requesting account deletion need a session that proved the password (or Discord) within the last 10 minutes (`403 REAUTH_REQUIRED`) (§3.5).
7. **Email links are single-use random tokens** in an `account_tokens` table, carried in the URL **fragment** (`#token=`), so they never reach a server log or a `Referer` (§2.5).
8. **(owner, 2026-11-25) Usernames:** 2–32 characters from `[a-z0-9_.]`, no leading, trailing or doubled `.`, not all digits, not `u` followed only by digits, input lowercased; the reserved list in §2.2; **one change every 30 days**; a released name is held for **30 days**, and only its previous owner can take it back during the hold (§2.2).
9. **(owner, 2026-11-25) Display names:** optional, 1–32 characters after cleaning, not unique, and can't impersonate files.gg (§2.3).
10. **(owner, 2026-11-25) No avatar uploads.** Avatars are generated initials tiles (§2.4).
11. **(owner, 2026-11-25) Passwords:** at least 8 characters, **no maximum length** (the only bound is the 64 KiB request-size limit on the endpoints that take passwords), and not equal to the username or email; argon2id with argon2-cffi's defaults (RFC 9106's second recommended profile: t=3, 64 MiB, p=4), the same hasher as file passwords. Signing in works before the email is verified (§2.6, §4.8).
12. **Login is by email only,** not by username, so the login form doesn't confirm which usernames exist (§4.1).
13. **Forgot password always answers `204`,** whether or not the email has an account. `UNKNOWN_EMAIL` is removed (§4.4).
14. **(owner, 2026-11-25) Discord sign-up asks for the `identify` and `email` scopes.** A **verified**, unused Discord email becomes the account's verified email. Otherwise the account is created with no email, which the plan allows. Nothing syncs from Discord after creation (§5.5).
15. **(owner, 2026-11-25) Email collisions are never merged:** a Discord sign-up whose verified email belongs to an existing account is refused with `DISCORD_EMAIL_IN_USE`, telling the person to sign in and link Discord from Settings (§5.5).
16. **Discord OAuth:** authorization code with **PKCE (S256)**. The browser makes and keeps the verifier; the API is a confidential client (client secret plus the verifier) and signs a 10-minute `state`. Discord tokens are revoked right after `/users/@me` is read, and never stored. A successful sign-in sets the session cookie (§5).
17. **(owner, 2026-11-25) Turnstile on every unauthenticated auth endpoint that signs in, creates an account or sends an email:** login, register, the Discord callback, Discord sign-up, forgot and reset. Verifying an email (the link is the proof) and authenticated endpoints don't use it (§4.6).
18. **(owner, 2026-11-25) Auth pages live in the dashboard app** at `/app/login`, `/app/register`, `/app/verify`, `/app/forgot`, `/app/reset` and `/app/auth/discord`, so the Worker serves them like the rest of `/app`. `files.gg/login` and `files.gg/register` redirect there (§6).
19. **Reserved vanity segments** gain `login`, `register`, `signup`, `challenge`, `files`, `previews` and `albums`. The last three keep custom domains' byte paths unambiguous (§6.3, §10.8).
20. **New accounts get a fresh Snowflake id.** Today `register` reuses the anonymous fingerprint as the user id; that stops. Fingerprint files **and anonymous albums** are still claimed on sign-up and sign-in (§4.2).
21. **Upload keys:** scopes `files:upload` (always) and `albums:append` (optional); at most 20 active keys per account; an optional expiry; an optional pinned custom domain; 600 uploads an hour per key. They authenticate only the upload endpoints, sent as `Authorization: Key fgg_…`, header-only, from tools (§7).
22. **Anonymous tool uploads** (no credential and **no** `turnstile_token` at all) get `401 UPLOAD_KEY_REQUIRED`. A present but invalid Turnstile token is still `CAPTCHA_INVALID` (§7.5).
23. **The `.sxcu` is generated in the browser** from the create response, once, because it contains the key. Its `Version` is `"17.0.0"`, the value in ShareX's own documentation (§7.7).
24. **(owner, 2026-11-25) Account deletion has a 14-day grace period.** Requesting it locks the account, ends every other session and takes the account's files and albums offline at once (they look missing, never "removed"). Signing in and choosing **Keep my account** within 14 days cancels it. After 14 days a job deletes permanently: files and albums soft-deleted into normal blob garbage collection, Milestone 4 evidence holds respected, the user row kept as a scrubbed tombstone, reports the person filed kept but anonymised. Staff and suspended accounts can't request it (§8.8).
25. **(owner, 2026-11-25) Data export** is the account's data as JSON files in a ZIP (account, identities, sessions, upload keys, domains, file and album metadata, reports filed with their threads, notices). It doesn't include file bytes; albums already have "Download all". One export a day, kept 7 days (§8.7).
26. **(owner, 2026-11-25) Suspended accounts** can also, beyond Milestone 4's list, change their password, manage their sessions and request a data export. They can't create upload keys, add domains, link Discord or request deletion (§11.1).
27. **Bans** (Milestone 4 fingerprint and IP bans) now also refuse **account creation**, by email or Discord, from the banned fingerprint or IP (`403 BANNED`) (§11.3).
28. **Entitlements are rows,** not a `users` column: a `user_entitlements` table with `kind = 'premium'`, an optional expiry and revocation, audited in `moderation_actions`. The plan's `User.custom_domains_override` isn't built (§9.1).
29. **(owner, 2026-11-25) Premium raises limits** through `get_limits()`: storage 100 GB, chunked uploads up to 5 GB, single-request uploads up to 500 MB, plus 5 custom domains and domain-only mode. `storage_limit_override` stays as a manual per-user storage override. Single-request uploads are still capped by Cloudflare's request-body limit (100 MB below Business), which is an infrastructure change to make (§9.2, §9.5).
30. **Granting premium is admin-only,** through `/admin/users/<id>/entitlements` and a `tools.entitlements` CLI (§9.3).
31. **Custom domain validation:** the customer adds **two records**, a CNAME to `domains.files.gg` and our TXT `_filesgg-verify.<hostname>`. Cloudflare validates the hostname in real time through the CNAME and issues the certificate with **HTTP DCV** (`ssl.method: "http"`), which needs no extra record once the CNAME is live (§10.2).
32. **No Cloudflare webhooks.** Cloudflare's custom hostname notifications cover certificates only, so the API polls (§10.4).
33. **Domain statuses:** `pending_dns`, `pending_cert`, `active`, `failing`, `failed`, `paused`, `disabled`, mapped from Cloudflare's `status` and `ssl.status` plus our own DNS checks (§10.3).
34. **The domain lookup is cached for 5 s,** like every other Worker lookup (the plan said 60 s) (§10.7).
35. **Domain-only mode is enforced only by the Worker,** on `files.gg` and `cdn.files.gg`. The API's public endpoints never apply it; it's branding, not privacy. Toggling it doesn't bump `access_version` (§10.6).
36. **Payload URLs:** the API keeps writing `cdn.files.gg` URLs. The Worker and the viewer **rehost** them onto a custom domain, which keeps signatures valid because they cover the path only. Owner-facing payloads add `direct_url`, and their `url` uses the default domain (§10.9).
37. **Turnstile on custom domains** (password unlocks and anonymous reports) runs in a small frame served by `files.gg/challenge`, because a Turnstile widget allows at most 10 hostnames on the free plan (§10.10).
38. **The viewer on a custom domain** calls `api.files.gg` cross-origin **without credentials** (unlock, `/view`, refresh, reports). Owner-only actions exist only in the dashboard on `files.gg` (§10.11, §13.4).
39. **Staff URLs work only on `cdn.files.gg`,** never on custom domains (§10.9).
40. **Domain reports and moderation:** a new report and case kind `domain`; staff actions `disable_domain`, `enable_domain` and `set_domain_scope`. A staff-disabled domain can't be deleted by its owner, so nobody can re-add the hostname (§10.12).
41. **(owner, 2026-11-25) Deleted custom hostnames:** a domain pending for 72 h, failing for 3 days, or paused for 30 days has its Cloudflare hostname deleted (§10.3).
42. **No public user profiles:** `GET /users/<id>` answers `404` except `@me`. Users are reported from the album owner line (when shown) and from admin pages (§8.1, §11.4).
43. **Request-size limits:** 64 KiB for the auth and password endpoints, 1 MiB for every other JSON endpoint, and the upload limits for `POST /files` and chunks (`413 REQUEST_TOO_LARGE`) (§4.8).

Every owner call raised by the first draft was decided on 2026-11-25 and is in the list above. One infrastructure question remains for the owner: how to let 500 MB single-request uploads through Cloudflare (§9.5).

---

## 0. Ground rules

- **Fresh launch.** No accounts, sessions or tokens exist to keep working (PLAN.md §0, 2026-11-25). Migration `0005_accounts.sql` assumes the `users` table is empty, like Milestone 4's migration. A development database with users must be recreated.
- **Old credentials are gone:** itsdangerous `UserToken`, `EmailVerifyToken` and `EmailForgotToken`, Werkzeug PBKDF2 hashes, every form of a user token in the `Authorization` header, the web app's stored token, and the old ShareX configs. `FingerprintToken` stays (anonymous uploads).
- **Errors** keep the Milestone 3 shape: `{ code: "STRING", message, status, ...details }`. Field errors keep `errors: { <field>: message }`. Payloads are snake_case, times in epoch seconds, ids as strings.
- **Multi-server rules** (PLAN.md §2.1) apply: no in-process sessions or caches. OAuth `state` and the Discord sign-up token are signed and stateless; sessions, email tokens and rate limits live in Postgres.
- **Nothing here weakens Milestone 4.** Every upload path, whatever authenticates it, goes through `standing.check_uploader`, scanning and the reports system unchanged. The internal-lookup protections from the 2026-11-25 security review (both headers required, `/internal` unreachable through either passthrough) stay exactly as they are.

---

## 1. Schema: `api/migrations/0005_accounts.sql`

One transaction. Snowflake ids are `bigint`; times are `timestamptz`; foreign keys are real.

### 1.1 `users` (redesigned)

Dropped: `discriminator`, `bot`, `flags`, `password`, `verified`, `last_email_reset_at`, `last_password_reset_at`, and the indexes `users_username_discriminator`, `users_username` and `users_email`.

| Column | Notes |
|---|---|
| `id bigint PRIMARY KEY` | unchanged |
| `username text NOT NULL` | §2.2. `CHECK (username ~ '^([a-z0-9_][a-z0-9_.]{0,30}[a-z0-9_]\|deleted-[0-9]+)$' AND username !~ '\.\.')`. Unique index `users_username` on `username` (already lowercase). |
| `display_name text` | §2.3. `CHECK (char_length(display_name) BETWEEN 1 AND 32)`. |
| `email text` | Nullable (Discord-only accounts). `CHECK (char_length(email) <= 254)`. Partial unique index `users_email` on `lower(email) WHERE email IS NOT NULL`. |
| `email_verified boolean NOT NULL DEFAULT false` | Replaces `verified`. |
| `pending_email text` | An email change waiting for its link (§8.4). Not unique; checked at confirm time. |
| `password_hash text` | argon2id (§2.6). `NULL` = no password. `CHECK (password_hash LIKE '$argon2id$%')`. |
| `needs_username boolean NOT NULL DEFAULT false` | Set by a staff `reset_username` (§11.4). The dashboard then asks for a new name. |
| `username_changed_at timestamptz` | The last self-service rename (§2.2 cooldown). `NULL` = never renamed. |
| `show_name_on_albums boolean NOT NULL DEFAULT false` | Milestone 3 deferred this setting here (§8.6). |
| `domain_only boolean NOT NULL DEFAULT false` | Domain-only mode, as set by the owner (§10.6). |
| `domain_only_paused_at timestamptz` | When domain-only last paused automatically (to send one email, not one per check). |
| `storage_limit_override bigint` | unchanged: a manual storage limit that wins over the plan and premium defaults (§9.2) |
| `created_at timestamptz NOT NULL DEFAULT now()` | |
| `deletion_requested_at timestamptz` | §8.8. Set while a deletion is pending. |
| `deletion_scheduled_for timestamptz` | §8.8. `deletion_requested_at + 14 days`. `CHECK ((deletion_requested_at IS NULL) = (deletion_scheduled_for IS NULL))`. Index `WHERE deletion_scheduled_for IS NOT NULL`. |
| `deleted_at timestamptz` | §8.8. Set by the permanent deletion; the row is then a scrubbed tombstone. |

An account's **state** is derived: `deleted` when `deleted_at` is set, else `pending_deletion` when `deletion_requested_at` is set, else `active`.

### 1.2 New tables

| Table | Columns |
|---|---|
| `username_holds` | `username text PRIMARY KEY`; `user_id` → `users` `ON DELETE CASCADE` (the previous owner); `released_at`; `held_until`. Deleted by the daily cleanup once `held_until` passes. |
| `user_identities` | As PLAN.md "Accounts and identities": `id`; `user_id` → `users` `ON DELETE CASCADE`; `provider text CHECK (provider IN ('discord'))`; `provider_user_id text NOT NULL`; `username text` (cached Discord username); `display_name text` (cached `global_name`); `avatar text` (cached avatar hash); `created_at`; `last_used_at`. `UNIQUE (provider, provider_user_id)`, `UNIQUE (user_id, provider)`. |
| `sessions` | `id` (snowflake); `user_id` → `users` `ON DELETE CASCADE`; `token_hash bytea NOT NULL UNIQUE` (SHA-256 of the whole token, 32 bytes); `method text CHECK (method IN ('password', 'discord', 'register', 'reset'))`; `created_at`; `authenticated_at` (last password or Discord proof, §3.5); `last_used_at`; `expires_at` (idle expiry); `max_expires_at` (absolute); `user_agent text` (≤ 256 characters, as sent); `country text` (`CF-IPCountry` at sign-in, 2 letters or `NULL`); `last_country text`; `revoked_at`; `revoked_reason text CHECK (revoked_reason IN ('logout', 'user', 'everywhere', 'password_change', 'password_reset', 'limit', 'staff', 'deletion_requested', 'account_deleted'))`. Index `(user_id) WHERE revoked_at IS NULL`. No IP addresses. |
| `account_tokens` | `id`; `user_id` → `users` `ON DELETE CASCADE`; `purpose text CHECK (purpose IN ('verify_email', 'reset_password'))`; `email text NOT NULL` (the address the link was sent to); `token_hash bytea NOT NULL UNIQUE`; `created_at`; `expires_at`; `used_at`. |
| `upload_keys` | As PLAN.md "Human verification and upload keys", plus: `id`; `user_id` → `users` `ON DELETE CASCADE`; `name text CHECK (char_length(name) BETWEEN 1 AND 64)`; `prefix text NOT NULL` (the first 12 characters, §7.1); `key_hash bytea NOT NULL UNIQUE`; `scopes text[] NOT NULL CHECK (scopes <@ ARRAY['files:upload', 'albums:append'] AND 'files:upload' = ANY(scopes))`; `domain_id` → `custom_domains` `ON DELETE SET NULL`; `created_at`; `expires_at` (`NULL` = never); `last_used_at`; `revoked_at`; `revoked_reason text CHECK (revoked_reason IN ('owner', 'staff', 'account_deleted', 'expired'))`. |
| `user_entitlements` | `id`; `user_id` → `users` `ON DELETE CASCADE`; `kind text CHECK (kind IN ('premium'))`; `granted_by` → `users` `ON DELETE SET NULL`; `granted_at`; `expires_at` (`NULL` = until revoked); `revoked_at`; `revoked_by` → `users` `SET NULL`; `note text` (≤ 2,000, staff only); `action_id` → `moderation_actions`. Partial unique index: one row per (`user_id`, `kind`) `WHERE revoked_at IS NULL`. |
| `custom_domains` | As PLAN.md "Custom domains", plus: `id`; `user_id` → `users` `ON DELETE CASCADE`; `hostname text NOT NULL` (lowercase, punycode, §10.1); `cf_hostname_id text`; `status text CHECK (status IN ('pending_dns', 'pending_cert', 'active', 'failing', 'failed', 'paused', 'disabled'))`; `status_reason text` (§10.3); `verify_token text NOT NULL`; `is_default boolean NOT NULL DEFAULT false`; `scope text NOT NULL DEFAULT 'own' CHECK (scope IN ('own', 'any'))`; `cf_status text`, `cf_ssl_status text` (as last seen); `dns_txt_ok boolean`, `dns_cname_ok boolean` (last check); `verified_at` (first time `active`); `last_checked_at`; `next_check_at`; `failing_since`; `paused_at`; `disabled_reason text`; `disabled_action_id` → `moderation_actions`; `created_at`; `deleted_at`. Unique index on `hostname WHERE deleted_at IS NULL`; partial unique index on `(user_id) WHERE is_default AND deleted_at IS NULL`; index on `next_check_at WHERE deleted_at IS NULL`. |
| `data_exports` | `id`; `user_id` → `users` `ON DELETE CASCADE`; `status text CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired'))`; `storage_key text` (`exports/<user_id>/<id>.zip` in the files bucket); `size bigint`; `created_at`; `ready_at`; `expires_at`. |

### 1.3 Changes to existing tables

- **`files`** gains `upload_key_id bigint REFERENCES upload_keys (id) ON DELETE SET NULL` (which key uploaded it, for staff and for "last used"). `files_deleted_reason_check` adds `'account_deleted'`.
- **`albums`**: the `deleted_reason` check adds `'account_deleted'`.
- **`upload_sessions`** gains `upload_key_id bigint REFERENCES upload_keys (id) ON DELETE SET NULL` (§7.5).
- **`safety_rate_limits`**: the `scope` check becomes `('report', 'report_message', 'login_ip', 'login_account', 'register', 'forgot_ip', 'forgot_account', 'verify_resend', 'discord', 'reauth', 'username_check', 'upload_key', 'domain_add', 'domain_check', 'export')`, and the `key` check becomes `'^(user|fp|ip|acct|key|domain):[0-9a-f]+$'`. `acct:` is the email hash in §4.7; `key:` an upload key id in hex; `domain:` a domain id in hex.
- **`moderation_actions`** gains `domain_id bigint REFERENCES custom_domains (id) ON DELETE SET NULL`, with an index like the other targets.
- **`reports`** gains `domain_id` (`SET NULL`); `kind` adds `'domain'`; the target check becomes "exactly one of `file_id`, `album_id`, `user_id`, `domain_id` for file, album, user and domain reports, none for bug".
- **`moderation_cases`** gains `domain_id` (`SET NULL`); `kind` adds `'domain'`; the partial unique index "one open case per target" covers it.
- **`user_warnings.target`** (jsonb) may now have `kind: "domain"` with `{ id, hostname }`.

---

## 2. Accounts

### 2.1 The user object

`GET /users/@me` (and every sign-in response's `user`) returns:

```json
{
  "id": "1234567890123456789",
  "username": "dan.w",
  "display_name": "Dan W",
  "email": "dan@example.com",
  "email_verified": true,
  "pending_email": null,
  "has_password": true,
  "needs_username": false,
  "created_at": 1795603600,
  "username_changed_at": null,
  "username_change_available_at": null,
  "identities": [{ "provider": "discord", "username": "danw", "display_name": "Dan W", "avatar_url": "https://cdn.discordapp.com/avatars/80351110224678912/a_1b2c3d4e5f.webp?size=64&animated=true", "created_at": 1795603600, "last_used_at": 1795607200 }],
  "settings": { "show_name_on_albums": false, "domain_only": false },
  "premium": { "active": true, "expires_at": null },
  "deletion": null,
  "staff": null,
  "restrictions": []
}
```

- `staff` and `restrictions` are Milestone 4's (§8.3 there). `discriminator`, `flags` and `bot` are gone.
- `username_change_available_at` is `null` when a rename is allowed now.
- `settings.domain_only` is the owner's switch; whether it's in effect is in `GET /users/@me/domains` (§10.6).
- `deletion` is `null`, or `{ "requested_at", "scheduled_for" }` while a deletion is pending (§8.8).
- **The public user object** (album owner lines, report targets shown to staff) is `{ id, username, display_name }`.

### 2.2 Usernames (owner, 2026-11-25)

- **Rules:**
  - 2–32 characters from `[a-z0-9_.]`;
  - no leading or trailing `.`, and no `..`;
  - not all digits (they'd read as ids), and not `u` followed only by digits (reserved for staff resets, §11.4);
  - input is trimmed and **lowercased** before checking, so `Dan.W` becomes `dan.w`. The username is stored lowercase; uniqueness is exact on the stored value.
- **Reserved,** refused with `USERNAME_INVALID { reason: "reserved" }`:
  - exact names: `about`, `abuse`, `account`, `accounts`, `admin`, `administrator`, `album`, `albums`, `anonymous`, `api`, `app`, `assets`, `auth`, `billing`, `blog`, `bot`, `cdn`, `contact`, `convert`, `copyright`, `dashboard`, `deleted`, `discord`, `dmca`, `docs`, `domains`, `download`, `email`, `files`, `gg`, `guest`, `help`, `info`, `internal`, `legal`, `login`, `logout`, `mail`, `me`, `mod`, `moderator`, `moderators`, `news`, `noreply`, `null`, `official`, `owner`, `password`, `premium`, `press`, `privacy`, `register`, `report`, `reports`, `root`, `security`, `settings`, `signin`, `signup`, `staff`, `status`, `support`, `system`, `team`, `terms`, `test`, `undefined`, `upload`, `uploads`, `user`, `users`, `verify`, `www`;
  - any name starting with `filesgg`, `files.gg` or `files_gg`.
  
  The list lives in `api/utils/usernames.py`, and the web app imports the same rules from a generated JSON (`web/src/lib/usernameRules.json`, written by a test-checked script) so the form can explain a refusal before sending.
- **Held names:** after a rename or a permanent account deletion, the old name goes into `username_holds` for **30 days** (`USERNAME_HOLD_DAYS`). During the hold only the previous owner can take it back; anyone else gets `USERNAME_TAKEN` (a hold is never described as one). During a deletion's 14-day grace period the account still owns its username, so nobody else can take it (§8.8).
- **Cooldown:** one self-service rename every **30 days** (`USERNAME_COOLDOWN_DAYS`), from `username_changed_at`. Too soon: `409 USERNAME_COOLDOWN { available_at }`. The first rename after sign-up, and any rename while `needs_username` is set, skip the cooldown.
- **Renaming breaks nothing:** files, albums and domains are tied to `user_id`.
- `GET /users/@me/username/check?username=` → `{ "username": "dan.w", "available": true }` or `{ "username": "…", "available": false, "reason": "length" | "characters" | "dots" | "numeric" | "reserved" | "taken" }`. Also answers for signed-out callers, with a Turnstile-free rate limit (`username_check`: 60 an hour per IP hash), so the register form can check as you type.

### 2.3 Display names (owner, 2026-11-25)

- Optional, not unique. Shown as "Dan W (@dan.w)" where both appear.
- Cleaning, in order: Unicode NFC; strip bidi controls, zero-width characters and control characters (the Milestone 1 filename cleaning); collapse whitespace; trim. Empty after cleaning means `null`.
- 1–32 characters after cleaning, else `DISPLAY_NAME_INVALID { reason: "length" }`.
- Refused (`reason: "reserved"`): any display name that contains `files.gg`, or equals `staff`, `files.gg staff`, `moderator`, `admin` or `support`, compared case-insensitively after removing spaces, `.`, `_` and `-`.

### 2.4 Avatars (owner, 2026-11-25: none uploaded)

The dashboard and album owner lines show a **generated initials tile**: the first letter of `display_name`, else of `username`, uppercase, on a colour picked from a fixed 8-colour palette by `BigInt(id) % 8n`. Nothing is stored or uploaded. A linked Discord account's avatar appears only in Settings → Login methods, loaded from `cdn.discordapp.com`.

### 2.5 Email and verification

- **Syntax:** the existing `parameters.email` check, with its length cap raised to `≤ 254` characters. The MX check (`email_domain.py`) runs at register and on email change.
- **Uniqueness** is case-insensitive (`lower(email)`). The address is stored as typed.
- **Verification link:** `https://files.gg/app/verify#token=<token>`. `token` is 32 random bytes, base64url without padding (43 characters). Only its SHA-256 is stored, in `account_tokens` (`purpose = 'verify_email'`, `email` = the address it was sent to). Valid **24 hours**, single use.
- `POST /auth/verify { token }` → `204`. It marks `used_at`, then:
  - if `email` equals the account's `email`, sets `email_verified = true`;
  - if it equals `pending_email`, moves it to `email` (still unique, else `409 EMAIL_TAKEN` and the pending change is dropped), sets `email_verified = true`, clears `pending_email`, and sends the "Your email was changed" notice to the old address (§2.7);
  - otherwise (the account's email changed since) `400 INVALID_TOKEN`.
  
  No Turnstile and no session needed: the link is the proof. It doesn't sign anyone in.
- `POST /auth/verify/resend` (signed in) → `204`. Sends to `pending_email` if set, else to an unverified `email`. Nothing to verify: `409 NOTHING_TO_VERIFY`. Rate limit `verify_resend`: 5 an hour per user (`429 TOO_MANY_ATTEMPTS { retry_after }`). A new link doesn't invalidate older unexpired ones.

### 2.6 Passwords (owner, 2026-11-25)

- **Rules:** at least **8** characters, with **no maximum length**; not equal to the username or the email (case-insensitive). Else `INVALID_PASSWORD { reason: "too_short" | "matches_username" | "matches_email" }` as a field error on `password` (or `new_password`). The only upper bound is the request-size limit of the endpoints that take a password (64 KiB, §4.8); a larger body is `413 REQUEST_TOO_LARGE` before anything is hashed. The dashboard shows a zxcvbn-ts strength meter, as for file passwords.
- **Hashing:** argon2id through `argon2-cffi`'s `PasswordHasher()` with its defaults, which are RFC 9106's "second recommended" low-memory profile: `time_cost=3`, `memory_cost=65536` (KiB, 64 MiB), `parallelism=4`, `hash_len=32`, `salt_len=16`, `type=ID`. That's the hasher `api/utils/passwords.py` already uses for file passwords (about 50 ms). It's above every OWASP argon2id minimum (for example 19 MiB, t=2, p=1). Argon2 takes inputs of any practical length, and a long password adds only the initial hashing of its bytes, so a 64 KiB input costs about the same as a short one. The stored form is the PHC string, for example `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`.
- **Where:** `utils/passwords.py` serves both file and account passwords; account passwords get their own `validate_account_password()` (file passwords keep their Milestone 2 rules). Account hashing and checking run in the default executor, never on the event loop. `helpers.hash_password`, `check_password` and Werkzeug are removed from the API.
- **Rehash:** after a successful login, `check_needs_rehash(hash)` true means the hash is replaced with one at the current parameters.
- **Unknown email or no password:** login still runs one `verify` against a fixed dummy argon2id hash, so the timing doesn't reveal whether the email exists (as today).
- `verify` treats `VerifyMismatchError`, `VerificationError` and `InvalidHashError` as "wrong password".

### 2.7 Account emails (Postmark, `email_templates.py`)

All HTML plus plain text, usernames escaped, open and link tracking off (PLAN.md §4 item 14). Each has a Postmark `tag`.

| Template | Tag | Sent when |
|---|---|---|
| `verify_email` (exists) | `auth-verify` | Register; email change (to the new address); resend |
| `reset_password` (exists) | `auth-forgot` | Forgot password. Its link becomes `https://files.gg/app/reset#token=<token>`. |
| `password_changed` | `auth-password-changed` | Password set, changed or reset. "If this wasn't you, reset your password." |
| `email_changed` | `auth-email-changed` | To the **old** address after a change is confirmed. Names the new address partly masked (`d***@example.com`). |
| `discord_linked` | `auth-discord-linked` | Discord linked to an account that has an email |
| `account_deletion_requested` | `auth-deletion-requested` | Deletion requested (§8.8): the date it happens, and "Sign in and choose Keep my account to cancel" |
| `account_deletion_cancelled` | `auth-deletion-cancelled` | Keep my account |
| `account_deleted` | `auth-account-deleted` | The permanent deletion ("deleted for good"), sent just before the address is scrubbed |
| `domain_status` | `domain-status` | A domain failed, paused or came back, and domain-only paused or resumed (§10.6) |
| `premium_changed` | `premium-changed` | Premium granted, revoked or expired |

Deletion emails go only to a **verified** email; an account without one gets none.

---

## 3. Sessions

### 3.1 How a web session is represented (owner, 2026-11-25: HttpOnly cookie)

| | Host-only HttpOnly cookie on `files.gg` (decided) |
|---|---|
| Token theft | Scripts can't read it, so an XSS on `files.gg` can act while the page is open but can't take the session away. |
| Hosts | The cookie is host-only on `files.gg`. `cdn.files.gg` (user bytes), `api.files.gg` and custom domains never receive it, and the `__Host-` prefix stops `cdn.files.gg` from setting or overwriting it. The website therefore calls the API same-origin through the `files.gg/api/*` passthrough, which already exists. |
| CSRF | Cookies are sent automatically, so writes need protection: `SameSite=Lax`, a custom header and `Origin`/`Sec-Fetch-Site` checks (§3.6). |
| Tools | Unchanged: ShareX, scripts and apps use upload keys in a header against `api.files.gg` (§7). |

This replaces the plan's "No auth cookie, ever" (PLAN.md "Hardening" part B). The hardening that made that rule safe still applies, and the cookie is scoped so that nothing user-controlled ever shares its host.

### 3.2 The cookie and the token

- **Token:** `fgs_` + 30 random base62 characters + a 6-character base62 checksum (§7.1 has the construction, shared with upload keys). 40 characters. Stored as SHA-256 of the whole token string (UTF-8) in `sessions.token_hash`.
- **Set** by the API on a successful sign-in (login, register, Discord callback, Discord sign-up, reset), in the response that `files.gg/api/…` returns:

```
Set-Cookie: __Host-filesgg_session=fgs_…; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=<max_expires_at - now>
```

  No `Domain` attribute, so the browser keeps it for `files.gg` only. `Max-Age` runs to the session's absolute expiry; the server enforces the idle expiry. **The token is never in a response body,** a URL or a log; the API's request logger redacts `Cookie` and `Set-Cookie`.
- **Cleared** by logout, "Sign out everywhere", any `401` caused by a dead session cookie, and the permanent deletion:

```
Set-Cookie: __Host-filesgg_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0
```

- **Sign-in response body:** `{ "expires_at": 1798195600, "user": { …user object (§2.1)… } }`.
- **Local development** over plain `http` can't use a `__Host-` cookie (it needs `Secure`). With `FILESGG_DEV_TOOLS=1` and `SESSION_COOKIE_INSECURE=1`, the API uses the name `filesgg_session` without `Secure`; the Worker reads the same name from its `SESSION_COOKIE_NAME` var (§15). Production refuses to boot with `SESSION_COOKIE_INSECURE` set.

### 3.3 Expiry and limits (owner, 2026-11-25)

| Setting | Default | Effect |
|---|---|---|
| `SESSION_IDLE_DAYS` | `30` | A session unused for this long ends. |
| `SESSION_MAX_DAYS` | `180` | A session ends this long after sign-in, used or not. |
| `SESSIONS_MAX` | `50` | Active sessions per account; a new sign-in revokes the oldest by `last_used_at` (`revoked_reason = 'limit'`). |

Revoked and expired rows are deleted 30 days later by `session_cleanup` (daily).

### 3.4 Request authentication and revocation

**Authentication** (`utils/auth.py`, replacing `helpers.get_user` and `parameters.token_authorization`):
1. The API reads a session **only** from the session cookie, and only on a request the Worker forwarded from `files.gg/api/*`: `request.ctx.from_worker` is true (the existing origin-secret check) **and** the request carries `X-Filesgg-Via: main`, which the Worker sets only on that passthrough and strips from every client request (§12). A cookie on any other request is ignored.
2. `Authorization: Bearer` is never accepted. `Authorization: Key fgg_…` is an upload key and only works on the upload endpoints (§7.4); anywhere else it's `403 UPLOAD_KEY_NOT_ALLOWED`.
3. Check the token's format and checksum. Bad: `401 UNAUTHORIZED` (cookie cleared) without touching the database.
4. Look up `token_hash` joined to `users`: `revoked_at IS NULL`, `expires_at > now()`, `max_expires_at > now()`, `users.deleted_at IS NULL`. None: `401 UNAUTHORIZED` and the cookie is cleared.
5. If `last_used_at` is more than 10 minutes old, update `last_used_at`, `last_country`, and slide `expires_at` to `least(now() + SESSION_IDLE_DAYS, max_expires_at)`.
6. For a state-changing method, the CSRF checks in §3.6.
7. The request gets `request.ctx.user` and `request.ctx.session`.

`GET /auth/session` → `200 { "user": <user object> | null }`. It never answers `401`, so the dashboard and the `files.gg` viewer can ask "am I signed in?" without an error. A dead cookie gets `user: null` and is cleared.

**Revocation:**

| Event | Sessions ended | `revoked_reason` | Cookie |
|---|---|---|---|
| `POST /auth/logout` | the current one | `logout` | cleared |
| Settings → Sessions → Sign out (one row) | that one (the current one is the same as logout) | `user` | cleared if it was the current one |
| Settings → **Sign out everywhere** | **all**, including the current one | `everywhere` | cleared |
| Password set or changed (§8.5) | all but the current one | `password_change` | kept |
| Password reset by email (§4.4) | all, then a new one is issued | `password_reset` | replaced |
| Deletion requested (§8.8) | all but the current one | `deletion_requested` | kept |
| Email changed (confirmed) | none | | |
| Staff `revoke_sessions` (§11.4) | all | `staff` | cleared at the next request (`401`) |
| Permanent deletion | all | `account_deleted` | cleared at the next request |
| Suspension (Milestone 4) | none: suspended accounts can still sign in (milestone-4 §8.4) | | |

Upload keys are separate: none of these revoke them, except the permanent deletion and staff `revoke_upload_keys`. A password change shows "Your upload keys still work. Revoke them in Integrations if you think one leaked."

### 3.5 Re-authentication

A **fresh** session is one whose `authenticated_at` is within the last 10 minutes (`REAUTH_SECONDS = 600`). `authenticated_at` is set at sign-in and by:
- `POST /auth/reauth { password }` → `204`. Wrong password: `400 INVALID_CREDENTIALS`. Rate limit `reauth`: 10 failures an hour per user.
- the Discord flow with `purpose: "reauth"` (§5.3), for accounts that sign in with Discord.

Needed for: adding or changing the email, setting or changing the password, unlinking Discord, and requesting account deletion. Without it: `403 REAUTH_REQUIRED { methods: ["password" | "discord", …] }`, listing the methods this account has. The dashboard then asks for the password or runs Discord, and retries.

### 3.6 CSRF (owner, 2026-11-25)

**Which requests are checked:** every `POST`, `PUT`, `PATCH` and `DELETE` that carries the session cookie, and every `POST` under `/auth/` whether or not it carries one (so nobody can be signed into someone else's account by a forged login).

**Checks, in order** (any failure is `403 CSRF`, "This request didn't come from files.gg", before the handler runs):
1. The header `X-Filesgg-Csrf: 1` is present.
2. If `Origin` is present, it equals the main origin (`PUBLIC_URL`, `https://files.gg`). `Origin: null` fails.
3. If `Sec-Fetch-Site` is present, it's `same-origin`.

**Why this is enough for same-origin calls:**
- A page on another site can't add a custom header to a cross-origin request without a CORS preflight, and the Worker never approves credentialed cross-origin requests to `files.gg/api/*` (§12). A form or a simple `fetch` without the header is refused by check 1.
- `SameSite=Lax` means the cookie isn't sent on cross-site subresource requests or cross-site `POST`s at all; a cross-site top-level `GET` can carry it, which is why only safe methods are allowed without the checks, and no `GET` changes state.
- **`cdn.files.gg`** is same-*site* with `files.gg`, so `SameSite` doesn't cover it. But every CDN response is sandboxed (an opaque origin: no scripts, no forms), its requests would carry `Origin: null` or `Sec-Fetch-Site: same-site`, and it can't add the header without a preflight the Worker refuses. Checks 1–3 catch all three.
- **Custom domains** are other sites: the cookie is never sent to them or from them.
- Upload keys and anonymous requests carry no cookie, so they aren't checked (an attacker can't make a victim's browser send a key).

The web client sends `X-Filesgg-Csrf: 1` on every non-`GET` request it makes to `/api` (§13.1).

---

## 4. Email and password sign-in

All of these are called by the website same-origin, as `files.gg/api/auth/…`; the paths below are the API's.

### 4.1 `POST /auth/login`

```
POST /auth/login     X-Fingerprint: <optional>     X-Filesgg-Csrf: 1
{ "email": "dan@example.com", "password": "…", "turnstile_token": "…" }
→ 200 { expires_at, user }      Set-Cookie: __Host-filesgg_session=…
```

Order: request size (§4.8) → CSRF (§3.6) → rate limits (§4.7) → Turnstile (action `login`) → find the user by `lower(email)` among accounts that aren't permanently deleted → argon2 verify (dummy hash for unknown) → success. Any failure after Turnstile is `400 INVALID_CREDENTIALS` ("Wrong email or password") and counts toward `login_ip` and `login_account`. On success: rehash if needed, claim fingerprint files and albums (§4.2), create a session (`method: 'password'`) and set the cookie. An account with a pending deletion can sign in; its `user.deletion` tells the dashboard to show the Keep my account screen (§8.8). An existing session cookie on the request is revoked first (one browser, one session).

### 4.2 Claiming anonymous uploads

On register, login, Discord sign-in and Discord sign-up, with a valid `X-Fingerprint`:
- `UPDATE files SET user_id = <user>, fingerprint = NULL WHERE fingerprint = <fp> AND deleted_at IS NULL`;
- `UPDATE albums SET owner_user_id = <user>, owner_fingerprint = NULL WHERE owner_fingerprint = <fp> AND deleted_at IS NULL` **(chosen: albums too; today only files are claimed)**;
- open `upload_sessions` owned by the fingerprint are left alone (they finish as anonymous and are claimed at the next sign-in).

Nothing is claimed into an account with a pending deletion. Claimed files keep their expiry (PLAN.md "Claiming on sign-up"). The web app deletes `filesgg.fingerprint` after a successful sign-in, so the next anonymous upload gets a fresh fingerprint. A user id is never a fingerprint (chosen); `GET /auth/fingerprint`'s "is this fingerprint a user id" check goes away.

### 4.3 `POST /auth/register`

```
POST /auth/register     X-Fingerprint: <optional>     X-Filesgg-Csrf: 1
{ "email": "…", "username": "Dan.W", "password": "…", "display_name": "Dan W", "turnstile_token": "…" }
→ 201 { expires_at, user }      Set-Cookie: __Host-filesgg_session=…
```

Order: request size → CSRF → rate limit `register` (5 an hour per IP hash) → bans (§11.3) → field validation (username §2.2, display name §2.3, password §2.6, email syntax), reported together as `400 INVALID_PARAMETERS { errors }` or the specific field codes → Turnstile (action `register`) → MX check (`INVALID_EMAIL`) → `EMAIL_TAKEN` / `USERNAME_TAKEN` → create the user (fresh Snowflake id), claim (§4.2), session (`method: 'register'`) and cookie, send `verify_email`. The account is usable at once with an unverified email.

### 4.4 Forgot and reset

```
POST /auth/forgot        { "email": "…", "turnstile_token": "…" }        → 204, always
POST /auth/forgot/reset  { "token": "…", "password": "…", "turnstile_token": "…" }   → 200 { expires_at, user } with Set-Cookie
```

- **Forgot (no enumeration):** CSRF and Turnstile (action `forgot`) first; then, if an account that isn't permanently deleted has that email (verified or not), and the `forgot_account` limit (3 an hour per email hash) and `forgot_ip` limit (10 an hour per IP hash) allow, a `reset_password` token is stored and emailed. Every outcome is `204`, including unknown emails and rate-limited sends. Accounts without a password (Discord-only, with an email) get the same email: resetting sets their first password.
- **Reset link:** `https://files.gg/app/reset#token=<token>`, the same token format as verification, valid **1 hour**, single use.
- **Reset:** CSRF → Turnstile (action `reset`) → token (`400 INVALID_TOKEN` if unknown, used or expired, or if the account's email no longer equals the token's `email`) → password rules (§2.6; `SAME_PASSWORD` if it matches the current one) → set the hash, mark the token used, **mark the email verified** (the link proved the mailbox), revoke every session, create a new one (`method: 'reset'`) and set its cookie, send `password_changed`. Resetting doesn't cancel a pending deletion; the dashboard then shows the Keep my account screen.

### 4.5 Logout

`POST /auth/logout` (session cookie, CSRF) → `204`, ends the current session and clears the cookie. Without a session it's still `204` and clears the cookie (logging out is idempotent).

### 4.6 Turnstile on auth (owner, 2026-11-25)

| Endpoint | Turnstile action |
|---|---|
| `POST /auth/login` | `login` |
| `POST /auth/register` | `register` |
| `POST /auth/discord/callback` (purpose `login` only) | `login` |
| `POST /auth/discord/signup` | `register` |
| `POST /auth/forgot` | `forgot` |
| `POST /auth/forgot/reset` | `reset` |
| `POST /auth/verify`, `/auth/reauth`, `/auth/logout`, every signed-in endpoint | none |

The Milestone 2 list of actions (`upload`, `unlock`, `login`, `register`, `forgot`, plus Milestone 4's `report`) gains `reset`. The hostname check stays `files.gg` (and the dev hostnames). A missing or failed token is `403 CAPTCHA_INVALID`, checked before passwords or emails are touched. Turnstile tokens last 300 s and are single use (Cloudflare's server-side validation docs), so the web app runs the widget right before each submit and resets it after a failure.

### 4.7 Rate limits

Counted in `safety_rate_limits` (1-hour windows, Milestone 4 §1). The email key is a keyed hash, so the table holds no addresses:

```
acct key = "acct:" + hex( HMAC-SHA256( ABUSE_HASH_SECRET, "filesgg-auth-email-1" + "\n" + lower(trim(email)) ) )
```

| Scope | Key | Default per hour | When exceeded |
|---|---|---|---|
| `login_ip` | `ip:` abuse IP hash | 30 failed logins | `429 TOO_MANY_ATTEMPTS { retry_after }` before checking anything else |
| `login_account` | `acct:` | 10 failed logins | Same. Successful logins don't count, and don't reset the count. |
| `register` | `ip:` | 5 | `429 TOO_MANY_ATTEMPTS` |
| `forgot_ip` | `ip:` | 10 | Still `204`, nothing sent |
| `forgot_account` | `acct:` | 3 | Still `204`, nothing sent |
| `verify_resend` | `user:` | 5 | `429 TOO_MANY_ATTEMPTS` |
| `discord` | `ip:` | 30 callbacks | `429 TOO_MANY_ATTEMPTS` |
| `reauth` | `user:` | 10 failures | `429 TOO_MANY_ATTEMPTS` |
| `username_check` | `ip:` | 60 | `429 TOO_MANY_ATTEMPTS` |

`retry_after` is the seconds until the window has room again. Limits are config (`RATE_LIMITS`; since Milestone 5 they're Redis moving windows, [`milestone-5.md`](milestone-5.md) §18).

### 4.8 Request-size limits (chosen)

Checked in an `on_request` middleware from `Content-Length` (and while reading, for a chunked transfer encoding), before parsing: `413 REQUEST_TOO_LARGE { limit }`.

| Endpoints | Limit |
|---|---|
| `/auth/*`, `POST /users/@me/email`, `PUT /users/@me/password`, `POST /users/@me/delete` | **64 KiB** (`AUTH_REQUEST_MAX_BYTES = 65536`). This is the only upper bound on a password. |
| Every other JSON or form endpoint | **1 MiB** (`JSON_REQUEST_MAX_BYTES = 1048576`) |
| `POST /files` | the caller's single-request limit plus 1 MiB of multipart framing (§9.2) |
| `PUT /uploads/<id>/chunks/<i>` | the session's `chunk_size` (10 MiB) |

Sanic's own `REQUEST_MAX_SIZE` is the outer cap for all of them (§9.5).

---

## 5. Discord

### 5.1 Discord's endpoints (verified 2026-11-25)

Discord's developer docs now live at `docs.discord.com/developers/…` (the old `discord.com/developers/docs/…` URLs redirect there).

| What | Value |
|---|---|
| Authorize | `https://discord.com/oauth2/authorize` |
| Token | `POST https://discord.com/api/oauth2/token`, `application/x-www-form-urlencoded` only |
| Revoke | `POST https://discord.com/api/oauth2/token/revoke`, form fields `token` and `token_type_hint=access_token` |
| Current user | `GET https://discord.com/api/v10/users/@me` with Discord's access token in the `Authorization` header (v10 is the newest available API version) |
| Client authentication | HTTP Basic with the client id and secret (`client_secret_basic`), on both the token and revoke calls |
| PKCE | `S256`, advertised in `https://discord.com/.well-known/oauth-authorization-server` |
| Scopes | `identify` (`/users/@me` without email) and `email` (adds `email`) |
| Avatars | `https://cdn.discordapp.com/avatars/<user_id>/<hash>.webp?size=64`, with `&animated=true` when the hash starts with `a_`; no avatar: `https://cdn.discordapp.com/embed/avatars/<(BigInt(id) >> 22n) % 6n>.png` |

`/users/@me` fields used: `id` (snowflake string), `username`, `global_name` (nullable), `avatar` (nullable), `email` (nullable even with the `email` scope) and `verified` ("whether the email on this account has been verified"). The token response has `access_token`, `token_type`, `expires_in`, `refresh_token` and `scope`; only `access_token` is used, and nothing is stored (PLAN.md: "Store no Discord OAuth tokens").

### 5.2 The flow (chosen: PKCE in the browser, confidential client on the API)

1. **The web app** makes a PKCE verifier: 32 random bytes, base64url without padding (43 characters). It computes `code_challenge = base64url_nopad(SHA-256(verifier))`, and keeps `{ verifier, state, purpose, next }` in `sessionStorage["filesgg.oauth"]`.
2. **`POST /auth/discord/authorize`** `{ purpose, code_challenge }` (CSRF header) → `200 { "url": "<authorize URL>", "state": "<state>" }`.
   - `purpose`: `login` (signed out, covers sign-up too), `link` or `reauth` (both need the session cookie; `401` otherwise).
   - The API signs a `state` (§5.4) and returns the authorize URL with, in this order: `response_type=code`, `client_id`, `scope=identify email`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, and `prompt=none` for `login` and `reauth` (`prompt=consent` for `link`).
   - The web app stores `state`, then navigates to `url`.
3. **Discord** redirects to `https://files.gg/app/auth/discord?code=…&state=…` (or `?error=access_denied&state=…`).
4. **The callback page** checks that `state` equals the stored one (else it shows "This sign-in link expired. Try again." and sends nothing). It removes the query from the address bar with `replaceState`, runs Turnstile (action `login`) for `purpose: login`, then calls, same-origin with the cookie (if any) and the CSRF header:

```
POST /auth/discord/callback     X-Fingerprint: <optional>     X-Filesgg-Csrf: 1
{ "code": "…", "state": "…", "code_verifier": "…", "turnstile_token": "…" }
```

5. **The API:**
   1. CSRF, then rate limit `discord`;
   2. verifies `state` (signature, `e > now`, `purpose`; for `link` and `reauth`, `u` must equal the session's user), else `400 INVALID_OAUTH_STATE`;
   3. checks `base64url_nopad(SHA-256(code_verifier)) == state.c`, else `400 INVALID_OAUTH_STATE`;
   4. Turnstile for `login`;
   5. exchanges the code: `grant_type=authorization_code`, `code`, `redirect_uri` (exactly `DISCORD_REDIRECT_URI`), `code_verifier`, with Basic auth. A `400` from Discord is `400 DISCORD_CODE_INVALID`; a network error, `5xx` or `429` is `503 DISCORD_UNAVAILABLE { retry_after? }`. Timeout 10 s;
   6. reads `/users/@me` (same error mapping);
   7. revokes the access token (best effort, 3 s timeout, never fails the request; an unrevoked token simply expires after `expires_in`);
   8. continues by purpose (§5.3).
6. If Discord answered `error=` with anything other than `access_denied` while `prompt=none` was sent, the callback page retries once from step 2 without `prompt`. `access_denied` shows "Discord sign-in was cancelled."

### 5.3 Outcomes

| `purpose` | Situation | Response |
|---|---|---|
| `login` | Identity linked to an account | `200 { "status": "signed_in", expires_at, user }` and **the session cookie is set**. Claims fingerprint uploads; session `method: 'discord'`; refreshes the identity's cached `username`, `display_name`, `avatar` and `last_used_at`. A pending deletion signs in the same way (§8.8). |
| `login` | Identity of a permanently deleted account | Treated as unknown (the identity row was deleted with the account, §8.8). |
| `login` | Identity unknown | `200 { "status": "signup_required", "signup_token", "suggested_username", "discord": { "id", "username", "display_name", "avatar_url" }, "email": { "address": "dan@example.com" \| null, "usable": true \| false, "reason": null \| "unverified" \| "missing" \| "in_use" } }` (§5.5). No cookie yet. |
| `link` | Identity unknown, account has no Discord | `200 { "status": "linked", "identity": {…} }`. Sends `discord_linked`. |
| `link` | Identity linked to this account already | `200 { "status": "linked", … }` (idempotent) |
| `link` | Identity linked to another account | `409 IDENTITY_IN_USE` ("That Discord account is linked to another files.gg account"). Never merged. |
| `link` | Account already has a different Discord | `409 IDENTITY_ALREADY_LINKED` |
| `reauth` | Identity is this account's Discord | `200 { "status": "reauthenticated" }`, sets `authenticated_at` |
| `reauth` | Any other Discord account | `403 IDENTITY_MISMATCH` |

### 5.4 Signed `state` and sign-up token

Both use the same construction as the API's unlock tokens (`access_token.py`), with a label so one can never be used as the other:

```
token = body + "." + base64url_nopad( HMAC-SHA256( SECRET_KEY, <label> + "\n" + body ) )
body  = base64url_nopad( json.dumps(claims, separators=(",", ":"), sort_keys=True) )
```

| Token | Label | Claims | Lifetime |
|---|---|---|---|
| OAuth `state` | `filesgg-oauth-state-1` | `p` purpose, `c` code_challenge, `n` 16 random bytes base64url, `u` user id string or `null`, `i` issued at, `e` expiry | 10 minutes |
| Sign-up token | `filesgg-discord-signup-1` | `d` Discord id, `n` Discord username, `g` `global_name` or `null`, `a` avatar hash or `null`, `m` email or `null`, `mv` email verified, `e` expiry | 15 minutes |

Test vectors are in §16.3. Checks use `hmac.compare_digest`. A sign-up token is single use in practice: the identity's unique constraint refuses a second account (`409 IDENTITY_IN_USE`).

### 5.5 Sign-up through Discord

```
POST /auth/discord/signup     X-Fingerprint: <optional>     X-Filesgg-Csrf: 1
{ "signup_token": "…", "username": "dan.w", "display_name": "Dan W", "turnstile_token": "…" }
→ 201 { expires_at, user }      Set-Cookie: __Host-filesgg_session=…
```

- **Suggested username:** the Discord `username`, lowercased, if it passes §2.2 and is free; else that name with `_2` … `_9` appended (cut to fit 32 characters); else `user_` plus 6 random digits. The person can edit it before creating the account (PLAN.md "Discord signup").
- **Display name** defaults to the Discord `global_name`, cleaned (§2.3); editable, optional.
- **Email (owner, 2026-11-25):** `email.usable` is `true` when Discord returned an email **and** `verified: true` **and** no account uses it. Then the new account gets that email with `email_verified = true`. When Discord's email is verified but belongs to an existing account (`reason: "in_use"`), the sign-up is refused: `409 DISCORD_EMAIL_IN_USE` ("An account already uses this email. Sign in with your password, then link Discord in Settings."), and the page shows that message instead of the form. An unverified or missing Discord email creates the account with **no email**; the dashboard then offers "Add an email so you can recover your account".
- **Checks:** request size, CSRF, Turnstile (action `register`), `register` rate limit, bans (§11.3), sign-up token (`400 INVALID_SIGNUP_TOKEN`), username and display name rules.
- **Then:** create the user and the `user_identities` row in one transaction, claim fingerprint uploads, create a session (`method: 'discord'`) and set its cookie.
- **Nothing syncs afterwards.** The cached identity fields are only for display in Settings.

### 5.6 Unlinking

`DELETE /users/@me/identities/discord` (fresh session, §3.5) → `204`.
- **"Can't unlink your last method":** allowed only if the account also has a password **and** a verified email. Else `409 LAST_LOGIN_METHOD` ("Add a password and verify your email first, so you can still sign in"). The Settings button is disabled with that tooltip.
- No Discord linked: `404 UNKNOWN_IDENTITY`.
- Discord has no "revoke this app's authorization" call we can make without a token, so Settings adds: "To remove files.gg from your Discord account too, open Discord → User Settings → Authorized Apps."

`GET /users/@me/identities` → `{ "items": [identity] }`, the same objects as `user.identities`.

---

## 6. Pages and routing

### 6.1 Where the pages live (owner, 2026-11-25: in the dashboard app)

| Page | URL | Signed-in visitor |
|---|---|---|
| Sign in | `/app/login?next=<app path>` | Redirected to `next` or `/app` |
| Create account | `/app/register?next=` | Same |
| Verify email | `/app/verify#token=…` | Works either way |
| Forgot password | `/app/forgot` | Works either way |
| Reset password | `/app/reset#token=…` | Works either way; signs in as the reset account |
| Discord callback, and the "Choose your username" step | `/app/auth/discord?code&state` | |

- They're routes of the dashboard entry (`app.html`), outside `DashboardLayout` (a plain centred card with the logo), each a lazy chunk. The Worker already serves `/app/*`, and `app` is already a reserved vanity. They're on `files.gg`, so their API calls are same-origin and the session cookie they receive is the one the dashboard uses.
- **`next`** must be a path starting with `/app/` (no `//`, no scheme); anything else is ignored.
- **Fragments, not query strings,** for email tokens: read once, then removed with `replaceState`.

### 6.2 Worker redirects and pages

On `files.gg` only, before vanity matching, `GET` and `HEAD`:

| Path | Response |
|---|---|
| `/login`, `/login/` | `308` to `/app/login` (query kept) |
| `/register`, `/register/`, `/signup` | `308` to `/app/register` |
| `/challenge` | The Turnstile frame for custom domains (§10.10) |

### 6.3 Reserved vanity segments

`blacklisted_ids` (`api/utils/vanity.py`) and the Worker's reserved list (`hasReservedSegment`) both gain: `login`, `register`, `signup`, `challenge`, `files`, `previews`, `albums`. Fresh launch, so no existing vanity is affected.

---

## 7. Upload keys

### 7.1 Format (chosen)

```
token     = prefix + random + checksum                       (40 characters)
prefix    = "fgg_" (upload key) | "fgs_" (session, §3.2)
random    = 30 characters from the base62 alphabet, chosen with the OS CSPRNG (about 178 bits)
checksum  = base62( CRC32( ASCII(prefix + random) ) ), left-padded with "0" to 6 characters
base62 alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
CRC32     = zlib's CRC-32 (IEEE), as an unsigned 32-bit integer
```

- This follows GitHub's published token design (a recognisable prefix, `_` as the separator because it's not in base64, high-entropy random characters, and a CRC32 checksum in base62) and the secret scanning partner program's recommendations (a unique prefix, high entropy, a 32-bit checksum).
- **Regex for scanners:** `\bfg[gs]_[0-9A-Za-z]{36}\b`.
- **Stored:** `key_hash` = SHA-256 of the whole key (32 bytes). A fast hash is enough for a 178-bit random secret. `prefix` = the first 12 characters (`fgg_` plus 8), shown in lists (**chosen**; the plan said "the first 8 characters").
- **Checked:** checksum first (a typo or a scanner false positive never reaches the database), then the hash lookup.

### 7.2 Scopes (chosen)

| Scope | Allows |
|---|---|
| `files:upload` (always present) | `POST /files`; `POST /uploads`, `PUT /uploads/<id>/chunks/<i>`, `GET /uploads/<id>`, `POST /uploads/<id>/complete`, `DELETE /uploads/<id>` |
| `albums:append` (optional) | The `album=<vanity>` upload parameter, appending to one of the owner's albums |

A key can't sign in, read the library, delete files, create albums, change settings or create keys (PLAN.md). Using one anywhere else gives `403 UPLOAD_KEY_NOT_ALLOWED` ("Upload keys can only upload files"), and on `/admin/*` the plain `404` every non-staff caller gets. `album=` without `albums:append` is `403 UPLOAD_KEY_SCOPE { scope: "albums:append" }`.

### 7.3 Endpoints (website only: the session cookie, never a key)

| Request | Response |
|---|---|
| `GET /users/@me/upload-keys` | `{ "items": [key], "limit": 20 }`. Revoked and expired keys are listed for 30 days, then dropped from the list. |
| `POST /users/@me/upload-keys { name, scopes?, domain_id?, expires_in? }` | `201 { "key": key, "secret": "fgg_…", "sharex": { ….sxcu JSON, §7.7 }, "curl": "…" }`. **The only time the secret is returned.** |
| `PATCH /users/@me/upload-keys/<id> { name?, domain_id? }` | `key`. Scopes and expiry can't change; make a new key. |
| `DELETE /users/@me/upload-keys/<id>` | `204`. Revokes (`revoked_reason = 'owner'`). Takes effect on the next request. |

**Key object:**

```json
{
  "id": "…", "name": "Laptop ShareX", "prefix": "fgg_0123ABCD",
  "scopes": ["files:upload"], "domain": { "id": "…", "hostname": "i.example.com" } | null,
  "created_at": 1795603600, "expires_at": null, "last_used_at": 1795607200,
  "revoked_at": null, "state": "active" | "revoked" | "expired"
}
```

- `name`: 1–64 characters, cleaned like a display name; default "Upload key".
- `scopes`: default `["files:upload"]`.
- `domain_id`: one of your own non-deleted domains (`400 UNKNOWN_DOMAIN` otherwise). It may be pending; uploads use it only while it's serving (§10.9).
- `expires_in`: `null` (never, default), or 30, 90 or 365 days in seconds. Anything else is `INVALID_PARAMETERS`.
- **Limit:** 20 active keys (`UPLOAD_KEYS_MAX`): `400 UPLOAD_KEY_LIMIT { limit }`.
- `last_used_at` is updated at most once a minute.
- **Who can create keys:** any signed-in account that isn't suspended or pending deletion. Upload-restricted accounts can create keys (they still can't upload).

### 7.4 Authentication

```
Authorization: Key fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V
```

- **Header only, scheme `Key` only.** Tools send it to `api.files.gg`. Any other `Authorization` scheme is `401 UNAUTHORIZED` with the message "Upload keys use `Authorization: Key fgg_…`".
- An invalid checksum, unknown, revoked or expired key: `401 UPLOAD_KEY_INVALID`. The owner must not be deleted. An owner with a pending deletion gets `403 ACCOUNT_PENDING_DELETION` (the key works again if the deletion is cancelled).
- **Keys never authenticate the website or the admin,** and sessions never come from keys. `utils/auth.py` exposes `require_session()` (every signed-in endpoint: the cookie, §3.4) and `require_uploader()` (the upload endpoints: the session cookie **or** a key with `files:upload`), and nothing else accepts `Key`.
- A request that carries both a session cookie and a key is authenticated by the **key**, and the cookie is ignored (and needs no CSRF header).

### 7.5 Uploads with a key

- **`POST /files`** (multipart or raw): the key's user is the owner. `X-Fingerprint` and `turnstile_token` are ignored. The owner's single-request limit applies (§9.2). The file's `upload_key_id` is set.
- **Chunked:** `POST /uploads` with a key records `upload_sessions.upload_key_id`. Every later call on that session must authenticate as **the same key** (the owner's session cookie is also accepted, so the website can cancel it); else `404 UNKNOWN_UPLOAD`, as for another owner today.
- **Milestone 4:** `standing.check_uploader(user=<key owner>)` runs exactly as for a session: `ACCOUNT_SUSPENDED`, `UPLOADS_RESTRICTED`. Scanning, NSFW rules and rejections are unchanged.
- **Anonymous tool uploads (chosen):** with no credential (no session cookie, no key) and **no** `turnstile_token` parameter at all, `POST /files` and `POST /uploads` answer `401 UPLOAD_KEY_REQUIRED` ("Create a free account to upload with ShareX"), before reading the body. A `turnstile_token` that's present but fails is `403 CAPTCHA_INVALID`, as today.
- **Upload response links** use the key's pinned domain when it's serving, else the default domain (§10.9).

### 7.6 Per-key limits

| Limit | Default | Error |
|---|---|---|
| Uploads per key per hour (`POST /files` and `POST /uploads` each count 1) | `600` (`UPLOAD_KEY_RATE_PER_HOUR`) | `429 TOO_MANY_UPLOADS { limit, retry_after }` |
| Open chunked sessions | the account's existing limit (`TOO_MANY_UPLOADS`) | |
| File size, storage, expiry | the account's `get_limits()` (§9.2), and the proxy body limit for single requests (§9.5) | as today |

Counted in `safety_rate_limits` with scope `upload_key` and key `key:<id hex>`.

### 7.7 ShareX `.sxcu` and the curl snippet

ShareX's custom uploader docs (`getsharex.com/docs/custom-uploader`) define these fields; ShareX 14.0 moved response parsing to `{json:…}` syntax, and 17.0 dropped `.sxcu` files from before 12.4.0. The current ShareX release is 22.4.0 (2026-11-08); its docs still show `"Version": "17.0.0"`, which is what we write.

The API returns this object as `sharex`; the web app downloads it as `files.gg - <key name>.sxcu` (`application/json`). Key order as shown:

```json
{
  "Version": "17.0.0",
  "Name": "files.gg (Laptop ShareX)",
  "DestinationType": "ImageUploader, TextUploader, FileUploader",
  "RequestMethod": "POST",
  "RequestURL": "https://api.files.gg/files",
  "Headers": {
    "Authorization": "Key fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V"
  },
  "Body": "MultipartFormData",
  "Arguments": {
    "expires_in": "604800",
    "visibility": "password",
    "generate_password": "true",
    "album": "Ab3dE6gH"
  },
  "FileFormName": "file",
  "URL": "{json:url_with_password}",
  "ErrorMessage": "{json:message}"
}
```

- `RequestURL` is `API_PUBLIC_URL + "/files"` (§15). Tools never use `files.gg/api`.
- `Arguments` holds only what the person picked in the create dialog: expiry (`expires_in`, seconds), access (`visibility`, `generate_password`), `nsfw` (`"true"`), and `album` (only with `albums:append`). With nothing picked, `Arguments` is omitted.
- `URL` is `{json:url_with_password}` when `generate_password` is set, else `{json:url}`.
- No `DeletionURL` (keys can't delete) and no `ThumbnailURL` (previews don't exist until the scan passes).
- `{json:message}` reads the error shape's `message`.

**curl** (the `curl` string, with the same arguments as `-F` fields):

```
curl -H "Authorization: Key fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V" \
     -F "file=@photo.png" -F "expires_in=604800" \
     https://api.files.gg/files
```

---

## 8. Settings API

Every endpoint here needs the session cookie (never a key), called same-origin at `files.gg/api/…`, with the CSRF header on writes. Milestone 4's suspension rules apply as amended in §11.1, and a pending deletion locks the account (§8.8).

### 8.1 Profile

| Request | Response |
|---|---|
| `GET /users/@me` | user (§2.1) |
| `PATCH /users/@me { display_name?, settings?: { show_name_on_albums? } }` | user |
| `PUT /users/@me/username { username }` | user. Rules, holds and cooldown in §2.2. The old name goes into `username_holds`. Clears `needs_username`. |
| `GET /users/@me/username/check?username=` | §2.2 |
| `GET /users/<id>` (any id but `@me`) | `404` **(chosen: no public profiles)** |

### 8.2 Login methods

| Request | Response |
|---|---|
| `GET /users/@me/identities` | `{ "items": [identity] }` |
| `POST /auth/discord/authorize { purpose: "link", code_challenge }` | §5.2 |
| `DELETE /users/@me/identities/discord` | `204` (§5.6) |

### 8.3 Sessions

| Request | Response |
|---|---|
| `GET /users/@me/sessions` | `{ "items": [session] }`, active only, most recently used first |
| `DELETE /users/@me/sessions/<id>` | `204`. Your own sessions only (`404 UNKNOWN_SESSION`). Deleting the current one is the same as logout and clears the cookie. |
| `DELETE /users/@me/sessions` | `200 { "revoked": n }`. **Sign out everywhere:** every session, including the current one, and clears the cookie. |

**Session object:** `{ "id", "current": true, "method": "password", "created_at", "last_used_at", "expires_at", "device": "Firefox on macOS", "country": "GB" }`. `device` is parsed from the stored user agent with a small fixed table (browser family and OS); unknown is `"Unknown device"`. The token and its hash are never returned.

### 8.4 Email

| Request | Response |
|---|---|
| `POST /users/@me/email { email }` | `202 { "pending_email": "…" }`. Fresh session (§3.5). Syntax, MX and `EMAIL_TAKEN` checks; sets `pending_email` and sends `verify_email` to it (§2.5). The current email keeps working until the link is used. An account with **no** email gets the new one as `email` right away, unverified (nothing to keep). |
| `DELETE /users/@me/email/pending` | `204`. Cancels a pending change. |

### 8.5 Password

`PUT /users/@me/password { current_password?, new_password }` → `204`.
- With a password already: `current_password` is required and checked (`400 INVALID_CREDENTIALS`); it also counts as re-authentication.
- Without one (Discord-only): a fresh session (§3.5) and a **verified email** (`403 EMAIL_NOT_VERIFIED`), so the new method can be recovered.
- Rules in §2.6; `SAME_PASSWORD` when unchanged. Ends every other session (the current cookie stays valid) and sends `password_changed`.

### 8.6 Privacy

`show_name_on_albums` (PLAN.md "Albums" → "Privacy", off by default): when on, the album payload (milestone-3 §4) gains `owner: { id, username, display_name }`; when off, `owner` is `null`. The album page shows "by Dan W (@dan.w)" with a **Report user** item in its ⋯ menu (Milestone 4's user report, signed in only).

### 8.7 Data export (owner, 2026-11-25)

| Request | Response |
|---|---|
| `POST /users/@me/exports` | `202 { "export": export }`. One per 24 h (`429 EXPORT_LIMIT { retry_after }`). Queues the `account_export` job on the `default` queue. |
| `GET /users/@me/exports` | `{ "items": [export] }` |
| `GET /users/@me/exports/<id>/download` | The ZIP, streamed by the API from B2: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="filesgg-export-<username>-<YYYY-MM-DD>.zip"`, `Cache-Control: private, no-store`. Not ready: `409 EXPORT_NOT_READY`. Expired or unknown: `404 UNKNOWN_EXPORT`. The dashboard links to `/api/users/@me/exports/<id>/download`, a same-origin navigation that carries the cookie. |

- **Export object:** `{ "id", "status": "queued" | "running" | "ready" | "failed" | "expired", "created_at", "ready_at", "expires_at", "size" }`.
- **The ZIP** (store mode, UTF-8 names) holds pretty-printed JSON files: `account.json` (the user object), `identities.json`, `sessions.json`, `upload_keys.json` (no secrets or hashes), `domains.json`, `files.json` (owner file payloads with unsigned URLs, no passwords), `albums.json` (with item ids, positions and captions), `reports.json` (reports you filed, with the thread as you see it), `notices.json` (your notices and appeals), and `README.txt` explaining each file. **No file bytes.**
- Stored at `exports/<user_id>/<export_id>.zip` in the files bucket, deleted after **7 days** (`EXPORT_KEEP_DAYS`) by `exports_cleanup` (hourly). Exports work during a deletion's grace period, so people can take their data before it goes.

### 8.8 Deleting the account (owner, 2026-11-25: 14-day grace period)

**States:** `active` → `pending_deletion` (14 days, cancellable) → `deleted` (permanent, a tombstone). Fields in §1.1.

**Requesting:**

```
POST /users/@me/delete { "confirm_username": "dan.w" }
→ 202 { "deletion": { "requested_at": 1795603600, "scheduled_for": 1796813200 } }
```

- **Requires:** a fresh session (§3.5, re-authentication); `confirm_username` equal to the username (`400 INVALID_PARAMETERS`). Staff (a `staff` row) get `409 ACCOUNT_DELETE_NOT_ALLOWED { reason: "staff" }` until `tools.staff` revokes them. Suspended accounts get `403 ACCOUNT_SUSPENDED` (§11.1); their erasure requests go to staff. Already pending: `409 ACCOUNT_DELETE_NOT_ALLOWED { reason: "pending" }`.
- **At once, in one transaction:**
  1. `deletion_requested_at = now()`, `deletion_scheduled_for = now() + 14 days` (`ACCOUNT_DELETION_GRACE_DAYS`);
  2. every **other** session ends (`deletion_requested`); the current one stays so the person can still cancel;
  3. upload keys stop working (`403 ACCOUNT_PENDING_DELETION`), but aren't revoked;
  4. the `account_deletion_requested` email is sent (verified email only).
- **During the grace period:**
  - **The account is locked.** Only these work: `GET /auth/session`, `GET /users/@me`, `POST /users/@me/delete/cancel`, sign-in (password, Discord, reset), logout, the sessions endpoints, and data exports. Everything else is `403 ACCOUNT_PENDING_DELETION { scheduled_for }`.
  - **Content is offline, as missing, never as removed.** The internal lookups (§10.7) return `owner_state: "pending_deletion"` for the account's files and albums. The Worker then renders the `missing` shell (`404`) on `files.gg`, and `404 private, no-store` on `cdn.files.gg`, for every file, preview, collage and ZIP of theirs. Only a valid **staff** grant still serves on the CDN. The API's public reads (`GET /files/<vanity>`, `GET /albums/<vanity>`, unlock, `/view`, refresh) answer `404 UNKNOWN_FILE` / `UNKNOWN_ALBUM`. No notice is created and nothing is shown as `removed`.
  - **Custom domains stop serving** (the domain lookup returns `serving: false`); their Cloudflare hostnames are kept until the permanent deletion.
  - **The username stays the account's,** so nobody else can take it. The email stays too (`EMAIL_TAKEN` for anyone registering with it).
  - Scanning, expiry and the Milestone 4 rules keep running on the content. The report endpoints still resolve the content by vanity, so a report filed just before isn't lost, and staff see everything in the admin pages.
  - Signing in shows only the **Keep my account** screen (§13.3).
- **Cancelling:** `POST /users/@me/delete/cancel` → `200 user`. Clears both fields; content, keys and domains work again within about 5 s (domains are re-checked at once); sends `account_deletion_cancelled`.
- **After 14 days,** the `account_deletion` task (hourly) takes accounts whose `deletion_scheduled_for <= now()` and runs the **permanent deletion** in one transaction per account:
  1. `users`: `deleted_at = now()`; `email`, `pending_email`, `password_hash`, `display_name`, `deletion_requested_at`, `deletion_scheduled_for` set to `NULL`; `username = 'deleted-' || id`; the old username goes into `username_holds` for 30 days. The `account_deleted` email is sent before the address is scrubbed.
  2. Every session revoked (`account_deleted`), every upload key revoked (`account_deleted`), every `account_tokens` row deleted, every `user_identities` row deleted (so the Discord account can sign up again), the active entitlement revoked (audit `revoke_entitlement`, `actor_kind: system`, `details.reason: "account_deleted"`).
  3. Every live file: `deleted_at = now()`, `deleted_reason = 'account_deleted'`, removed from albums; every live album soft-deleted the same way. The normal path queues `delete_blob` when a hash loses its last live file, and **blob garbage collection still skips anything under an `evidence_holds` row** (milestone-4 §1), so Milestone 4 preservation is unaffected.
  4. Every custom domain: `deleted_at = now()`, and a `domain_delete` job removes its Cloudflare hostname. Staff-disabled domains keep their row (§10.12).
  5. Open upload sessions are aborted (the existing abort job); data exports are deleted.
- **What stays after the permanent deletion:** the tombstone row (never hard-deleted: files, reports, cases and audit rows reference it); reports the person filed (they're part of cases), shown to staff as "deleted account"; reports and cases about them; notices and restrictions (for the audit trail); `moderation_actions` rows.
- **A suspension that starts during the grace period** doesn't stop the permanent deletion; Milestone 4 evidence holds keep what staff need. Staff can still read the account in the admin pages until then.

---

## 9. Premium entitlements (staff-granted for now)

### 9.1 The model (chosen)

A user is **premium** when they have a `user_entitlements` row with `kind = 'premium'`, `revoked_at IS NULL` and `expires_at` null or in the future. The user loader (`utils/auth.py`) selects it with the user:

```sql
EXISTS (SELECT 1 FROM user_entitlements e WHERE e.user_id = u.id AND e.kind = 'premium'
        AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())) AS premium
```

When paid plans ship, a plan subscription becomes another way to set `premium` (or writes these rows), and no call site changes.

### 9.2 `get_limits()` and what premium unlocks (owner, 2026-11-25)

Sizes use the units `api/utils/limits.py` already uses (`GB = 1024³`, `MB = 1024²`).

| Field | Anonymous | Signed in | Premium | Config |
|---|---|---|---|---|
| `storage_bytes` | `null` | 10 GB (10,737,418,240) | **100 GB** (107,374,182,400) | `LIMIT_STORAGE_BYTES`, `LIMIT_PREMIUM_STORAGE_BYTES` |
| `max_file_size_chunked` | 25 MB | 1 GB (1,073,741,824) | **5 GB** (5,368,709,120) | `LIMIT_CHUNKED_BYTES`, `LIMIT_PREMIUM_CHUNKED_BYTES` |
| `max_file_size_single` | 25 MB (25,000,000) | 100 MB (100,000,000) | ~~500 MB~~ **100 MB** (100,000,000; owner, 2026-11-25: Cloudflare's body limit can't carry more) | `LIMIT_SINGLE_BYTES`, `LIMIT_PREMIUM_SINGLE_BYTES` |
| `premium` | `false` | `false` | `true` | |
| `custom_domains` | `0` | `0` | `5` | `PREMIUM_CUSTOM_DOMAINS` |
| `domain_only_allowed` | `false` | `false` | `true` | |
| `upload_keys_max` | `0` | `20` | `20` | `UPLOAD_KEYS_MAX` |

- **`storage_limit_override`** (per user, set by staff) still wins over both the signed-in and premium storage defaults, in either direction.
- **`max_file_size_single` as reported and enforced** is `min(<the plan value above>, PROXY_BODY_LIMIT_BYTES − 1 MiB)`, because a single request can't be larger than what Cloudflare passes to the Worker (§9.5). `get_limits()` keeps the configured value in `max_file_size_single_configured`, so raising the proxy limit later changes nothing else.
- **Chunked uploads:** chunks stay **10 MiB** (`UPLOAD_CHUNK_SIZE`). `POST /uploads` checks the declared `size` against `max_file_size_chunked`; a premium 5 GB upload is 512 chunks, far under B2's 10,000-part limit, and every chunk request stays far under every proxy limit.
- Everything else (expiry, albums, conversions) is unchanged by premium.
- **`GET /users/@me/limits`** adds `premium`, `max_file_size_single_configured`, `custom_domains: { used, limit }` (`used` counts non-deleted domains that aren't staff-disabled) and `upload_keys: { used, limit }`. The existing `storage`, `max_file_size_single` and `max_file_size_chunked` fields carry the values above.
- **When premium ends,** new uploads get the signed-in limits at once. Nothing already stored is deleted. An account over the signed-in storage limit can't upload until it's under it (`STORAGE_LIMIT_REACHED`, as today), and the Overview meter explains why.

### 9.3 Granting and revoking (admin only)

| Request | Response |
|---|---|
| `GET /admin/users/<id>` | Milestone 4's detail, plus `premium`, `entitlements: [entitlement]` (history, newest first), `identities` (provider, provider user id, username, linked at), `sessions: { active }`, `upload_keys: [key]` (no secrets), `domains: [domain]`, `deletion` |
| `POST /admin/users/<id>/entitlements { kind: "premium", expires_at?, note }` | `201 entitlement`. `409 ENTITLEMENT_EXISTS` if one is active (extend it with `PATCH`). `note` required (≤ 2,000). `expires_at` must be in the future. |
| `PATCH /admin/users/<id>/entitlements/<eid> { expires_at, note }` | `entitlement` (`null` = until revoked) |
| `DELETE /admin/users/<id>/entitlements/<eid> { note }` | `200 entitlement` (with `revoked_at`) |

- **Entitlement object:** `{ "id", "kind": "premium", "active": true, "granted_at", "granted_by": { id, username } | null, "expires_at", "revoked_at", "revoked_by", "note" }` (`note` is staff only).
- **Permission:** `admin` role. Moderators get `403 FORBIDDEN`; non-staff the usual `404`. Permanently deleted users: `404 UNKNOWN_USER`.
- **Audit (`moderation_actions`, `actor_kind: staff`, target `user_id`):** `grant_entitlement`, `change_entitlement`, `revoke_entitlement`, each with `details: { entitlement_id, kind, expires_at }` and the `note`. The hourly `entitlements_expiry` task writes `entitlement_expired` (`actor_kind: system`) when one lapses.
- **CLI:** `python -m tools.entitlements grant <user_id> --kind premium [--days N] --by <name> --note <text>`, `revoke <user_id> --by <name> --note <text>`, `list`, logged with `actor_kind: cli` like `tools.staff`.
- **Emails:** `premium_changed` on grant, revoke and expiry.
- **When premium ends:** the limits in §9.2 drop; domains go to `paused` and domain-only stops applying (§10.3, §10.6). Upload keys pinned to a paused domain fall back to `files.gg` links.

### 9.4 Admin UI

`/app/admin/users/:id` gains a **Premium** card (status, granted by, expiry, history; **Grant**, **Change expiry**, **Revoke**, each asking for a note, admins only) and read-only cards for login methods, sessions (count, plus **Sign out everywhere**, §11.4), upload keys (with **Revoke**), domains (with the domain actions, §10.12) and a pending deletion's date.

### 9.5 Infrastructure limits that must change for premium

| Limit | Today | Needed | Notes |
|---|---|---|---|
| **Cloudflare request body** (per request to a Worker on the zone) | 100 MB on Free and Pro, 200 MB on Business; Enterprise up to 5 GB (Cloudflare's Workers limits page) | **500 MB** for premium single-request uploads | **Owner decision needed.** Below Enterprise, single-request uploads over the plan's limit get Cloudflare's own `413` page, never our JSON. Until the zone allows more, `PROXY_BODY_LIMIT_BYTES` (default `100000000`) caps `max_file_size_single` for everyone (§9.2), so premium ShareX and curl uploads stay at about 99 MB while premium **website** uploads use chunks and reach 5 GB. Options: an Enterprise zone, or accept the cap. A DNS-only upload host that bypasses Cloudflare isn't recommended (it loses the Worker's client-IP handling and Cloudflare's protections). Whether Cloudflare's "100 MB" means 10⁸ bytes isn't stated; the default assumes it does. |
| nginx `client_max_body_size` (`nginx/nginx.conf`) | `100M` | **`501M`** | The 500 MiB single limit plus multipart framing |
| Sanic `REQUEST_MAX_SIZE` (`api/app.py`) | 101 MiB | **501 MiB** (`525336576`) | The outer cap; the per-endpoint limits in §4.8 sit inside it |
| Chunk size | 10 MiB | unchanged | 5 GB = 512 parts (B2 allows 10,000) |
| `finalize_upload` copy | boto3's managed `client.copy` | unchanged | It switches to multipart copy (`UploadPartCopy`) above its threshold, so a 5 GB staging object copies without a single-request copy limit. **Confirm B2's `UploadPartCopy` on staging with a 5 GB file.** The job's lock heartbeat covers a long copy. |
| Worker temp disk (`worker`, `scanner`, `rescanner`) | sized for 1 GB files | at least 5 GiB free **per concurrent job**, plus headroom | `scan`, `probe` and `derive` stream each blob to a temp file |
| ClamAV `CLAMAV_MAX_BYTES` | 512 MiB | unchanged | Larger non-media files get Milestone 4's `too_large_to_scan` warning; more premium files will carry it |
| Cloudflare edge cache object size | 512 MB below Enterprise (5 GB on Enterprise), per Cloudflare's cache docs | none (nothing to configure) | Larger files are never edge-cached and always stream from B2; check the B2 egress terms (PLAN.md "Storage on Backblaze B2") |
| B2 read-back at finalize | each chunked upload is read back once | none | 5 GB uploads read 5 GB back; check against B2's free egress |
| Album "Download all" | 2 GiB cap | unchanged | |

---

## 10. Custom domains (premium)

### 10.1 Which hostnames (decided 2026-11-24: subdomains only)

`POST /users/@me/domains { hostname }` normalises and checks:
1. Trim, strip one trailing `.`, lowercase, then IDNA 2008 with UTS #46 to punycode (the `idna` package). Failure: `INVALID_HOSTNAME { reason: "syntax" }`.
2. ≤ 253 characters; every label 1–63 characters of `[a-z0-9-]`, not starting or ending with `-`; no `*` (`reason: "wildcard"`); not an IP address (`reason: "ip"`).
3. **Subdomains only:** using the Public Suffix List (ICANN and private sections, a **pinned snapshot** shipped in the image, never fetched at runtime), the hostname must have at least one label left of its registrable domain. `example.com` and `example.co.uk` are `reason: "apex"`; `co.uk` is `reason: "public_suffix"`. Cloudflare's docs support only a CNAME from a subdomain without Enterprise apex proxying, and say most DNS providers don't allow a CNAME at the root.
4. Not `files.gg` or under it, nor any `MAIN_HOST`, `CDN_HOST` or `API_HOST`, nor the CNAME target's zone (`reason: "reserved"`).
5. Not already a live domain on any account (`409 DOMAIN_TAKEN`, without saying whose).

### 10.2 Records the customer adds

The create response (and the domain object) carries:

```json
"records": [
  { "type": "CNAME", "name": "i.example.com", "value": "domains.files.gg", "ok": false },
  { "type": "TXT", "name": "_filesgg-verify.i.example.com", "value": "filesgg-verify=aaaqeayeaudaocajbifqydiob4", "ok": false }
]
```

- **CNAME** to `CUSTOM_DOMAIN_TARGET` (`domains.files.gg`). The customer's DNS record must be **DNS only** (not proxied), if their DNS is on Cloudflare.
- **TXT** at `_filesgg-verify.<hostname>`, value `filesgg-verify=` + `verify_token` (16 random bytes, base32 lowercase without padding, 26 characters). This is files.gg's own ownership check (PLAN.md "Taking over abandoned domains"), **in addition to** Cloudflare's validation: a dangling CNAME someone else left pointing at `domains.files.gg` can't be claimed without control of the zone.
- **No other records (chosen).** Cloudflare validates the custom hostname in real time once the CNAME points at us, and issues the certificate by **HTTP DCV**, which Cloudflare completes itself once the hostname points at its edge. Cloudflare's docs: HTTP DCV needs the hostname to already resolve to Cloudflare through the CNAME, and isn't allowed for wildcard certificates (we never request one).
- If the domain has **CAA** records, they must allow the CA Cloudflare uses. Settings shows this hint when the certificate stays pending for more than an hour.

### 10.3 Statuses

| `status` | Served? | Means | Leaves it when |
|---|---|---|---|
| `pending_dns` | no | The CNAME or our TXT isn't seen yet, or Cloudflare's hostname `status` isn't `active` | Both records are seen and Cloudflare's hostname is `active` → `pending_cert`. After **72 h** (`DOMAIN_PENDING_HOURS`) → `failed` (`status_reason: "dns_timeout"`), and the Cloudflare hostname is deleted (pending hostnames still count toward the bill). |
| `pending_cert` | no | Records fine; `ssl.status` is `initializing`, `pending_validation`, `pending_issuance` or `pending_deployment` | `ssl.status` is `active` → `active`. The same 72 h limit applies, counted from creation. |
| `active` | **yes** | Cloudflare hostname `active`, `ssl.status` `active`, our TXT matches | Any check fails → `failing` |
| `failing` | **yes** | Was active; a check is failing since `failing_since` | Checks pass → `active`. After **3 days** (`DOMAIN_FAILING_DAYS`) → `failed` (`status_reason: "dns_changed"`), Cloudflare hostname deleted, `domain_status` email. |
| `failed` | no | Gave up | **Retry** (§10.5) → `pending_dns` with a new 72 h window |
| `paused` | no | The owner isn't premium any more | Premium returns → `pending_cert` (re-checked at once). After **30 days** → `failed` (`status_reason: "premium_ended"`) and the Cloudflare hostname is deleted. |
| `disabled` | no | Staff disabled it (`disabled_reason`) | Staff `enable_domain` → re-checked at once |

A domain whose owner has a pending deletion keeps its `status` but isn't served (`serving: false`, §8.8).

Cloudflare's values (API reference, `custom_hostnames`): hostname `status` is one of `active`, `pending`, `active_redeploying`, `moved`, `pending_deletion`, `deleted`, `pending_blocked`, `pending_migration`, `pending_provisioned`, `test_pending`, `test_active`, `test_active_apex`, `test_blocked`, `test_failed`, `provisioned`, `blocked`; `ssl.status` has 21 values including `active`, `pending_validation`, `pending_issuance`, `pending_deployment`, `initializing` and several `*_timed_out` states. **Mapping:** hostname `active` or `active_redeploying` counts as active; `pending`, `pending_provisioned` and `provisioned` as pending; `moved`, `deleted`, `pending_deletion`, `blocked`, `pending_blocked` and anything unknown as failing (for a domain that was active) or pending (otherwise). `ssl.status` `active` counts as issued; `initializing`, `pending_validation`, `pending_issuance`, `pending_deployment`, `staging_deployment`, `staging_active` and `holding_deployment` as pending; anything else (`*_timed_out`, `expired`, `deleted`, `inactive`, `deactivating`, `pending_expiration`, `backup_issued`, …) as failing or pending as above. Cloudflare's own `moved` means a hostname stopped pointing at us or stayed pending through its whole retry schedule, and its `deleted` follows 7 days of `moved`.

### 10.4 Checks (chosen: polling)

- **`domain_checker`** (scheduled task, every minute) takes rows with `next_check_at <= now()` and `deleted_at IS NULL`, up to 50 at a time, and for each:
  1. `GET /zones/{zone_id}/custom_hostnames/{cf_hostname_id}` (stores `cf_status`, `cf_ssl_status`);
  2. TXT lookup of `_filesgg-verify.<hostname>`, and a CNAME lookup of `<hostname>` (`dnspython`, resolvers `1.1.1.1` and `8.8.8.8`, 3 s timeout). `dns_cname_ok` is true when the CNAME chain contains `CUSTOM_DOMAIN_TARGET`. `dns_txt_ok` is true when any TXT string equals the expected value exactly;
  3. applies §10.3 and sets `next_check_at`.
- **Schedule:** pending rows at 1, 2, 5, 10, 15 and 30 minutes after creation (or after a retry), then every 30 minutes; `active` daily, `failing` hourly; `paused`, `failed` and `disabled` aren't polled.
- **Why polling:** Cloudflare's "SSL for SaaS Custom Hostnames Alert" notifications cover only certificate events (`ssl.custom_hostname_certificate.*`); there's no event for the hostname `status`. Cloudflare itself rechecks pending hostnames 75 times over 7 days with backoff, and re-sending a `PATCH` with the same SSL settings restarts its checks.
- **"Check now"** (§10.5) runs these steps at once and, while Cloudflare's hostname or certificate is still pending, sends `PATCH /zones/{zone_id}/custom_hostnames/{id}` with the same `ssl` object as the create, which makes Cloudflare re-check.

### 10.5 API

| Request | Response |
|---|---|
| `GET /users/@me/domains` | `{ "items": [domain], "limit": 5, "domain_only": { "enabled": false, "effective": false, "paused": false } }` |
| `POST /users/@me/domains { hostname }` | `201 domain` (§10.1, §10.2, §10.13) |
| `POST /users/@me/domains/<id>/verify` | `domain` after an immediate check. Once a minute per domain (`429 DOMAIN_CHECK_RATE_LIMITED { retry_after }`). |
| `POST /users/@me/domains/<id>/retry` | `domain`. Only from `failed` (`409 DOMAIN_NOT_FAILED`). Creates a new Cloudflare hostname. Counts toward `domain_add`. |
| `PATCH /users/@me/domains/<id> { default?, scope?, confirm? }` | `domain`. `default: true` needs `active` or `failing` (`409 DOMAIN_NOT_ACTIVE`) and unsets any other default; `default: false` unsets it. `scope: "any"` needs `confirm: true` (the warning in §10.6). |
| `DELETE /users/@me/domains/<id>` | `204`. Sets `deleted_at` and queues `domain_delete`. A staff-disabled domain: `409 DOMAIN_DISABLED`. |
| `PUT /users/@me/domain-only { enabled, confirm? }` | `200 { "enabled", "effective", "paused", "affected_files", "affected_albums" }`. §10.6. |
| `GET /users/@me/domain-only/preview` | `{ "affected_files": 142, "affected_albums": 3 }`: live `link` and `password` files and albums that would stop showing on files.gg |

**Domain object:**

```json
{
  "id": "…", "hostname": "i.example.com", "status": "pending_dns", "status_reason": null,
  "serving": false, "is_default": false, "scope": "own",
  "records": [ …§10.2… ],
  "cloudflare": { "status": "pending", "ssl_status": "initializing" },
  "created_at": 1795603600, "verified_at": null, "last_checked_at": 1795603660,
  "pending_until": 1795862800, "failing_since": null, "disabled_reason": null
}
```

`serving` is `true` exactly when `status` is `active` or `failing`, the owner is premium, and the owner's account is `active` (not pending deletion) (§10.7).

**Cloudflare calls** (`https://api.cloudflare.com/client/v4`, the API token in the `Authorization` header, 10 s timeout):

| Step | Call |
|---|---|
| Create | `POST /zones/{zone_id}/custom_hostnames` with `{ "hostname": "<hostname>", "ssl": { "method": "http", "type": "dv", "settings": { "min_tls_version": "1.2", "http2": "on", "tls_1_3": "on" } } }`. Stores `result.id` as `cf_hostname_id`. `custom_metadata` isn't sent (an Enterprise add-on). |
| Read | `GET /zones/{zone_id}/custom_hostnames/{id}` |
| Re-check | `PATCH /zones/{zone_id}/custom_hostnames/{id}` with the same `ssl` object |
| Delete | `DELETE /zones/{zone_id}/custom_hostnames/{id}` (also removes its certificates). `404` from Cloudflare counts as done. |

- A Cloudflare error or timeout on create is `503 DOMAINS_UNAVAILABLE` and nothing is stored. The `domain_delete` job retries with the jobs queue's backoff.
- Cloudflare's API reference lists "SSL and Certificates Write" (dashboard: "SSL and Certificates: Edit") on the zone for these calls (§17).
- Cloudflare refuses a custom hostname equal to the zone name; §10.1 step 4 already stops it.

### 10.6 "Only my files" and domain-only mode

**Per domain: `scope`** (PLAN.md, decided 2026-11-24):

| `scope` | `https://i.example.com/<vanity>` for… | Result |
|---|---|---|
| `own` (default) | the domain owner's file or album | Served (subject to access and safety, as on files.gg) |
| `own` | anyone else's | `missing` shell, `404`; CDN paths `404` |
| `any` | anyone's `link` or `password` file or album | Served. Reports still go to each file's uploader. |
| either | a `private` file | `missing` shell; only an owner pass (`#t=`) opens it, and only for its owner |

Turning `scope` to `any` needs `confirm: true` (the dashboard first shows "Other people's files will be viewable on your domain."). Staff can force it back to `own` (§10.12). Content of an account with a pending deletion is missing on every host, whatever the scope (§8.8).

**Account-wide: domain-only mode** (`PUT /users/@me/domain-only`):
- Needs premium (`403 PREMIUM_REQUIRED`) and, to turn on, at least one serving domain (`409 DOMAIN_ONLY_NOT_AVAILABLE`). Turning on needs `confirm: true` after the dashboard shows the counts from `/preview` ("142 files have files.gg links that will stop working, including links already shared in Discord").
- **Effective** (`served_on = "custom"`) exactly when: `users.domain_only` **and** the owner is premium **and** at least one of their domains is serving. Otherwise it's **paused**: files.gg serves the files again. When it pauses (the last serving domain fails, is paused or disabled, or premium ends), the owner gets one `domain_status` email ("Your domain isn't working, so your files are showing on files.gg again"), tracked by `domain_only_paused_at`; resuming clears it and sends one more.
- **Effect when effective** (Worker only, §10.7–§10.9):
  - `files.gg/<vanity>` and `files.gg/a/<vanity>` for the owner's files and albums render the `missing` shell (`404`), like a missing file;
  - `cdn.files.gg` answers `404` for their files, previews, collages and ZIPs, **unless** the URL carries a valid signature: a file or album grant (owner payloads and unlocks) or a staff grant;
  - their custom domains serve everything as usual.
- **The API doesn't apply it (chosen):** public API reads (`GET /files/<vanity>`, `GET /albums/<vanity>`, unlock, `/view`, refresh) answer as before. It's a branding feature, not privacy (PLAN.md), and this keeps unlocks and album pagination working from custom domains.
- **No `access_version` bump** when it's toggled **(chosen;** the plan bumped it to kill owner tokens, but owner passes and signed URLs are meant to keep working for the owner, and the lookup's `served_on` applies within 5 s).
- **Owner payloads** (`/users/@me/files`, albums, upload responses) sign **every** URL with the owner's grant while domain-only is effective, including `link` files, so the dashboard's thumbnails and drawer keep working on files.gg.
- Independent of `scope`: `scope` is which files a domain shows; domain-only is whether files.gg shows them.

### 10.7 Worker ↔ API: the domain lookup

```
GET /internal/domains/<hostname>
X-Filesgg-Origin-Secret: <ORIGIN_SHARED_SECRET>
X-Filesgg-Internal-Lookup: 1
```

```json
{ "domain": { "id": "…", "hostname": "i.example.com", "user_id": "…", "scope": "own", "serving": true } }
```

- `404` for an unknown, deleted or malformed hostname. Not serving (pending, failed, paused, disabled, or the owner pending deletion) is returned with `serving: false`.
- Both headers are required, exactly like the file and album lookups (milestone-3 §5, security review 2026-11-25), and the path is unreachable through either passthrough.
- Cached with the Cache API for **5 s** (chosen; the lookup cache everywhere is 5 s), negative entries too, under `…/v6/domains/<hostname>`.
- `GET /internal/files/<vanity>` adds `served_on: "files.gg" | "custom"` (§10.6) and `owner_state: "active" | "pending_deletion"` (§8.8); `owner_user_id` is already there. `GET /internal/albums/<vanity>` adds `owner_user_id`, `served_on` and `owner_state`. The lookup cache key version becomes **`v6`**.

### 10.8 How the Worker serves a custom host

**Routing:** the Worker gets a fourth router for every hostname that isn't `MAIN_HOST`, `www.MAIN_HOST`, `CDN_HOST` or `API_HOST`. Cloudflare sends custom hostnames to it through the SaaS zone's `*/*` route (§17).

**Per request:**
1. `/.well-known/acme-challenge/*`, `/.well-known/pki-validation/*` and `/.well-known/cf-custom-hostname-challenge/*` pass straight through (`return fetch(request)`), so Cloudflare's own validation is never answered by us. **Verify on staging** that Cloudflare's edge answers these before the Worker (§18).
2. Domain lookup. `404` or `serving: false` → a minimal page: `404`, `Cache-Control: no-cache`, "This domain isn't connected to files.gg right now.", no filename, no branding beyond "files.gg".
3. Classify the path:

| Path on the custom domain | Serves | Same as |
|---|---|---|
| `/` | A landing card (`data-page="domain-home"`): "Files hosted with files.gg" and a Report link | none |
| `/<vanity>`, `/<vanity>.<anything>` | The viewer shell, with the bot and embed routing (redirects go to `https://<host>/files/<vanity>.<ext>`) | `files.gg/<vanity>` |
| `/a/<vanity>`, `/a/<vanity>/<n>` | Album shell | `files.gg/a/<vanity>` |
| `/report`, `/<vanity>/report`, `/a/<vanity>/report` | Report pages (milestone-4 §10.1) | same |
| `/files/<vanity>.<ext>` | Bytes, with the full `cdn.files.gg` hardening | `cdn.files.gg/files/…` |
| `/previews/<kind>/<vanity>.<ext>` | Previews | `cdn.files.gg/previews/…` |
| `/albums/collage/<vanity>.webp`, `/albums/download/<vanity>.zip` | Collage, ZIP | `cdn.files.gg/albums/…` |
| `/assets/*` and the root files | `web/dist`, as on files.gg | same |
| anything else (`/app`, `/api`, `/login`, `/convert`, `/challenge`, `/.well-known/security.txt`) | `404` | |

4. **Owner and scope check** after the file or album lookup: with `scope: "own"`, the lookup's `owner_user_id` must equal the domain's `user_id`, else it's treated as missing (shell `404`, CDN `404`). Anonymous files (`owner_user_id: null`) never match `own`.
5. **`owner_state: "pending_deletion"`** → missing (shell `404`, CDN `404`). **`served_on` is ignored** on custom domains: a domain-only owner's files are meant to be here.
6. Then exactly the `files.gg` shell decision order (milestone-4 §10.1) for pages, and the CDN order (milestone-4 §10.2) for byte paths, including safety states, NSFW and signed-URL checks.

**On `files.gg`,** the file and album decision order gains two steps after "blocked → missing": **`owner_state` is `pending_deletion` → `missing`**, then **`served_on` is `custom` → `missing`**. **On `cdn.files.gg`,** after the staff-grant step (a valid staff grant still serves both cases): `owner_state` is `pending_deletion` → `404`; `served_on` is `custom` and there's no valid file or album signature → `404`. Both answers are `private, no-store`.

### 10.9 Links, signed URLs and passes across hosts

- **Rehosting (chosen).** Signed URLs cover the path only (milestone-3 §3), so the same signature is valid on any host that serves that path. `rehost(url, host)`:
  - a URL whose origin is the CDN origin (`CDN_URL`, `https://cdn.files.gg`) or the public origin (`PUBLIC_URL`, `https://files.gg`) gets its origin replaced with `https://<host>`; the path, query and fragment are kept byte for byte;
  - any other URL is returned unchanged.
  
  The Worker applies it to every URL in the inlined boot data and meta tags on a custom host. The viewer applies it to every URL in API responses (unlock, `/view`, refresh, album pages) when the shell says it's on a custom host (§13.4). Vectors in §16.5.
- **Owner-facing links** (upload responses and owner payloads; public payloads keep `files.gg`):
  - `url`: `https://<link domain>/<vanity>`, where the **link domain** is, in order: the upload key's pinned domain if serving (upload responses through that key), the default domain if serving, else `files.gg`;
  - `url_with_password`: the same base, with `#pw=`;
  - `direct_url` (new): `https://<link domain>/files/<vanity>.<ext>`, signed like `cdn_url` when the file is protected;
  - `cdn_url` and the asset URLs stay on `cdn.files.gg` (signed as needed, §10.6), because the dashboard displays them and must keep working if the domain breaks.
  - The dashboard's **Copy link** copies `url`; **Copy direct link** copies `direct_url`.
- **Owner passes:** `POST /users/@me/files/<id>/pass { domain_id? }` and `POST /users/@me/albums/<id>/pass { domain_id? }` return `url` on that domain (`https://i.example.com/<vanity>#t=<token>`) when it's one of your serving domains (`409 DOMAIN_NOT_ACTIVE` otherwise), else on files.gg as today. The token is unchanged and works on every host, because the viewer redeems it at the API's `…/view` (cross-origin `api.files.gg` on a custom host, same-origin `/api` on files.gg). The dashboard's "Open on i.example.com" uses it; minting a pass needs the session cookie, so it's a dashboard action only.
- **Unlock tokens** are kept per origin by the viewer, so unlocking on `files.gg` doesn't unlock on `i.example.com`, as the plan says.
- **Staff URLs** (`staff=`) are accepted **only on `cdn.files.gg`**. On a custom host a `staff=` parameter is a bad signature (`401` for password files, `404` otherwise).

### 10.10 Turnstile on custom domains (chosen: a files.gg frame)

A Turnstile widget allows at most **10 hostnames** on the free plan (200 on Enterprise), with no wildcards, so customer hostnames can't be added to it. Password unlocks (Turnstile on **every** unlock, decided 2026-11-24) and anonymous reports on a custom domain use a frame instead:

- The custom-domain viewer embeds `https://files.gg/challenge?host=<location.hostname>&action=unlock` (or `action=report`) in a small iframe in the lock screen or report dialog.
- **The Worker** serves `/challenge` on `MAIN_HOST` only when `host` is a serving custom domain (domain lookup) and `action` is `unlock` or `report`; else `404`. It renders `web/dist/challenge.html` (a third, tiny entry: no React, just the Turnstile script) with `#challenge-data` = `{ "host": "<host>", "action": "<action>" }` and these headers: `Content-Security-Policy: default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors https://<host>`, `Cache-Control: no-store`. The page makes no API calls, so the session cookie (which the browser may attach to the frame's navigation when it's same-site, and doesn't when the custom domain is cross-site) is never used.
- **The frame** renders Turnstile in managed mode with `action` and `cData` = the host, and on success calls `parent.postMessage({ type: "filesgg:turnstile", token }, "https://<host>")`. The viewer accepts messages only from `https://files.gg` (`MAIN_HOST`'s origin) with that `type`.
- **The API** checks the token as usual: `success`, `action`, and `hostname` = `files.gg`.
- **Verify while building** that Turnstile behaves normally inside a cross-origin frame (§18).

### 10.11 CSP, cookie isolation and API calls

- **Viewer pages on a custom host** use `viewerCsp` with the custom origin as `'self'`:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://api.files.gg https://cdn.files.gg; img-src 'self' https://cdn.files.gg blob: data:; media-src 'self' https://cdn.files.gg blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src https://files.gg; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` (origins from the host vars). The Turnstile host isn't needed there (§10.10).
- **API calls from a custom host** go cross-origin to `api.files.gg` with `credentials: "omit"`: unlock, `/view`, refresh, album pages and reports (anonymous, through the challenge frame). The API's public routes answer non-allowlisted origins with `*` and no credentials, and `X-Filesgg-Access` is an allowed header. There's no session there, by design: owner-only actions (owner passes, edits, deletes) happen in the dashboard on `files.gg`.
- **Byte paths on a custom host** get exactly the `cdn.files.gg` headers: the sandbox CSP (`frame-ancestors` = the `files.gg` origin), `nosniff`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin`, the `inline` allowlist and forced text. The sandbox makes any document an opaque origin, which matters more here: the bytes share an origin with that domain's viewer pages, whose storage holds unlock tokens for that domain's files (never a files.gg session).
- **No cookies:** the session cookie is host-only on `files.gg`, so browsers never send it to a custom domain. The Worker also strips any `Cookie` header from custom-host requests, sets no cookies there, and deletes any `Set-Cookie` from upstream responses. Cloudflare may still add its own bot-management cookies; that's outside the Worker.
- **HSTS:** `Strict-Transport-Security: max-age=31536000`, **without** `includeSubDomains` or `preload` (the domain isn't ours).

### 10.12 Abuse and moderation

- **Every Milestone 4 protection applies unchanged** on custom domains: scanning gates, safety states, NSFW, reports and the CDN rules.
- **Reports:**
  - `url` targets (milestone-4 §7.3) also resolve URLs on any **live** custom domain, by the same paths, to the file or album they show. The report records `domain_id` for staff.
  - A new target `{ "type": "domain", "hostname": "i.example.com" }` (signed in or anonymous) with reasons `malware` (phishing), `spam`, `harassment` or `other`. It opens a `domain` case at the reason's priority. **No automatic effect** at any count (chosen).
  - The custom-domain landing card and viewer show **Report**, which opens the same dialog (anonymous there, with Turnstile through §10.10).
- **Staff actions** (`POST /admin/actions`, target `{ "type": "domain", "id" }`):

| `action` | Who | Effect | Notice |
|---|---|---|---|
| `disable_domain` | moderator, admin | `status = 'disabled'`, `disabled_reason` = `rule`, `disabled_action_id`. Serving stops within 5 s. The Cloudflare hostname is kept, and the owner can't delete the row, so nobody can re-add the hostname. | yes, appealable, `target.kind: "domain"` |
| `enable_domain` | moderator, admin | Clears `disabled_*`, re-checks at once | no |
| `set_domain_scope` | moderator, admin | Forces `scope = 'own'` | yes |

  `rule` is required for `disable_domain` and `set_domain_scope`. Each writes `moderation_actions` with `domain_id`. Disabling a user's last serving domain pauses their domain-only mode (§10.6).
- `GET /admin/domains?q&status&cursor` → `{ "items": [admin domain], "next_cursor" }`; `GET /admin/domains/<id>` → the domain object plus `owner` (`{ id, username }`), `cf_hostname_id`, its cases and its actions. Moderators and admins can read both. `GET /admin/lookup?q=` also matches hostnames and returns `domains: […]`. Admin pages: `/app/admin/domains` and `/app/admin/domains/:id`.
- **Suspended owners' domains** keep serving, like their content (milestone-4 §8.4), until staff act.

### 10.13 Limits and requirements

| Rule | Default | Error |
|---|---|---|
| Premium | `custom_domains` from `get_limits()` (5) | `403 PREMIUM_REQUIRED` without premium; `400 DOMAIN_LIMIT_REACHED { limit }` at the limit |
| Verified email | required to add or retry | `403 DOMAIN_REQUIREMENTS { reason: "email_not_verified" }` |
| Account age | ≥ 7 days (`DOMAIN_MIN_ACCOUNT_AGE_DAYS`), from `created_at` | `403 DOMAIN_REQUIREMENTS { reason: "account_too_new", available_at }` |
| Adds and retries | 10 a day per user (`domain_add`) | `429 TOO_MANY_ATTEMPTS { retry_after }` |
| All accounts together | `CUSTOM_DOMAINS_GLOBAL_MAX` (1,000) live Cloudflare hostnames, a cost guard | `503 DOMAINS_UNAVAILABLE` |

**Cost** (Cloudflare for SaaS plans page, read 2026-11-25): Free, Pro and Business zones include **100** custom hostnames, then **$0.10** per additional hostname, up to **50,000** (Enterprise is custom). The page doesn't say "per month"; the plan's "per month" is unconfirmed. Hostnames count while pending, which is why pending, failed and long-paused hostnames are deleted (§10.3).

---

## 11. Milestone 4 integration

### 11.1 Suspended accounts (owner, 2026-11-25)

Milestone 4 lets a suspended account sign in and use `GET /users/@me`, `GET /users/@me/badges`, the warnings endpoints and logout; everything else is `403 ACCOUNT_SUSPENDED`. The middleware's allowlist (`standing.SUSPENDED_ALLOWED`) becomes:

| Allowed while suspended | Why |
|---|---|
| `GET /auth/session`, `POST /auth/login`, `/auth/discord/authorize` (`purpose: login` or `reauth`), `/auth/discord/callback` (same), `/auth/logout`, `/auth/forgot`, `/auth/forgot/reset`, `/auth/verify`, `/auth/verify/resend`, `/auth/reauth` | Signing in and account recovery |
| `GET /users/@me`, `/users/@me/badges`, `/users/@me/warnings*` | Milestone 4 |
| `GET`, `DELETE /users/@me/sessions*`, `PUT /users/@me/password` | Account security |
| `POST`, `GET /users/@me/exports*` | Access to their data |

Everything else, including `POST /auth/discord/authorize` with `purpose: link`, upload keys, domains, profile changes and `POST /users/@me/delete`, is `403 ACCOUNT_SUSPENDED`. The current prefix rule that lets all of `/auth/` through is replaced by this list. The middleware now reads the session from the cookie (§3.4) instead of the `Authorization` header.

### 11.2 Restrictions

`uploads` restrictions refuse uploads whatever authenticates them: the session cookie and upload keys alike (`403 UPLOADS_RESTRICTED`). Everything else in this contract works.

### 11.3 Bans

Milestone 4's fingerprint and IP bans now also refuse `POST /auth/register` and `POST /auth/discord/signup` from a banned fingerprint or IP hash (`403 BANNED`) **(chosen)**. They still don't affect sign-in, viewing or reports. An upload key used from a banned IP is refused like any upload (`403 BANNED`).

### 11.4 Staff

- **New staff actions on users** (`POST /admin/actions`, target `user`):

| `action` | Who | Effect |
|---|---|---|
| `revoke_sessions` | moderator, admin | Ends every session (`revoked_reason = 'staff'`). No notice. |
| `revoke_upload_keys` | moderator, admin | Revokes every key, or one with `details.key_id` (`revoked_reason = 'staff'`). Notice: yes, not appealable ("An upload key was revoked"). |
| `reset_username` | moderator, admin | Sets `username = 'u' || id`, `needs_username = true`; the old name is held 30 days. `rule` required (for example `harassment`). Notice: yes, appealable. |

- All are logged in `moderation_actions`; `GET /admin/users/<id>` shows the new account fields (§9.3), never tokens, hashes, verify tokens or password hashes.
- **Every `/admin/*` endpoint** needs a staff member's **session cookie** (with the CSRF header on writes); an upload key, or a signed-out caller, gets the plain `404`.
- Staff can't request deletion of their account while they're staff (§8.8). Revoking staff stays the `tools.staff` CLI.
- **Lookup:** `GET /admin/lookup?q=` also matches usernames (exact, after lowercasing), Discord user ids (exact), upload key prefixes (`fgg_` plus 8) and hostnames.

### 11.5 Reports and notices

- User reports (milestone-4 §7.1) are reachable from the album owner line (§8.6) and admin pages. There are no public profiles.
- New report target `domain` and case kind `domain` (§10.12).
- Notices (`user_warnings`) can target `kind: "domain"`; `GET /users/@me/warnings` shows them with the hostname.
- The report dialog on `files.gg` uses the session cookie when signed in (`POST /api/reports`), else `POST /api/reports/anonymous` (§13.1).

---

## 12. Worker changes (`cf-worker/`), in one list

1. **Cookies:**
   - **`files.gg/api/*`** (the passthrough): forward only the session cookie (`SESSION_COOKIE_NAME`, default `__Host-filesgg_session`) in the `Cookie` header, dropping every other cookie; set `X-Filesgg-Via: main`; pass the API's `Set-Cookie` through only when it sets or clears that one cookie.
   - **Everywhere else** (`files.gg` pages and assets, `api.files.gg`, `cdn.files.gg`, custom hosts): delete the `Cookie` header before any upstream request, and delete `Set-Cookie` from every upstream response.
   - **Strip client copies** of `X-Filesgg-Via` from every request, like `X-Filesgg-Internal-Lookup`. The internal lookups are built by the Worker itself and never carry a cookie; both passthroughs keep answering `404 NOT_FOUND` for any path that normalises to `/internal`.
2. **CORS:** credentialed CORS is removed. No response from `files.gg/api/*` or `api.files.gg` carries `Access-Control-Allow-Credentials`; cross-origin callers of public routes get `*` without credentials, as today. `CORS_ALLOWED_ORIGINS` is removed. Same-origin calls to `files.gg/api/*` need no CORS.
3. `/login`, `/register`, `/signup` redirects and the `/challenge` frame on `MAIN_HOST` (§6.2, §10.10).
4. The reserved segments in §6.3.
5. A custom-host router (§10.8) with the domain lookup (§10.7), the scope check, rehosting (§10.9), the custom CSP, HSTS and cookie stripping (§10.11).
6. `owner_state` and `served_on` on `files.gg` (shell `missing`) and on `cdn.files.gg` (`404`, with the exceptions in §10.8).
7. `staff=` refused on custom hosts (§10.9).
8. The lookup cache key version `v6`.
9. `wrangler.toml` gains the `*/*` route on the zone (§17), keeps the existing routes, and gains the var `SESSION_COOKIE_NAME` (unset: `__Host-filesgg_session`; the local stack sets `filesgg_session`). No new secrets: the domain lookup uses `ORIGIN_SHARED_SECRET`.
10. Tests:
    - unit tests for routing and rehosting;
    - workerd integration tests:
      - a custom host (own and any scope, private, domain-only on files.gg and the CDN, a pending deletion, a signed URL served on both hosts);
      - the challenge page's `frame-ancestors`;
      - the cookie rules: forwarded only on `files.gg/api`; stripped on `api.files.gg`, pages, the CDN and custom hosts; `Set-Cookie` dropped everywhere but `files.gg/api`; `X-Filesgg-Via` never accepted from a client.

---

## 13. Web (`web/`)

### 13.1 Sign-in state and API calls

- **API base:** the dashboard and the `files.gg` viewer call the API **same-origin** at `/api` (`lib/api.ts`: `apiBaseUrl()` defaults to `/api`; `VITE_API_URL` stays only for unusual local setups). Requests use `credentials: "same-origin"`, so the browser sends the session cookie. No credential is ever stored or read by JavaScript; `authHeaders()` sends only `X-Fingerprint` (while signed out) and, on every non-`GET` request, `X-Filesgg-Csrf: 1`. Upload progress (XHR) uses the same base and headers.
- **`useSession()`** (TanStack Query over `GET /api/auth/session`, stale after 60 s, refetched on focus) replaces `hasToken()`. It returns the user or `null`. `useMe()` reads the same query.
- **Any `401 UNAUTHORIZED`** on a signed-in call (the server has already cleared the cookie) resets the session query and the cache, and shows a toast "You were signed out." with **Sign in**. `403 CSRF` is a bug report in the console and a generic error toast; it never happens in normal use.
- **Tabs stay in step:** after sign-in, sign-out or a `401`, the app posts `"session-changed"` on `BroadcastChannel("filesgg-session")`, and every open tab refetches the session.
- **The `files.gg` viewer** asks `GET /api/auth/session` only when the report dialog opens (to pick `POST /api/reports` or `/api/reports/anonymous`); it never fetches the user on load.
- **The custom-host viewer** never has a session and uses `https://api.files.gg` without credentials (§10.11).
- After sign-in: remove `filesgg.fingerprint` (§4.2), broadcast, and go to `next` or `/app`. After sign-out: `POST /api/auth/logout`, broadcast, clear the cache, go to `/app`.

### 13.2 New pages

| Route | Contents |
|---|---|
| `/app/login` | Email, password, **Sign in**; **Continue with Discord**; "Forgot password?"; "Create an account". Managed Turnstile under the form. Errors: wrong email or password, too many attempts ("Try again in N minutes"), Turnstile failed ("Couldn't verify you're human. Try again."). |
| `/app/register` | Email, username (lowercased as you type, checked with `/username/check` after 400 ms, with the reason shown), display name (optional), password with the zxcvbn meter (minimum 8, no maximum), Turnstile; **Continue with Discord**. Note: "Files you uploaded from this browser will move to your account." |
| `/app/verify` | Reads `#token=`, calls `/api/auth/verify`: "Email verified" or "This link is invalid or has expired", with **Send a new link** when signed in. |
| `/app/forgot` | Email and Turnstile, then always "If an account uses that email, we've sent a link. It works for 1 hour." |
| `/app/reset` | Reads `#token=`; new password (meter) and Turnstile; signs in on success. |
| `/app/auth/discord` | The callback (§5.2). For `signup_required`: "Choose your username" with the suggestion filled in, a display name, the email line ("We'll use dan@example.com from Discord" / "Discord didn't share a verified email. You can add one later."), Turnstile and **Create account**. For `DISCORD_EMAIL_IN_USE`: the message and **Sign in**. For `link` and `reauth`: returns to Settings with a toast. |

### 13.3 Dashboard sections

- **Sidebar footer:** signed out, **Sign in** and **Create account**; signed in, the initials tile, display name and `@username`, and a menu with Settings and **Sign out**. Signed-out dashboard pages keep working for anonymous files as today, with their "Sign in" prompts now linking to `/app/login?next=<current page>`.
- **`needs_username`:** a blocking dialog on every dashboard page until a new name is saved ("Your username was reset by files.gg staff. Choose a new one.").
- **Pending deletion:** while `user.deletion` is set, every dashboard route shows only a full-page card: "Your account will be deleted on <date>. Your files and albums are offline until then." with **Keep my account** (`POST /api/users/@me/delete/cancel`), **Download my data** (exports), and **Sign out**.
- **Unverified email:** a dismissible banner "Verify your email to recover your account and add domains" with **Resend**.
- **Overview:** the storage meter uses the premium limit when premium; a "Premium" badge with the expiry date, if any.
- **Upload:** the size checks use `max_file_size_chunked` (5 GB premium) for the website's chunked path, and the help text names the single-request limit for ShareX and curl.
- **Integrations** (`/app/integrations`):
  - the key list: name, prefix (`fgg_0123ABCD…`), scopes, pinned domain, created, last used ("Never"), expiry, state; **Rename**, **Revoke** (confirm);
  - **Create key** dialog: name; "Also allow adding to albums"; link domain (default, or one of your domains); expiry (never, 30, 90, 365 days); ShareX defaults (expiry, access, NSFW, album), which go only into the `.sxcu` `Arguments`;
  - the result panel, shown once: the key with **Copy**, **Download ShareX config** (`.sxcu` from the response), the curl snippet with **Copy**, and "This is the only time the key is shown";
  - at 20 keys, **Create key** is disabled with the reason.
- **Settings** (`/app/settings`, tabs in the URL):
  - **Profile** (`/app/settings`): username with cooldown text ("You can change it again on 25 Dec"), display name, the initials preview, "Show my name on albums";
  - **Security** (`/app/settings/security`): email (verified badge, change with pending state and **Cancel**), password (set or change, with current password), **Login methods** ("Connected accounts": Discord with avatar and username, **Link** or **Unlink**, Unlink disabled with the reason when it's the last method), **Sessions** (device, country, last used, "This device", **Sign out** per row, **Sign out everywhere**, which also signs this browser out);
  - **Domains** (`/app/settings/domains`, §13.4);
  - **Data** (`/app/settings/data`): **Request export** and the export list with **Download**; **Delete account** (type the username, re-authenticate, then a final confirmation: "Your files and albums go offline now. Sign in within 14 days to keep your account; after that it's deleted for good.").
  - Re-authentication is a shared dialog: the password field, or **Continue with Discord** (`purpose: reauth`), opened on `REAUTH_REQUIRED` and retried after.

### 13.4 Domains page and custom-host viewer

- **Domains** (`/app/settings/domains`):
  - non-premium: a short explanation of custom domains, "Premium is granted by files.gg staff for now", and no form;
  - premium: **Add domain** (hostname, then the setup card with both records and **Copy** buttons, the DNS-only hint, and the live status: "Waiting for DNS" → "Issuing certificate" → "Active"); the page polls `GET /api/users/@me/domains` every 10 s while any domain is pending and the page is visible;
  - each domain: status with its reason, **Check now**, **Set as default**, the **Only my files** switch (turning it off asks for confirmation), **Remove** (confirm), **Retry** when failed, and the staff-disabled reason with "Appeal in Notices";
  - the account-wide **Only show my files on my domain** switch, disabled without a serving domain; turning it on shows the `/preview` counts and needs confirmation; a "Paused because no domain is working" note when paused.
- **Files, albums and the drawer:** **Copy link** uses `url`; **Copy direct link** uses `direct_url`; "Open on i.example.com" mints an owner pass for the default domain.
- **The custom-host viewer:** the Worker sets `data-host="custom"` on the root and adds `#host-data` = `{ "host": "i.example.com", "main_origin": "https://files.gg", "api_origin": "https://api.files.gg" }`. The viewer then calls `api_origin` without credentials, rehosts API URLs (§10.9), uses the `/challenge` frame for Turnstile (§10.10), builds Copy link from `location.origin`, shows no sign-in, owner or dashboard links, and keeps its unlock tokens in that origin's storage. The landing card (`data-page="domain-home"`) shows "Files hosted with files.gg" and **Report**.
- **`mock-api.ts`** gains every endpoint in this contract (a signed-in user with Discord linked, keys, a premium user with one active and one pending domain, an account with a pending deletion), mounted under `/api` with a fake session cookie, so `npm run dev` works without the API.

---

## 14. Error codes

Removed: `UNKNOWN_EMAIL` (§4.4). Kept with new uses: `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `USERNAME_TAKEN`, `EMAIL_TAKEN`, `INVALID_EMAIL`, `INVALID_TOKEN`, `SAME_PASSWORD`, `CAPTCHA_INVALID`, `TOO_MANY_ATTEMPTS`, `TOO_MANY_UPLOADS` (adds `retry_after` for keys), `STORAGE_LIMIT_REACHED`, `FILE_TOO_LARGE`, `BANNED`, `ACCOUNT_SUSPENDED`, `UPLOADS_RESTRICTED`, `FORBIDDEN`, `UNKNOWN_USER`.

| Code | HTTP | Details | Where |
|---|---|---|---|
| `CSRF` | 403 | | A state-changing cookie request, or an `/auth/*` `POST`, without `X-Filesgg-Csrf: 1` or with a foreign `Origin` / `Sec-Fetch-Site` (§3.6) |
| `REQUEST_TOO_LARGE` | 413 | `limit` | §4.8 |
| `USERNAME_INVALID` | 400 | `reason`: `length`, `characters`, `dots`, `numeric`, `reserved` (field error on `username`) | Register, Discord sign-up, rename |
| `USERNAME_COOLDOWN` | 409 | `available_at` | Rename |
| `DISPLAY_NAME_INVALID` | 400 | `reason`: `length`, `reserved` | Register, sign-up, profile |
| `INVALID_PASSWORD` | 400 | `reason`: `too_short`, `matches_username`, `matches_email` | Register, reset, password change |
| `EMAIL_NOT_VERIFIED` | 403 | | Setting a first password without a verified email |
| `NOTHING_TO_VERIFY` | 409 | | Resend |
| `REAUTH_REQUIRED` | 403 | `methods` | §3.5 |
| `INVALID_OAUTH_STATE` | 400 | | Discord callback |
| `DISCORD_CODE_INVALID` | 400 | | Discord callback |
| `DISCORD_UNAVAILABLE` | 503 | `retry_after?` | Discord callback |
| `INVALID_SIGNUP_TOKEN` | 400 | | Discord sign-up |
| `DISCORD_EMAIL_IN_USE` | 409 | | Discord sign-up |
| `IDENTITY_IN_USE` | 409 | | Link, sign-up |
| `IDENTITY_ALREADY_LINKED` | 409 | | Link |
| `IDENTITY_MISMATCH` | 403 | | Discord re-auth |
| `UNKNOWN_IDENTITY` | 404 | | Unlink |
| `LAST_LOGIN_METHOD` | 409 | | Unlink |
| `UNKNOWN_SESSION` | 404 | | Sessions |
| `UPLOAD_KEY_REQUIRED` | 401 | | Anonymous upload with no Turnstile token |
| `UPLOAD_KEY_INVALID` | 401 | | Bad, unknown, revoked or expired key |
| `UPLOAD_KEY_NOT_ALLOWED` | 403 | | A key on a non-upload endpoint |
| `UPLOAD_KEY_SCOPE` | 403 | `scope` | `album=` without `albums:append` |
| `UPLOAD_KEY_LIMIT` | 400 | `limit` | Create key |
| `UNKNOWN_UPLOAD_KEY` | 404 | | Key endpoints |
| `ACCOUNT_PENDING_DELETION` | 403 | `scheduled_for` | Every endpoint a locked account can't use, and its upload keys (§8.8) |
| `ACCOUNT_DELETE_NOT_ALLOWED` | 409 | `reason`: `staff`, `pending` | Delete account |
| `EXPORT_LIMIT` | 429 | `retry_after` | Exports |
| `EXPORT_NOT_READY` | 409 | | Export download |
| `UNKNOWN_EXPORT` | 404 | | Exports |
| `PREMIUM_REQUIRED` | 403 | | Domains, domain-only |
| `ENTITLEMENT_EXISTS` | 409 | | Admin grant |
| `UNKNOWN_ENTITLEMENT` | 404 | | Admin |
| `INVALID_HOSTNAME` | 400 | `reason`: `syntax`, `wildcard`, `ip`, `apex`, `public_suffix`, `reserved` | Add domain |
| `DOMAIN_TAKEN` | 409 | | Add domain |
| `DOMAIN_LIMIT_REACHED` | 400 | `limit` | Add domain |
| `DOMAIN_REQUIREMENTS` | 403 | `reason`, `available_at?` | Add or retry |
| `UNKNOWN_DOMAIN` | 404 | | Domain endpoints, key `domain_id`, owner pass `domain_id` |
| `DOMAIN_NOT_ACTIVE` | 409 | | Set default, owner pass on a domain |
| `DOMAIN_NOT_FAILED` | 409 | | Retry |
| `DOMAIN_DISABLED` | 409 | | Removing a staff-disabled domain |
| `DOMAIN_CHECK_RATE_LIMITED` | 429 | `retry_after` | Check now |
| `DOMAIN_ONLY_NOT_AVAILABLE` | 409 | | Turning domain-only on with no serving domain |
| `DOMAINS_UNAVAILABLE` | 503 | | Cloudflare unreachable, or the global cap |

A `401 UNAUTHORIZED` caused by a dead session cookie also clears the cookie. Messages are sentence case, as in `api/utils/errors.py`.

---

## 15. Config

**API** (environment, read through one `account_settings()` like `safety_settings()`):

| Variable | Default | Notes |
|---|---|---|
| `SESSION_COOKIE_INSECURE` | unset | `1` only with `FILESGG_DEV_TOOLS=1`: cookie name `filesgg_session`, no `Secure` (plain-http local stack). Production refuses to boot with it. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | (unset = Discord off) | Both or neither, else the API refuses to boot. `GET /auth/config` → `{ "discord": true \| false }` so the web app hides the buttons. |
| `DISCORD_REDIRECT_URI` | `PUBLIC_URL + "/app/auth/discord"` | Must match the Discord application exactly (§17) |
| `DISCORD_API_BASE` | `https://discord.com/api` | Tests point it at a mock |
| `CLOUDFLARE_API_TOKEN` | (unset = domains off) | Custom hostnames on the zone only (§17). Unset: `POST /users/@me/domains` is `503 DOMAINS_UNAVAILABLE`. |
| `CLOUDFLARE_ZONE_ID` | (required with the token) | The zone that holds `CUSTOM_DOMAIN_TARGET` and the fallback origin (the files.gg zone) |
| `CLOUDFLARE_API_BASE` | `https://api.cloudflare.com/client/v4` | Tests point it at a mock |
| `CUSTOM_DOMAIN_TARGET` | `domains.files.gg` | The CNAME customers set |
| `CUSTOM_DOMAINS_GLOBAL_MAX` | `1000` | |
| `API_PUBLIC_URL` | `https://api.files.gg` | The `.sxcu` `RequestURL` and curl snippet |
| `PREMIUM_CUSTOM_DOMAINS` | `5` | |
| `LIMIT_PREMIUM_STORAGE_BYTES` | `107374182400` (100 GB) | §9.2 |
| `LIMIT_PREMIUM_CHUNKED_BYTES` | `5368709120` (5 GB) | §9.2 |
| `LIMIT_PREMIUM_SINGLE_BYTES` | `524288000` (500 MB) | §9.2 |
| `PROXY_BODY_LIMIT_BYTES` | `100000000` | Cloudflare's per-request body limit for the zone's plan; caps single-request uploads (§9.5) |
| `REQUEST_MAX_SIZE` | `525336576` (501 MiB) | Sanic's outer cap, raised from 101 MiB (§9.5) |
| `AUTH_REQUEST_MAX_BYTES`, `JSON_REQUEST_MAX_BYTES` | `65536`, `1048576` | §4.8 |
| `SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS`, `SESSIONS_MAX`, `REAUTH_SECONDS` | `30`, `180`, `50`, `600` | |
| `ACCOUNT_DELETION_GRACE_DAYS` | `14` | §8.8 |
| `USERNAME_COOLDOWN_DAYS`, `USERNAME_HOLD_DAYS` | `30`, `30` | |
| `VERIFY_TOKEN_HOURS`, `RESET_TOKEN_MINUTES` | `24`, `60` | |
| `UPLOAD_KEYS_MAX`, `UPLOAD_KEY_RATE_PER_HOUR` | `20`, `600` | |
| ~~`AUTH_RATE_LIMITS`~~ | | Replaced by `RATE_LIMITS` in Milestone 5 ([`milestone-5.md`](milestone-5.md) §18.2, §18.3): the same values as limit text, such as `{"login_ip": "30 per hour"}` |
| `DOMAIN_PENDING_HOURS`, `DOMAIN_FAILING_DAYS`, `DOMAIN_PAUSED_DAYS`, `DOMAIN_MIN_ACCOUNT_AGE_DAYS` | `72`, `3`, `30`, `7` | |
| `EXPORT_KEEP_DAYS` | `7` | |

`SECRET_KEY` (already required) now also signs the OAuth `state` and the Discord sign-up token. `ABUSE_HASH_SECRET` (Milestone 4) also keys the email rate-limit hash. `docker-compose.yml` passes the Discord and Cloudflare variables to `api` and `worker` (the `domain_checker`, `domain_delete`, `account_export` and `account_deletion` work runs in `worker`); they're optional (`${VAR:-}`), so a stack without them runs with Discord and domains off.

**Other services:** `nginx/nginx.conf` `client_max_body_size` becomes `501M` (§9.5). The `worker`, `scanner` and `rescanner` temp volumes are sized for 5 GiB per concurrent job.

**Dependencies** (pinned exactly, per the version policy): `argon2-cffi` (already present; 25.1.0 is the current release), `idna`, and a Public Suffix List package with a bundled snapshot (for example `publicsuffixlist`), whose data is updated with regular dependency bumps. Werkzeug is removed from the API.

**Worker:** the var `SESSION_COOKIE_NAME` (§12); `CORS_ALLOWED_ORIGINS` is removed. No new secrets. **Web:** none; Discord availability comes from `GET /api/auth/config`, and `TURNSTILE_SITE_KEY` stays.

**Scheduled tasks** (`jobs/tasks.py`): `domain_checker` (1 min), `entitlements_expiry` (1 h), `account_deletion` (1 h, §8.8), `exports_cleanup` (1 h), `session_cleanup` (daily: sessions ended more than 30 days ago, used or expired `account_tokens` older than 7 days, `username_holds` past `held_until`). **Jobs:** `domain_delete`, `account_export`, and the existing upload-abort job for deleted accounts.

---

## 16. Test vectors

### 16.1 Token format (§7.1)

| Token | Valid | CRC32 (decimal) | SHA-256 of the token (hex, = `key_hash` / `token_hash`) |
|---|---|---|---|
| `fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V` | yes | 3255368311 | `6214c9dda64e05eeb00d08d2d805afba9cc3e4496945181440a4c604549bed26` |
| `fgg_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz43NeoO` | yes | 3714498764 | `fac1ad6d76e233aa550fb49b7916a7979bfb47775cada48216b9c97befade753` |
| `fgg_0000000000000000000000000000001BAc6F` | yes | 1081202267 | `0991eb42e152ae76c9283d40dae42b65d816321b158c9b8df0656c8d166b07d6` |
| `fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC` | yes (session) | 2933624500 | `e5dd67fb14922911fd8419b7eef0d4903813affe498ceefb52be75585a304b8e` |
| `fgs_Q7xK2mP9vL4nR8tW1yB5cD3fG6hJ0k2iu6sT` | yes (session) | 2495797257 | `a3835d501243667199c6f3a88379e225c2f421820be2180f80b9774527f0b296` |
| `fgg_0123456789ABCDEFGHIJabcdefghij3YJC0W` | **no**: checksum (last character changed) | | |
| `fgs_0123456789ABCDEFGHIJabcdefghij3YJC0V` | **no**: the `fgg_` checksum under the `fgs_` prefix | | |
| `fgg_0123456789ABCDEFGHIJabcdefghij3YJC0` | **no**: 39 characters | | |

Upload key `fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V` has `prefix` `fgg_01234567`.

### 16.2 PKCE (§5.2)

`code_verifier` `dBjftJeZ4CVP-mJ92IGzWRE3ZTJ0-YHlfYSV0xHrl4w` → `code_challenge` (`S256`) `SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8`.

### 16.3 Signed `state` and sign-up token (§5.4)

Secret `test-secret-key`.

| Claims (canonical JSON) | Label | Token |
|---|---|---|
| `{"c":"SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8","e":1795604200,"i":1795603600,"n":"n0nce-AbC123","p":"login","u":null}` | `filesgg-oauth-state-1` | `eyJjIjoiU2tyS2hRRmJNQlg1cHRZZXJLSkphakcyQ0lKLVhfMU8xSXlSR3pibk1aOCIsImUiOjE3OTU2MDQyMDAsImkiOjE3OTU2MDM2MDAsIm4iOiJuMG5jZS1BYkMxMjMiLCJwIjoibG9naW4iLCJ1IjpudWxsfQ.IhS_8MHN3GRuPXze_CmM976stCIR2ZaU3_35ENFnidw` |
| the same with `"p":"link","u":"1234567890123456789"` | `filesgg-oauth-state-1` | `eyJjIjoiU2tyS2hRRmJNQlg1cHRZZXJLSkphakcyQ0lKLVhfMU8xSXlSR3pibk1aOCIsImUiOjE3OTU2MDQyMDAsImkiOjE3OTU2MDM2MDAsIm4iOiJuMG5jZS1BYkMxMjMiLCJwIjoibGluayIsInUiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5In0.XQseFi7qgojAlK9eM0H2Xq0NgIJl-cTGsQKB6lXSiT0` |
| `{"a":"a_1b2c3d4e5f","d":"80351110224678912","e":1795604500,"g":"Dan W","m":"dan@example.com","mv":true,"n":"dan.w"}` | `filesgg-discord-signup-1` | `eyJhIjoiYV8xYjJjM2Q0ZTVmIiwiZCI6IjgwMzUxMTEwMjI0Njc4OTEyIiwiZSI6MTc5NTYwNDUwMCwiZyI6IkRhbiBXIiwibSI6ImRhbkBleGFtcGxlLmNvbSIsIm12Ijp0cnVlLCJuIjoiZGFuLncifQ.dTHKYhVaOnp_pzHdX018IqrZTCEuvdOBmNe41i_3cLc` |

Must be **rejected:**
- the first state's body with signature `cov0bNlk7-TsdIbPPPwY4hxHTGXu5GRkTtl4gPue1eE` (signed with `other-secret`);
- the first state checked at now = `1795604200` or later (`e` passed);
- the second state on a callback whose session user isn't `1234567890123456789`;
- the first state with any `code_verifier` other than the one in §16.2;
- the sign-up token presented as a `state` (wrong label).

### 16.4 Email rate-limit key (§4.7)

Secret `test-abuse-hash-secret`: `dan@example.com` and ` Dan@Example.COM ` both give `acct:a07a8820617033640ae9c815843de5b1524db5c58dabae4d6b875eed027fc576`.

### 16.5 Rehosting (§10.9), host `i.example.com`

| Input | Output |
|---|---|
| `https://cdn.files.gg/files/abc123.png` | `https://i.example.com/files/abc123.png` |
| `https://cdn.files.gg/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8` | `https://i.example.com/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8` (milestone-3's first vector; **accepted** on both hosts) |
| `https://cdn.files.gg/previews/thumb/abc123.webp?v=5` | `https://i.example.com/previews/thumb/abc123.webp?v=5` |
| `https://files.gg/abc123` | `https://i.example.com/abc123` |
| `https://files.gg/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet` | `https://i.example.com/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet` |
| `https://cdn.discordapp.com/avatars/1/a.png` | unchanged |
| `https://cdn.files.gg.evil.example/files/x.png` | unchanged (origin compared exactly) |
| `https://cdn.files.gg/files/abc123.png?staff=555555555555555555&expires=1795603600&sig=xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk` | rehosted, but **rejected** on `i.example.com` (staff URLs work only on `cdn.files.gg`) |

### 16.6 Usernames (§2.2)

| Input | Result |
|---|---|
| `Dan.W` | `dan.w` |
| `d` | `length` |
| `abcdefghijabcdefghijabcdefghijabc` (33) | `length` |
| `dan-w` | `characters` |
| `.dan`, `dan.`, `da..n` | `dots` |
| `12345` | `numeric` |
| `u12345` | `reserved` |
| `admin`, `Files.GG`, `filesgg_dan` | `reserved` |
| `deleted-123` | `characters` (the `deleted-<id>` form is only written by account deletion) |
| `_x` | valid |

### 16.7 Passwords (§2.6, §4.8), username `dan.w`, email `dan@example.com`

| Password | Result |
|---|---|
| `seven77` (7 characters) | `INVALID_PASSWORD { reason: "too_short" }` |
| `eight888` (8 characters) | valid |
| 1,000 characters | valid (no maximum) |
| 60,000 characters (the request body stays under 64 KiB) | valid |
| a request body over 65,536 bytes | `413 REQUEST_TOO_LARGE { limit: 65536 }`, nothing hashed |
| `Dan.W` (the username, case-insensitive) | `INVALID_PASSWORD { reason: "matches_username" }` (it's also too short) |
| `DAN@example.com` | `INVALID_PASSWORD { reason: "matches_email" }` |

### 16.8 Hostnames (§10.1)

| Input | Result |
|---|---|
| `I.Example.COM.` | `i.example.com` |
| `bücher.example.com` | `xn--bcher-kva.example.com` |
| `example.com` | `apex` |
| `i.example.co.uk` | valid |
| `example.co.uk` | `apex` |
| `co.uk` | `public_suffix` |
| `*.example.com` | `wildcard` |
| `192.0.2.1` | `ip` |
| `x.files.gg`, `files.gg`, `domains.files.gg` | `reserved` |
| `-bad.example.com` | `syntax` |

### 16.9 Domain status (§10.3)

| Was | TXT | CNAME | Cloudflare `status` / `ssl.status` | Becomes |
|---|---|---|---|---|
| `pending_dns` | no | yes | `pending` / `initializing` | `pending_dns` |
| `pending_dns` | yes | yes | `active` / `pending_validation` | `pending_cert` |
| `pending_cert` | yes | yes | `active` / `active` | `active` (sets `verified_at`) |
| `active` | no | yes | `active` / `active` | `failing` (sets `failing_since`; still served) |
| `failing` for 3 days | no | no | `moved` / `active` | `failed`, Cloudflare hostname deleted |
| `pending_dns` for 72 h | no | no | `pending` / `initializing` | `failed` (`dns_timeout`), Cloudflare hostname deleted |
| `active`, owner loses premium | | | | `paused` |

### 16.10 Serving matrix (§8.8, §10.6, §10.8)

Owner U has domain `i.example.com` (`scope: own`, active). V is another user.

| File | U's state | `files.gg/<v>` | `cdn.files.gg/files/<v>.png` | `i.example.com/<v>` | `i.example.com/files/<v>.png` |
|---|---|---|---|---|---|
| U's `link` | domain-only off | `file` 200 | 200 | `file` 200 | 200 |
| U's `link` | domain-only on (effective) | `missing` 404 | 404 unsigned; 200 with a valid file-grant signature | `file` 200 | 200 |
| U's `link` | domain-only on, but paused | `file` 200 | 200 | `file` 200 | 200 |
| U's `password` | domain-only on | `missing` 404 | 401 unsigned; 200 signed | `locked` 200 | 401 unsigned; 200 signed |
| U's `private` | any | `missing` 404 | 404 unsigned | `missing` 404 (`#t=` opens it for U) | 404 unsigned |
| U's `link` | **pending deletion** | `missing` 404 | 404, even signed; 200 only with a staff grant | the "isn't connected" page, 404 | 404 |
| V's `link` | — | `file` 200 | 200 | `missing` 404 (scope `own`); `file` 200 with scope `any` | 404 / 200 likewise |
| anonymous `link` | — | `file` 200 | 200 | `missing` 404 with `own`; `file` 200 with `any` | 404 / 200 likewise |

### 16.11 Cookies and CSRF (§3, §12)

**Cookie headers** (token `fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC`, a sign-in at `1795603600` with `max_expires_at` `1811155600`):

```
Set-Cookie: __Host-filesgg_session=fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000
Set-Cookie: __Host-filesgg_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0
```

**Worker forwarding:**

| Request | `Cookie` sent upstream | `Set-Cookie` returned to the browser |
|---|---|---|
| `https://files.gg/api/users/@me` with `Cookie: __Host-filesgg_session=fgs_…; __cf_bm=x` | `__Host-filesgg_session=fgs_…` only, plus `X-Filesgg-Via: main` | the session cookie only |
| `https://api.files.gg/users/@me` with the same `Cookie` | none (no `X-Filesgg-Via`) | none |
| `https://files.gg/abc123` (a page) | none (no upstream request carries it) | none |
| `https://cdn.files.gg/files/abc123.png` | none | none |
| `https://i.example.com/abc123` | none | none |
| any request with a client-sent `X-Filesgg-Via: main` to `api.files.gg` | the header is stripped; the API ignores any cookie | none |

**API decision** (request forwarded from `files.gg/api`, valid session cookie):

| Method and path | `X-Filesgg-Csrf` | `Origin` | `Sec-Fetch-Site` | Result |
|---|---|---|---|---|
| `GET /users/@me` | absent | absent | `same-origin` | 200 |
| `PATCH /users/@me` | `1` | `https://files.gg` | `same-origin` | 200 |
| `PATCH /users/@me` | absent | `https://files.gg` | `same-origin` | `403 CSRF` |
| `PATCH /users/@me` | `1` | `https://evil.example` | `cross-site` | `403 CSRF` |
| `POST /users/@me/albums` | `1` | `null` | `same-site` | `403 CSRF` (a sandboxed `cdn.files.gg` document) |
| `DELETE /users/@me/files/1` | `1` | absent | absent | 200 (older clients without the headers; the custom header still proves same-origin) |
| `POST /auth/login` (no cookie) | absent | `https://files.gg` | `same-origin` | `403 CSRF` |
| `POST /files` with `Authorization: Key fgg_…` and no cookie | absent | absent | absent | authenticated by the key; no CSRF check |
| any request with `Authorization: Bearer <anything>` | | | | `401 UNAUTHORIZED` (never a session) |

---

## 17. Ops checklist (not code)

**Discord application**
- [ ] Create the application in the Discord Developer Portal, named "files.gg", with the logo, and the Terms and Privacy URLs.
- [ ] OAuth2 → Redirects: `https://files.gg/app/auth/discord`, the staging origin's, and the local stack's (`http://files.localhost:<port>/app/auth/discord`). They must match `DISCORD_REDIRECT_URI` exactly.
- [ ] Keep it a confidential client (Public Client off). No bot user, no bot permissions.
- [ ] Copy the client id and secret into `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`. Store the secret only in the deployment's secrets.
- [ ] Test sign-up, sign-in, link, unlink and re-auth on staging, including a Discord account with an unverified email and one with no email.

**Cloudflare for SaaS** (developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/)
- [ ] Enable Cloudflare for SaaS on the `files.gg` zone. Free, Pro and Business include 100 custom hostnames; then $0.10 each, up to 50,000. Set a billing notification.
- [ ] **Fallback origin:** create `fallback.files.gg AAAA 100::`, **proxied** (an originless record, since the Worker answers everything; Cloudflare's "Workers as your fallback origin" setup). Set it as the fallback origin (dashboard, or `PUT /zones/{zone_id}/custom_hostnames/fallback_origin { "origin": "fallback.files.gg" }`) and wait for `active`.
- [ ] **CNAME target:** create `domains.files.gg CNAME fallback.files.gg`, proxied. This is `CUSTOM_DOMAIN_TARGET`.
- [ ] **Worker route:** add `*/*` on the zone for the `files-gg` Worker (`wrangler.toml`), keeping the existing routes (more specific routes win). Confirm that no other hostname on the zone (for example mail or status subdomains) relies on another origin; give those a route with no Worker.
- [ ] **API token:** a token with the zone permission "SSL and Certificates: Edit" (API: "SSL and Certificates Write") on the `files.gg` zone only. Put it in `CLOUDFLARE_API_TOKEN`, and the zone id in `CLOUDFLARE_ZONE_ID`.
- [ ] On staging, add a real test subdomain on a domain we control and confirm: real-time validation through the CNAME, HTTP DCV issuing the certificate with the Worker on `*/*` (the `/.well-known/` paths, §10.8), the status mapping, Check now, and deletion.
- [ ] Decide later whether root domains are worth Enterprise apex proxying (PLAN.md §4 item 18).

**Premium limits** (§9.5)
- [ ] **Decide how 500 MB single-request uploads get through Cloudflare** (an Enterprise zone, or accept the ~100 MB cap for ShareX and curl), then set `PROXY_BODY_LIMIT_BYTES` to match the zone.
- [ ] Raise nginx `client_max_body_size` to `501M` and the API's `REQUEST_MAX_SIZE` to 501 MiB.
- [ ] Size the `worker`, `scanner` and `rescanner` temp disks for 5 GiB per concurrent job.
- [ ] On staging, upload a 5 GB file in chunks and confirm finalize's multipart copy on B2, scanning (`too_large_to_scan` for non-media), probing, and serving with `Range`.
- [ ] Re-check B2 egress for finalize read-backs and for files over Cloudflare's 512 MB cache limit.

**Sessions**
- [ ] Confirm on staging that `__Host-filesgg_session` is set only for `files.gg` and never sent to `cdn.files.gg`, `api.files.gg` or a custom domain, and that a page on `cdn.files.gg` can't set or overwrite it (the Phase 5 `__Host-` check, now covering the real session cookie).
- [ ] Remove `CORS_ALLOWED_ORIGINS` from the Worker's deployed vars.

**Turnstile**
- [ ] The existing widget's hostname list stays `files.gg` (plus staging and local). Custom domains need nothing there (§10.10). Confirm the challenge frame works inside a cross-origin iframe on staging.

**Email (Postmark)**
- [ ] Send each new template (§2.7) to Gmail, Outlook and iCloud on staging.

**Legal and policy**
- [ ] **Privacy policy:**
  - the **session cookie** `__Host-filesgg_session`: strictly necessary for signing in, so no consent banner is needed, but it's listed with its purpose and lifetime (up to 180 days);
  - the Discord data stored (id, username, display name and avatar hash, and the email when used);
  - session metadata (browser, OS, country; no IPs);
  - the email-hash rate limits;
  - data export, and the 14-day deletion grace period and what's kept afterwards (§8.8);
  - custom domains' DNS checks.
- [ ] **Terms:** custom domains (the customer is responsible for the domain and what it shows; files.gg can disable it), upload keys (keep them secret), account deletion (the grace period, and what's kept, §8.8), premium (granted by staff, can be revoked).
- [ ] How staff handle erasure requests from suspended accounts, and law-enforcement holds (Milestone 4's evidence rules).

**Later**
- [ ] Enrol the `fgg_` and `fgs_` formats in GitHub's secret scanning partner program (email `secret-scanning@github.com`; provide the regex in §7.1 and an endpoint that revokes reported tokens).
- [ ] Grant premium to the first accounts with `python -m tools.entitlements`.

---

## 18. Sources, and what's still unverified

**Checked on 2026-11-25:**

| Topic | Source |
|---|---|
| Discord OAuth2: URLs, token request format, client authentication, revocation, `state`, `prompt`, scopes | https://docs.discord.com/developers/topics/oauth2 (moved from discord.com/developers/docs/topics/oauth2) |
| Discord PKCE (`S256`) and auth methods | https://discord.com/.well-known/oauth-authorization-server |
| Discord user object and `/users/@me` | https://docs.discord.com/developers/resources/user |
| Discord API versions and avatar URLs | https://docs.discord.com/developers/reference |
| Discord rate limits | https://docs.discord.com/developers/topics/rate-limits |
| Cloudflare custom hostnames API (endpoints, request fields, `status` and `ssl.status` values) | https://developers.cloudflare.com/api/resources/custom_hostnames/ and its `methods/create/`, `methods/edit/` and `subresources/fallback_origin/methods/update/` pages |
| Getting started, fallback origin, the zone-name restriction | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/ |
| Hostname validation, real-time validation, backoff schedule, status meanings | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/ (and `realtime-validation/`, `backoff-schedule/`, `validation-status/`) |
| HTTP and TXT DCV | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/ (and `http/`, `txt/`) |
| Certificate-only webhooks | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/webhook-definitions/ |
| Pricing and plan limits | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/ |
| Apex proxying (Enterprise add-on) | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/ |
| Worker as the fallback origin, `*/*` route | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/ |
| API token permission names | https://developers.cloudflare.com/fundamentals/api/reference/permissions/ |
| Workers request body limits per plan (100 MB Free and Pro, 200 MB Business, up to 5 GB Enterprise) | https://developers.cloudflare.com/workers/platform/limits/ |
| Cache object size limits (512 MB below Enterprise, 5 GB Enterprise) | https://developers.cloudflare.com/cache/concepts/default-cache-behavior/ |
| Turnstile server-side validation (300 s, single use, fields) | https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ |
| Turnstile hostname limits (10 free, 200 Enterprise, no wildcards) | https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/ |
| ShareX custom uploader fields and syntax | https://getsharex.com/docs/custom-uploader |
| ShareX versions (14.0 syntax change, 17.0 old-format removal, 22.4.0 current) | https://getsharex.com/changelog |
| argon2-cffi defaults and profiles (25.1.0) | https://argon2-cffi.readthedocs.io/en/stable/api.html and https://pypi.org/project/argon2-cffi/ |
| RFC 9106 recommended parameters | https://www.rfc-editor.org/rfc/rfc9106.html |
| OWASP argon2id minimums | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html |
| Token prefixes and checksums | https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/ and https://docs.github.com/en/code-security/secret-scanning/secret-scanning-partnership-program/secret-scanning-partner-program |

**Still unverified (check while building):**
1. **Discord PKCE parameters:** S256 support comes from Discord's authorization-server metadata; the prose docs don't name `code_challenge` and `code_challenge_method`, and don't say explicitly that a confidential client may send `code_verifier` together with its secret. Test on staging; if Discord rejects the combination, drop to `state` plus the client secret (the browser binding in §5.2 still holds through `state`).
2. **Discord `prompt=none`:** the docs say it skips the screen for an app already authorized; what Discord returns when it can't skip isn't documented. §5.2 step 6 retries without it.
3. **Discord `redirect_uri` matching rules** (trailing slash, query) aren't documented; use the exact registered string.
4. **Cloudflare's handling of `/.well-known/` validation paths** when a Worker runs on `*/*` with an originless fallback: §10.8 passes them through, but whether Cloudflare's edge answers HTTP DCV before the Worker must be confirmed on staging.
5. **The meanings** of Cloudflare's `test_*`, `pending_*` and `provisioned` hostname statuses aren't documented; §10.3 treats them conservatively.
6. **"Per month":** the plans page says $0.10 per extra hostname but not per month.
7. **CNAME flattening or ALIAS records** at a customer's apex aren't documented as supported or unsupported without apex proxying; this contract refuses apex domains anyway.
8. **Turnstile inside a cross-origin iframe** (§10.10): not explicitly documented either way.
9. **ShareX's `Version` field:** whether a value older than the running app matters isn't stated; `17.0.0` is the documentation's own example. Whether a `TextUploader` with `MultipartFormData` sends text as a file part under `FileFormName` should be confirmed with the current ShareX.
10. **Which CA** Cloudflare uses for a given custom hostname (for the CAA hint) isn't selectable below Enterprise and wasn't checked.
11. **Cloudflare's "100 MB" body limit unit** (10⁸ bytes or 100 MiB) isn't stated; `PROXY_BODY_LIMIT_BYTES` defaults to the smaller reading.
    **Update (Milestone 5, owner 2026-11-25):** sizes are now decimal everywhere (1 MB = 1,000,000 bytes), the single-request limit is exactly **100 MB (100,000,000 bytes)** for everyone, and `PROXY_BODY_LIMIT_BYTES` defaults to **104,857,600** (100 MiB, assuming Cloudflare's limit is binary). Confirm it on the real zone before launch (PLAN.md "Before the first deploy"); if Cloudflare turns out to mean 10⁸ bytes, set `PROXY_BODY_LIMIT_BYTES=100000000` and the cap drops to 98.95 MB.
12. **B2's `UploadPartCopy`** for the 5 GB finalize copy should be confirmed on staging (§9.5).
13. **Secure cookies on `http://*.localhost`:** browsers differ, which is why the local stack uses `SESSION_COOKIE_INSECURE` (§3.2).

---

## 19. View limits (added 2026-11-25, owner decisions)

A file can stop being viewable after **N unique viewers** ("burn after N views"). Built as a follow-up inside Milestone 6, after §1–§18.

### 19.1 Decisions (owner, 2026-11-25)

- **What counts:** **unique viewers**. A viewer is the abuse IP hash (milestone-4 §1: HMAC with `ABUSE_HASH_SECRET`, IPv6 grouped by /64), so refreshing, reopening or coming back another day never uses a second view. **The owner and staff never count.**
- **Link-preview bots never embed a view-limited file,** and never use up a view. They get an error, not an embed (§19.5).
- **At the limit,** the owner picks the action: **`expire`** (the default) or **`private`**.
- **Who:** everyone, anonymous uploads included. The limit is **1 to 1,000**.

### 19.2 Schema (`0006_view_limits.sql`)

| Column or table | Notes |
|---|---|
| `files.view_limit integer NULL` | `CHECK (view_limit BETWEEN 1 AND 1000)`. `NULL` means no limit. |
| `files.view_limit_action text NOT NULL DEFAULT 'expire'` | `CHECK (view_limit_action IN ('expire', 'private'))` |
| `files.views_used integer NOT NULL DEFAULT 0` | `CHECK (views_used >= 0)` |
| `file_limit_viewers (file_id bigint, viewer bytea, first_viewed_at timestamptz)` | Primary key `(file_id, viewer)`, `ON DELETE CASCADE` from `files`. `viewer` is the abuse IP hash. |

`views_used` only ever equals the number of `file_limit_viewers` rows, and both change in the same transaction.

### 19.3 Setting it

- **On upload:** `POST /files` and `POST /uploads` accept `view_limit` (1–1000) and `view_limit_action` (`expire` | `private`). An anonymous upload can't choose `private`, since it has no owner library; it gives `400 PRIVATE_REQUIRES_ACCOUNT`.
- **Later:** the owner can set, raise, lower or remove it with `PATCH /users/@me/files/<id>` (`view_limit`, or `null` to remove, and `view_limit_action`).
  - A new limit must be greater than `views_used`; otherwise `400 VIEW_LIMIT_TOO_LOW { views_used }`.
  - Changing the limit never resets `views_used`.
  - If a `private` action already fired, the owner can raise the limit **and** change visibility back.
- **Anonymous uploaders** can set it only at upload, like expiry.

### 19.4 How a view is counted (`POST /files/<vanity>/open`)

A view-limited file is **served like a protected file** (milestone-3 §3): its CDN bytes need a signed URL, so a raw CDN link can never be used to view it uncounted. The payload from public lookups carries no usable byte URLs.

```
POST /files/<vanity>/open    { "turnstile_token": "…" }   → 200 { "file": {…payload with signed URLs…}, "expires_at": <s> }
```

- **Turnstile (action `view`)** is required, the same as unlock, so scripts can't burn views from many addresses.
- **The order of checks:** Turnstile, then the rate limit (as unlock), then the file's own access (a password file still needs its unlock; see below), then counting.
- **Counting:** in one transaction, insert `(file_id, viewer)` if it's new.
  - On insert, `views_used += 1`.
  - If that makes `views_used == view_limit`, **this viewer is the last one**: they get the file, and the action fires right after their response is built:
    - `expire` sets `expires_at = now()`;
    - `private` sets `visibility = 'private'` and bumps `access_version`, which revokes every signed URL already given out.
  - A viewer already in the table reopens without counting, until the action fires.
- **Signed URLs** from `/open` expire after **1 hour**, or the file's expiry, whichever is earlier. The viewer refreshes by calling `/open` again: the same viewer never counts twice.
- **Owner and staff:** a request with the owner's session (`files.gg/api`) or a staff session is served without counting.
- **Password files with a view limit:** a successful **unlock** counts as the view (same rules). `/open` on a password file without a valid unlock token answers `401 UNLOCK_REQUIRED`.
- **Private files** can have a limit, but only the owner can open them, so it never counts. That's allowed, not refused.
- **After the action:**
  - `expire`: the file is expired and missing everywhere (milestone-2 §9).
  - `private`: the file is missing to everyone but the owner.
  
  Either way, the next viewer gets the normal missing state. It's never described as "view limit reached", so it doesn't tell anyone the file existed.

### 19.5 Worker and link-preview bots

- **The internal file lookup adds** `view_limit: { "limit": int, "used": int, "action": "expire"|"private" }`, or `null`. While a limit is set, the Worker treats the file as protected:
  - the shell is a new `data-state="limited"` with `{ "vanity", "view_limited": true, "views_remaining": int }` and no media;
  - the og tags are generic ("View-limited file · files.gg"), with **no image, video or audio**;
  - **no bot or `Accept: image/*` redirect** to the CDN, ever;
  - the CDN needs a valid signed URL, the same as password files.
- **Link-preview bots** (the existing bot user-agent list plus `Accept: image/*` requests) asking for a view-limited file's page get **`403`** with a tiny text body ("This file has a view limit and can't be previewed."), `Cache-Control: private, no-store`, and no og media. They never reach `/open`, so they never use up a view. Direct CDN requests from bots are refused like any unsigned request.

### 19.6 Payloads

- **The public file payload** (from `/open` and unlock) adds `view_limit: { "remaining": int }`, or omits it when there's no limit.
- **The owner payload** adds `view_limit`, `view_limit_action` and `views_used`.
- **Albums:** a view-limited file isn't shown in album pages or the album ZIP, because opening an album can't count each item. The owner's editor shows it as hidden, with the note "View-limited files aren't shown in albums."

### 19.7 Web

- **Upload options:**
  - a "View limit" control (off, or 1–1000) next to expiry, for signed-in and anonymous uploads;
  - "When the limit is reached": "Expire the file" (default) or "Make it private" (signed in only).
- **Dashboard:**
  - the limit, "N of M views used", and edit or remove (with the `VIEW_LIMIT_TOO_LOW` message);
  - a file whose `private` action fired shows as private, with a hint to raise the limit.
- **Viewer:**
  - the `limited` state shows a card: "This file has a view limit. Opening it uses one of its N remaining views." with **Open file** (runs Turnstile, then `/open`), then renders the file normally;
  - a password file with a limit shows the lock screen with a line saying unlocking uses a view;
  - after opening, the footer shows "N views left";
  - **custom domains:** the same flow, using the challenge frame (§10.10) for Turnstile.

### 19.7a As built (2026-11-25)

- **`expire` keeps the file live for the last viewer for up to 1 hour:** `expires_at = least(expires_at, now() + 1 h)` and `access_version` is bumped. Everyone else gets missing straight away, because the API refuses once `views_used >= view_limit` and the Worker treats `used >= limit` as missing. The last viewer's URLs are signed with the new `access_version`.
- **The action fires inside the counting transaction,** with the file row locked.
- **`/access/view`, refresh, and `GET /files/<vanity>` with a token also count** for view-limited files, so a shared unlock token can't bypass the limit. Owner passes never count.
- **`GET /files/<vanity>` for a view-limited file returns the stub** `{vanity, view_limited: true, views_remaining}` (a password file returns the locked payload plus those fields).
- **Album editor items** carry `hidden_reason: "view_limit"` with `shown: false`.
- **The Worker's lookup cache key is `v7`.**
- **Open** shares the `unlock` rate limit (5 a minute per file and IP).
- **Link-preview bots** that get the 403 are matched by user agent: `/bot|sharex/i` plus a list of preview fetchers without "bot" in their name (`facebookexternalhit`, `Facebot`, `WhatsApp`, `Slack-ImgProxy`, `SkypeUriPreview`, `Embedly`, `Iframely`, `vkShare`, `Mastodon`, `Bluesky Cardyb`, `Google-InspectionTool`), and `Accept` containing `image/*`.

### 19.8 Error codes

| Code | HTTP | Details |
|---|---|---|
| `VIEW_LIMIT_TOO_LOW` | 400 | `views_used` |
| `UNLOCK_REQUIRED` | 401 | `/open` on a password file without a valid unlock token |
| `CAPTCHA_INVALID` | 403 | Also: `/open` without a valid Turnstile token (action `view`) |

### 19.9 Tests

- 3 different viewers on a limit of 3 means the third viewer still gets the file, and a fourth gets missing.
- One viewer opening 5 times uses 1 view.
- The owner and staff never count.
- The `expire` action expires the file.
- The `private` action hides it from everyone but the owner, and revokes URLs already given out (`access_version`).
- Lowering the limit below `views_used` is refused.
- Unlock counts on password files.
- Bots get 403, never the CDN.
- An unsigned CDN request is refused.
- View-limited files are absent from album pages and the ZIP.
- An anonymous upload can't choose `private`.
- Turnstile is required.

---

## 20. The vanity is always the last path segment (owner, 2026-11-25)

**Rule:** no route puts anything after a vanity. Random vanities, and multi-segment ones such as `abcd/xyz`, could otherwise be read as a fixed word. Fixed words come first, then the kind, then the vanity, as the CDN paths already do (milestone-3 §3). This section supersedes every route below in milestone-2, milestone-3, milestone-4 and this contract.

### 20.1 API (`api.files.gg`, and `files.gg/api/...` through the Worker)

| Before | After |
|---|---|
| `POST /files/<vanity>/unlock` | `POST /access/unlock/files/<vanity>` |
| `POST /files/<vanity>/unlock/refresh` | `POST /access/refresh/files/<vanity>` |
| `GET /files/<vanity>/view` | `GET /access/view/files/<vanity>` |
| `POST /files/<vanity>/open` (§19) | `POST /access/open/files/<vanity>` |
| `POST /albums/<vanity>/unlock` | `POST /access/unlock/albums/<vanity>` |
| `POST /albums/<vanity>/unlock/refresh` | `POST /access/refresh/albums/<vanity>` |
| `GET /albums/<vanity>/view` | `GET /access/view/albums/<vanity>` |

- **Unchanged:** `GET /files/<vanity>` and `GET /albums/<vanity>` (the vanity is already last), the internal lookups (`/internal/files/<vanity>`, `/internal/albums/<vanity>`, `/internal/domains/<host>`), and every owner endpoint that uses ids (`/users/@me/...`).
- **No old paths:** with no backward compatibility, the old ones are simply gone and give 404.
- **`access`** becomes a reserved top-level API path segment.

### 20.2 Pages (`files.gg` and custom domains)

| Before | After |
|---|---|
| `files.gg/<vanity>/report` | `files.gg/report/<vanity>` |
| `files.gg/a/<vanity>/report` | `files.gg/report/a/<vanity>` |
| `files.gg/a/<vanity>/<n>` (album item) | `files.gg/a/<vanity>?item=<n>` |
| `files.gg/report?url=…` | unchanged |

- **`?item=`** keeps `#pw=` and `#t=` fragments working alongside it (`files.gg/a/<vanity>?item=3#pw=…`).
- **The Worker** serves the same album shell for any `?item`. The viewer reads it. **Opening** the lightbox adds one history entry (`pushState`), so the browser's Back button closes it; moving between items replaces that entry; closing goes back to it (owner, 2026-11-25).
- **Custom domains** use the same shapes (`<host>/report/<vanity>`, `<host>/a/<vanity>?item=3`).
- **Reserved first segments:** `report` and `a` stay reserved as a vanity's first segment, because `files.gg/<vanity>` shares the top-level namespace. Nothing is needed **after** a vanity any more, so the trailing-word reservations (`view`, `unlock` as later segments) are no longer needed for routing. They stay reserved, harmlessly, as defence in depth.

### 20.3 Tests

- **Each new route works,** and **each old one gives 404.**
- **A multi-segment vanity whose segments are words** (`unlock/view`, `report/x`) never matches an action route, and resolves only through `GET /files/<vanity>`.
- **`?item=`** round-trips in the lightbox.
- **Report pages** open for file and album vanities at the new paths, on `files.gg` and on custom domains.
