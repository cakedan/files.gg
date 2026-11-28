# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

files.gg serves three groups equally; none of them is secondary:

- **Discord and gaming communities** sharing screenshots, clips and files into chats and servers. Discord is a sign-in option, and conversion has presets made for it, such as "Shrink for Discord".
- **Anyone who needs to share a file:** drop, paste or pick a file and get a link, with no account needed for files up to 25 MB.
- **Power users** who upload from ShareX or curl with upload keys, script their uploads, or share links on their own domain (premium).

There is also a fourth group: **the people who open a link.** They usually have no account and may never visit the dashboard. The viewer (`files.gg/<vanity>`, `files.gg/a/<vanity>`, and custom domains) is often their only contact with files.gg.

## Product Purpose

Share any file with a link. files.gg hosts the upload, opens it properly in the browser for whoever gets the link, and gives the uploader control over who can open it and for how long. Success means a link that just works for the person opening it, and an uploader who never had to think about how.

## Positioning

files.gg sets itself apart in three ways:

1. **Viewer quality.** Files open in the browser instead of becoming a download link. Images get a lightbox; PDFs get search, thumbnails, outline and deep links; there are video and audio players; text and code are highlighted; Word, Excel and PowerPoint get previews. Albums have grid, list and tracklist layouts.
2. **Control over sharing.** Every file can be shared with anyone who has the link, with people who have a password (files.gg can generate one), or with nobody but its owner. Files can expire after a set time or after a set number of views.
3. **Tools and domains.** Conversion between formats with one-click presets, upload keys with a ready-made ShareX config, curl support, and custom domains for premium accounts.

Safety is a requirement, not part of the pitch: it must be present and clear, but design work shouldn't sell it (see Capabilities and Constraints).

## Operating Context

- Links are mostly pasted into Discord and other chats, where link previews (`og:*` tags and the default `og-image.png`) are the first impression before anyone clicks.
- The viewer boots from file data that the Cloudflare Worker puts into the HTML, without calling the API, and must stay a small bundle separate from the dashboard. Its lock screen, report form, PDF viewer, players and text viewer load lazily.
- Uploads come from the browser (the home page is itself an upload box, and a drop or paste anywhere on it uploads), from the dashboard, and from ShareX and curl with upload keys.
- Recipients open links on desktop and on phones. Custom-domain links (`i.example.com/<vanity>`) are served by the same viewer.
- The dashboard (`files.gg/app`) is where account holders manage files, albums, storage, upload keys, domains, settings, reports and notices. Staff also use it for moderation and the admin queue.

## Capabilities and Constraints

- **Limits:** guests can upload up to 25 MB and accounts up to 1 GB. ShareX and curl are promised 100 MB through the API. Big uploads are chunked and resume if the connection drops.
- **Accounts:** sign in with email or Discord (Discord is optional). Guests can upload, and signing in claims their uploads. Users can download their data or delete their account from Settings.
- **Premium:** more storage, bigger uploads and custom domains. Staff grant it for now; there is no paid plan or billing yet.
- **Safety:** every upload is scanned before it's shared (PhotoDNA, ClamAV, Web Risk for links). Adult content is detected and labelled. Anyone can report a file, album or user. Owners see actions on their files in Notices and can appeal them, and reporters can follow their reports in My reports. Executables are blocked.
- **Regional rules:** adult content is unavailable in the UK (HTTP 451, with a region page). The minimum age is 16 in the EU and EEA and 13 elsewhere.
- **Nothing carries over from the old site:** no data, no old links, no old API shapes. An old link gets the plain missing page.
- **Status:** milestones 1–7 are built on `redesign/milestone-3` but not deployed. Launch steps are in `docs/redesign/LAUNCH.md`. The Terms and Privacy pages are drafts with placeholders pending legal review, and the build fails while those placeholders remain.
- **Terms:** a link's ID is a *vanity*. Access modes are *link*, *password* and *private*. *Upload keys* are for tools. *Notices* are staff actions on a user's content. *Albums* hold multiple files behind one link.

## Brand Commitments

- **Name:** files.gg, always lowercase, with `.gg` as part of the identity.
- **Mark:** the folded-tile f, a rounded green tile with a page-fold corner, a lowercase f in dark ink, and the dot from `.gg`. It is built from `branding/build.py`, and its rules are in `branding/README.md`. Don't drop the fold, don't draw the f in white, keep clear space, and use the mark alone below about 120 px wide.
- **Identity:** files.gg has its own brand. The redesign borrows how nsb.gg's viewer and notsobot.com's dashboard *work*, not how they look, and keeps files.gg's green, the rounded f and `.gg`.
- **Voice (from shipped copy):** plain, short, second-person sentences that name the concrete thing: "Share any file with a link." "Drop a file anywhere on this page, paste it, or choose one." No hype.

## Evidence on Hand

- Brand assets in `branding/`: the mark, wordmarks, lockups, app icon, OG image and favicons.
- The feature list and launch notes in `CHANGELOG.md` (2026-11-25, "The new files.gg").
- Dev sample media in `web/fixtures/` and seeded mock accounts in `web/mock-api.ts`, for demos and screenshots.
- The redesign spec and milestone contracts in `docs/redesign/`.
- **Not on hand, don't fabricate:** testimonials, user or upload counts, uptime figures, press, customer logos, and premium pricing (there is no paid plan).

## Product Principles

1. **The link is the product.** Whatever opens from a link must work for someone with no account, on any device, quickly and without explanation.
2. **Simple by default, deep on demand.** Drop, paste and get a link stays one step. Access controls, expiry, conversion, keys and domains are there for those who want them and don't get in anyone else's way.
3. **Say plainly who can open it.** Access mode, expiry and view limits are stated clearly wherever a file is shared or viewed, so neither the uploader nor the recipient is surprised.
4. **Safety is a floor, not a feature.** Scanning, labels, warnings, reports and appeals must be clear and fair when they appear, without becoming the pitch.
5. **Own identity, borrowed mechanics.** Take proven behaviour from nsb.gg and notsobot.com, never their look.

## Accessibility & Inclusion

WCAG 2.2 AA across the viewer, the dashboard and the public pages.
