---
updated: 2026-11-25
---

# Privacy Policy

This policy explains what files.gg collects about you, why, who else receives it, how long we keep it, and the choices and rights you have. It covers files.gg, cdn.files.gg, api.files.gg, custom domains that serve files.gg files, and the tools that upload to it.

The short version: we keep what we need to store and share your files, keep files.gg safe, and meet our legal duties. We don't sell your data, show ads, or use tracking or analytics cookies.

<!-- Every number below comes from the code or its configured default; the setting or constant is named in a comment next to it. -->

## 1. Who's responsible

[OPERATOR], [OPERATOR ADDRESS], is responsible for your personal data on files.gg (the "controller" under data protection law).

For anything about your privacy or this policy, contact [PRIVACY CONTACT].

EU and UK representative: [EU/UK REPRESENTATIVE, if needed].

## 2. What we collect and why

### Your account

If you create an account, we keep:

- your **email address**, whether it's verified, and a new address while you're confirming a change;
- your **username** and, if you set one, your **display name**;
- your **password**, only as a one-way hash (argon2id), never the password itself;
- if you link **Discord**: your Discord user id, username, display name and avatar id, and, if you sign up with Discord and it shares a verified email address, that address. We use Discord only to sign you in: we revoke Discord's access as soon as we've read your profile, and we never store your Discord tokens;
- your **settings** (for example whether your name shows on your albums), your **upload keys** (their names, scopes and when they were last used; the keys themselves only as hashes), your **custom domains** and their DNS checks, whether you have **premium**, and when you created your account.

We use this to run your account, sign you in, send you account emails, and keep your account secure.

### Your files and albums

To store and share your files, we keep the files themselves and information about them: the file name, size and type; when it was uploaded and when it expires; who can open it (link, password or private; passwords only as one-way hashes); view counts and view limits; and fingerprints of the content (cryptographic hashes, and perceptual hashes of images).

From the content we also make:

- **previews** (thumbnails, posters, waveforms, PDF previews of Office documents) and **media details** (dimensions, duration, and tags such as an audio file's artist and album);
- **scan results** (section 6 of our [Terms](/legal/terms#scanning) explains the scanning): whether the file passed, its adult-content score, and any warnings.

Albums keep their title, description, captions, layout and order.

**Photos keep their metadata** (EXIF) when you upload them, which can include where a photo was taken and the device that took it. Anyone who can open the file can read it. Converting an image removes its metadata unless you turn that option off, and the **Remove photo location data** preset does only that: share the new file instead of the original.

**We can read your files.** Passwords, private files and view limits decide who can open a file. They don't encrypt it from us: we scan every file, including private and password-protected ones, and our staff can open files when they handle reports, appeals and other moderation work. Every time staff open a file is recorded.

### Anonymous uploads

When you upload, convert or report without an account, files.gg gives your browser a random identifier (your **guest id**), signed by files.gg, and your browser stores it. It's only a random number we picked: it isn't device fingerprinting, and it isn't made from anything about your browser or device. It's sent with your requests while you're signed out, and it's how files.gg knows which anonymous uploads, albums, conversions and reports are yours. When you sign in or create an account, your anonymous files and albums move into your account and the guest id is deleted from your browser.

### IP addresses

Every request reaches files.gg through Cloudflare, which sees your IP address (section 4). In our own database, we don't keep IP addresses in readable form. Instead:

- **Keyed hashes for abuse limits.** For uploads, reports, anonymous conversions and bans, we keep a keyed hash of your IP address (IPv6 addresses are grouped by their /64 network). It lets us count, limit and ban without storing the address itself. Uploads, reports and conversions keep it for 30 days<!-- ABUSE_IP_KEEP_DAYS = 30, api/safety/settings.py; cleared by the daily safety_retention task, api/safety/tasks.py -->; a ban keeps it while the ban lasts. For a file with a view limit, the same hash of each viewer is kept with the file, so a viewer is counted once, until the file is deleted.
- **Daily hashes for view counts and anonymous upload limits.** To count unique views, and to apply the anonymous upload limit, we use hashes made with a key that changes every day and is never stored, so after that day they can't be linked to an IP address. We delete them after 2 days<!-- VIEW_SEEN_KEEP_DAYS = 2 and UPLOADER_IP_KEEP_SECONDS = 2 days, api/jobs/tasks.py -->.
- **The uploader's IP address, sealed.** For each upload, we also keep the uploader's IP address encrypted to a key that's kept offline, never on our servers. It's opened only when we must report child sexual abuse material to the authorities, or to answer a valid legal request. We delete it after 30 days<!-- ABUSE_IP_KEEP_DAYS = 30 (files.uploader_ip_sealed), api/safety/settings.py and api/safety/tasks.py -->.

### Your country

Cloudflare works out which country you're connecting from, from your IP address. files.gg uses it to apply the regional rules in our [Terms](/legal/terms): the minimum age, and whether adult content is available where you are. We don't store it for this.

### Sign-in sessions

When you sign in, we keep a session: how you signed in, when, when it was last used, your browser's user agent (as your browser sends it, up to 256 characters), and the country Cloudflare reports for your connection at sign-in and at last use. We don't keep IP addresses with sessions. You can see and end your sessions in **Settings**.

### Reports, notices and moderation

When you send a report, we keep its reason, your details, what it's about and its message thread with staff, plus your account, or for anonymous reports your guest id, the keyed hash of your IP address, and the contact email you chose to give us. A copyright notice also holds the contact details and signature the law requires. We never show the person you reported who reported them.

When we act on content or an account, we keep a record of what we did and why (the audit log), and the notices, strikes and appeals that go with it. These records are how we apply our rules consistently, handle appeals, and answer legal requests.

If you appeal a copyright notice with a counter-notice, we send your counter-notice, including your name and contact details, to the person who sent the notice, as US copyright law requires.

### Conversions

When you convert a file, we keep a record of it: the source, the target format and options, the sizes before and after, the processing time it used, and whether it worked. For anonymous conversions this includes your guest id and the keyed hash of your IP address. We also count each day's conversions and processing time per account, guest id and IP hash, to apply the daily limits, and delete those counts after 2 days<!-- conversion_usage rows older than 2 days, contract milestone-5 §2.5 -->. Your conversion history is kept [CONVERSION HISTORY RETENTION].

### Emails

We send emails only about your account and your reports: verifying your address, resetting your password, security alerts (a changed password or email, a linked Discord account), account deletion, custom domain status, premium changes, and, if you gave a contact address with an anonymous report, its outcome. We don't send marketing, and our emails have no open or link tracking.

### Rate limits

To stop abuse, we count recent requests in short-lived windows, from a few minutes to a day, keyed by your account id, upload key id, or a keyed hash of your IP address or email address, never the readable address. They expire by themselves when their window ends.

### Logs

Our servers keep operational logs (for example errors and the requests that caused them) to run and secure files.gg. They're kept for [LOG RETENTION].

## 3. Cookies and browser storage

files.gg sets **one cookie**, and only when you sign in: `__Host-filesgg_session`, which keeps you signed in. It's strictly necessary, so it doesn't need your consent. It's sent only to files.gg itself (never to cdn.files.gg, api.files.gg or custom domains), scripts can't read it, and it ends when you sign out, after 30 days without use, or 180 days after you signed in, whichever comes first<!-- SESSION_IDLE_DAYS = 30, SESSION_MAX_DAYS = 180, api/utils/account_settings.py -->.

We don't use tracking, analytics or advertising cookies, so there's no cookie banner.

files.gg also keeps a few things in your browser's own storage, for these features. They never leave your browser unless the table says so, and you can clear them at any time in your browser's settings.

| Key | What it's for |
|---|---|
| `filesgg.guest` | Your guest id, the random identifier for your anonymous uploads (section 2). Sent to files.gg while you're signed out; deleted when you sign in. |
| `filesgg.access.<file or album>` | Unlock tokens for password-protected files and albums you've opened, until they expire. Sent to files.gg to open them. |
| `filesgg.uploads` | Interrupted uploads, so you can resume them (ids and sizes only). |
| `filesgg.showSensitive` | "Always show sensitive media". |
| `filesgg.volume`, `filesgg.muted` | The media player's volume. |
| `filesgg.verify-banner` (session storage) | That you dismissed the "verify your email" banner, until you close the tab. |
| `filesgg.changelog.seen` | The newest changelog entry you've opened, for the dot on **Changelog**. |
| `filesgg.admin.notify` | Staff only: browser notifications for urgent reports. |
| `filesgg.oauth` (session storage) | The state of a Discord sign-in while it's in progress. |

When a page needs a human check (signing in, signing up, password resets, unlocking a file, opening a view-limited file, and anonymous uploads, conversions and reports), it loads **Cloudflare Turnstile** from Cloudflare. Turnstile is Cloudflare's own service and follows Cloudflare's privacy policy. If you've linked Discord, **Settings** shows your Discord avatar, loaded from Discord.

## 4. Who we share data with

We don't sell your personal data or share it for advertising. We share it only with these service providers, to run files.gg, and only what each one needs:

| Provider | What for | What they receive |
|---|---|---|
| **Cloudflare** | Our network and CDN, the human check (Turnstile), and custom domains | Every request to files.gg, including your IP address; the hostnames of custom domains. Cloudflare's CSAM Scanning Tool also checks images served through it. |
| **Backblaze B2** (United States) | File storage, and encrypted database backups | Your files, previews and data exports; backups are encrypted before they're sent. |
| **Postmark** | Account emails | Your email address, username and the email's content. |
| **Discord** | Signing in with Discord, only if you use it | Discord already has your account; we receive your profile from them (section 2). |
| **Microsoft PhotoDNA** | Matching images against known child sexual abuse material | Scaled-down copies of the images in each upload: pictures, video and animation frames, audio cover art, the first pages of PDFs, and images inside archives. |
| **Google Web Risk** | Checking links for malware and phishing | Links found in text files, PDFs and album text. |

We also share data:

- with the **National Center for Missing & Exploited Children (NCMEC)** when US law requires us to report apparent child sexual abuse material, which can include the content, the account's email address and username, file names and times, and the uploader's IP address;
- with **law enforcement, courts or others** when the law requires it, or when we need to protect someone from serious harm;
- with **whoever takes over files.gg**, if it's sold or transferred, under this policy.

Everything else (scanning for malware, adult-content classification, previews, conversions) runs on our own servers.

## 5. How long we keep data

| Data | How long |
|---|---|
| Your files | Until they expire, you delete them, or we remove them. Anonymous files expire within 21 days<!-- ANONYMOUS_MAX_EXPIRY = 21 days, api/utils/limits.py -->. A deleted file's content is erased from storage 48 hours later<!-- BLOB_GC_GRACE = 48 h, api/jobs/gc.py -->, unless another file still uses the same content, or we must keep it as evidence (below). |
| Your account | Until you delete it (below). |
| Sign-in sessions | Until they end, then 30 more days<!-- cleanup_sessions: revoked or expired sessions deleted after 30 days, api/jobs/accounts.py -->. |
| Email verification and password reset links | 7 days after they're used or expire<!-- cleanup_sessions: account_tokens deleted 7 days after use or expiry, api/jobs/accounts.py -->. |
| Data exports | 7 days<!-- EXPORT_KEEP_DAYS = 7, api/utils/account_settings.py -->. |
| A username you gave up | Held for you for 30 days, so nobody else can take it<!-- USERNAME_HOLD_DAYS = 30, api/utils/account_settings.py -->. |
| Keyed IP hashes on uploads, reports and conversions; sealed uploader IP addresses | 30 days<!-- ABUSE_IP_KEEP_DAYS = 30, api/safety/settings.py -->. |
| Daily view and upload-limit hashes | 2 days<!-- VIEW_SEEN_KEEP_DAYS = 2, UPLOADER_IP_KEEP_SECONDS = 2 days, api/jobs/tasks.py -->. |
| Reports | Closed 30 days after they're resolved<!-- REPORT_CLOSE_AFTER_DAYS = 30, api/safety/settings.py -->, then deleted 365 days after closing<!-- REPORT_RETENTION_DAYS = 365, api/safety/settings.py -->, except child-safety reports, which are kept with their evidence. |
| The contact email on an anonymous report | 90 days after the report closes<!-- CONTACT_EMAIL_DAYS = 90, api/safety/tasks.py -->. |
| Evidence of child sexual abuse material | 365 days in a separate, locked store<!-- EVIDENCE_RETENTION_DAYS = 365, api/safety/settings.py -->, or longer if the law or a legal request requires it. |
| A copy of content our staff delete | 90 days by default, up to 365 days<!-- HOLD_DAYS_DEFAULT = 90, HOLD_DAYS_MAX = 365, api/safety/settings.py -->, in case it's needed for an appeal or a legal request. |
| Moderation records (the audit log, notices, bans) | For as long as files.gg runs, so our decisions can be checked. A ban's IP hash is kept while the ban lasts. |

**Deleting your account.** When you ask to delete your account, it's locked and your files, albums and custom domains go offline at once. 14 days later<!-- ACCOUNT_DELETION_GRACE_DAYS = 14, api/utils/account_settings.py -->, unless you've signed in and chosen **Keep my account**, we delete it permanently: your email address, password hash, display name, Discord link, sessions, upload keys, files, albums, custom domains and data exports. What remains is a record that an account with that id existed (with the username replaced by `deleted-<id>`), the reports you sent (no longer linked to your details), and the moderation records about your account and content.

**Backups.** We back up our database every day, encrypted, so we can recover from a failure. Daily backups are kept for 14 days, and one backup a week is kept for a year<!-- DB_BACKUP_KEEP_DAILY = 14, DB_BACKUP_KEEP_WEEKLY = 52, backup/backup.sh -->, so data you delete can remain in older backups for up to a year before the last of them is deleted. Backups hold the database, not your files: file contents aren't in them. We use backups only to restore files.gg after a failure.

## 6. Your rights

Depending on where you live, you have the right to:

- **access** your data and get a **copy** of it: **Settings → Data** gives you your account, sessions, upload keys, domains, files' and albums' details, reports and notices as JSON files (one export a day<!-- one export per 24 h, contract milestone-6 §8.7 -->). Your files themselves you can download from the dashboard;
- **correct** it: change your email, username (once every 30 days<!-- USERNAME_COOLDOWN_DAYS = 30, api/utils/account_settings.py -->) and display name in **Settings**;
- **delete** it: delete files and albums at any time, and your account in **Settings**;
- **object** to how we use it, or ask us to **restrict** it;
- **withdraw** a choice you made, such as unlinking Discord.

For anything you can't do in **Settings**, or if you upload anonymously, write to [PRIVACY CONTACT]. We may need to check it's you, and we answer within the time the law sets. Some data we must keep even if you ask us to delete it, for example evidence the law requires us to preserve.

**If you're in the EU or the UK,** GDPR and UK GDPR give you these rights, and these are our legal bases:

- **to provide files.gg to you** (performing our contract with you): your account, your files and albums, sharing, previews, conversions, sessions and account emails;
- **our legitimate interests in keeping files.gg and its users safe:** scanning, adult-content labels, rate limits, keyed IP hashes, reports, moderation and bans, security logs and backups;
- **legal obligations:** reporting and preserving child sexual abuse material, copyright notices, and legal requests.

You can complain to the data protection authority where you live or work (in the UK, the Information Commissioner's Office). We'd like the chance to help first, at [PRIVACY CONTACT].

## 7. Children

You must be 13 or older to use files.gg, or 16 or older in the European Union, Iceland, Liechtenstein and Norway, and 18 or older to upload, mark or view adult content. If you believe a child under that age is using files.gg, tell us at [PRIVACY CONTACT].

## 8. Transfers, security, changes and contact

**Transfers.** files.gg's servers are in [SERVER LOCATION]. Our file storage and backups are in the United States, and our other providers (section 4) process data in the United States and, for Cloudflare, wherever its network serves you. When your data leaves the EU, the UK or another country with transfer rules, we protect it with [TRANSFER SAFEGUARDS].

**Security.** We protect your data with, among other things:

- HTTPS everywhere, and a session cookie that scripts and other sites can't read;
- passwords, session tokens and upload keys stored only as hashes;
- IP addresses kept only as keyed hashes, or sealed to an offline key;
- user files served from a separate, locked-down address (cdn.files.gg) where they can't run code;
- database backups encrypted before they leave our servers;
- evidence kept in a separate store that can't be changed or deleted before its time;
- staff access limited to what moderation needs, and recorded.

No system is perfectly secure. If something goes wrong that puts your data at risk, we'll tell you and the authorities as the law requires.

**Changes.** When we change this policy, we update the date at the top and note the change in the [changelog](/changelog). For a significant change, we'll also tell account holders by email or in the dashboard at least [NOTICE PERIOD] before it takes effect.

**Contact.** [OPERATOR], [OPERATOR ADDRESS], [PRIVACY CONTACT].
