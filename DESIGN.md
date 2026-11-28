---
name: files.gg
description: Share any file with a link. A quiet dark frame where the file is the picture and green marks what you can do.
colors:
  gg: "#3deb7e"
  gg-end: "#25b874"
  gg-fold: "#1b7945"
  gg-ink: "#16301f"
  gg-on-light: "#1fa86a"
  bg: "#1e1f22"
  surface: "#2b2d31"
  surface-2: "#313338"
  well: "#1a1b1e"
  line: "#3f4147"
  text: "#f2f3f5"
  muted: "#b5bac1"
  danger: "#ff857e"
  danger-fill: "#d23336"
  danger-fill-hover: "#c7262d"
  warn: "#faa61a"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.11
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "-0.025em"
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.56
  control:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.33
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  overline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "0.05em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  control: "12px"
  card: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.gg}"
    textColor: "{colors.gg-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "42px"
  button-primary-hover:
    backgroundColor: "{colors.gg-end}"
    textColor: "{colors.gg-ink}"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "42px"
  button-secondary-hover:
    backgroundColor: "{colors.line}"
    textColor: "{colors.text}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "42px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "{colors.danger-fill}"
    textColor: "#ffffff"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "42px"
  button-danger-hover:
    backgroundColor: "{colors.danger-fill-hover}"
    textColor: "#ffffff"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "42px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.full}"
    padding: "0 14px"
    height: "34px"
  chip-selected:
    backgroundColor: "color-mix(in srgb, #3deb7e 10%, transparent)"
    textColor: "{colors.gg}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "20px"
  viewer-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "40px"
  nav-item-active:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "20px"
---

# Design System: files.gg

## Overview

**Creative North Star: "The Quiet Frame"**

files.gg is a dark, calm frame, and the file is the picture. In the viewer, the image, video, PDF or code fills a card whose size the media decides, with a slim footer underneath: the name, the size, when it expires, and a few actions. The dashboard carries the same calm into a tool you manage files with: a sidebar, page titles, and lists of rows on tonal layers. Nothing in the interface competes with what was shared.

Green carries the meaning. It comes from the logo's folded tile and marks the action to take, the place you are in, links, and focus. Everything else is greys separated by tone and a single hairline. Depth comes from stepping between those greys, not from shadows. Only floating things (the viewer card and dialogs) cast one.

The form language is soft and friendly, echoing the rounded tile in the logo: generous 12 px corners on controls, 16 px on cards, full pills on filter chips, and 42 px controls that are easy to hit on a phone.

**Key Characteristics:**
- Dark only for now. The raw tokens sit on `:root` in `web/src/styles/theme.css` so a light theme can redefine them in one place.
- One accent, Signal Green, used for meaning and never as decoration on large areas.
- Flat tonal layers, a 1 px hairline, and one card shadow for things that float.
- The system font stack; no webfonts.
- Soft, rounded controls and cards that echo the logo tile.

## Colors

One saturated green against cool, near-neutral charcoal greys, plus two status colours.

### Primary
- **Signal Green** (`gg`): the brand green from the logo tile. Fills the primary button, colours links, the active nav icon, selected chips, the `.gg` in the wordmark and the 2 px focus ring. Tinted at 5–15% for selected and highlighted states. Text is never dark ink on a tint; on a solid green fill it is always Tile Ink.
- **Deep Signal Green** (`gg-end`): the end of the logo tile's gradient. The primary button's hover.
- **Fold Green** (`gg-fold`): the logo's folded corner. A dark green accent for small details only.
- **Tile Ink** (`gg-ink`): the f and dot on the logo tile, and the text and icons on any solid green fill.
- **Daylight Green** (`gg-on-light`): green for light backgrounds, where Signal Green fails contrast. Reserved for the light wordmark and a future light theme.

### Neutral
- **Frame Charcoal** (`bg`): the page and the frame around the viewer card; also the inside of text inputs, so fields read as recessed.
- **Card Slate** (`surface`): cards, the dashboard sidebar, dialogs, the viewer card.
- **Raised Slate** (`surface-2`): one step up. Secondary buttons, hover and active rows, the active nav item.
- **Media Well** (`well`): darker than the page, behind media inside the viewer card so letterboxing reads as part of the frame. Transparent images sit on a two-tone checkerboard built from the same darks.
- **Hairline Grey** (`line`): every 1 px border and divider, and the secondary button's hover.
- **Paper White** (`text`): primary text.
- **Quiet Grey** (`muted`): secondary text, metadata, idle icons, ghost buttons.

### Status
- **Alert Red** (`danger`): red text, error messages, invalid-field borders and status banners (a 10–15% tint with a 40% border). It's light enough to pass AA as text on every dark surface: 5.9:1 on Card Slate, and 4.5:1 on its own 15% tint over Card Slate.
- **Deep Alert Red** (`danger-fill`, hover `danger-fill-hover`): the solid red behind white text, used for the danger button and urgent badges such as the admin P0 count. White on it is 4.9:1, and 5.6:1 on hover.
- **Caution Amber** (`warn`): expiry soon, warnings, NSFW and safety notices, as a 10–15% tint.

### Named Rules
**The Green Means Go Rule.** Signal Green marks what you can act on, where you are, and the brand. It never fills a surface larger than a button. If a screen has green that does neither, remove it.

**The Two Reds Rule.** Red text and red fills are different tokens. Use `danger` for text, borders and tints, and `danger-fill` behind white text. One red can't pass AA both ways on these dark surfaces.

**The Quiet Viewer Rule.** On the viewer and album pages, no button has a green fill. Copy link is a grey square with a green icon; the file is the brightest thing on the page.

**The Borrowed Greys Rule.** The neutrals (`bg`, `surface`, `surface-2`, `line`, `text`, `muted`) currently match Discord's dark theme exactly. That match is not part of the identity and is slated to change. When it does, edit the values on `:root` in `theme.css` only, keep the same tonal order (well < bg < surface < surface-2 < line), and keep WCAG 2.2 AA contrast for `muted` on `surface-2`.

## Typography

**Display Font:** the system UI stack (`system-ui`, `-apple-system`, Segoe UI, Roboto, …)
**Body Font:** the same stack
**Mono Font:** `ui-monospace`, SF Mono, Menlo, Consolas, …

**Character:** native and invisible. The type is whatever the visitor's OS uses, so the frame feels like part of the device and the file gets the attention. Personality comes from the logo and the green, not the typeface.

### Hierarchy
- **Display** (600, 30 px on phones and 36 px from 640 px up, tight tracking): the home page's one headline. Nowhere else.
- **Headline** (600, 24 px, tight tracking): dashboard page titles such as "Overview" and "Files".
- **Title** (600, 18 px): dialog titles and section headings.
- **Control** (500, 15 px): button, input and tab labels.
- **Body** (400, 14 px): the workhorse for nearly all copy, rows, descriptions and nav items. Long text such as legal pages and help stays within about 70 characters per line.
- **Label** (400, 12 px): metadata such as size, type, "Uploaded 3 days ago" and helper text, usually in Quiet Grey.
- **Overline** (600, 11 px, uppercase, 0.05 em tracking): sidebar group headings ("Library", "Account", "Safety") only.
- **Mono** (13 px): file names in technical contexts, upload keys, code and the text viewer.

### Named Rules
**The System Voice Rule.** No webfonts. The viewer must boot from inlined data with a small bundle, and the wordmark is drawn from strokes, so it needs no font. Hierarchy comes from size and weight (400, 500, 600), never from a second family.

**The Numbers Line Up Rule.** Sizes, counts and storage figures use tabular numerals (`tabular-nums`) wherever they sit in columns or update while you watch.

## Layout

- **The viewer** centres one card on Frame Charcoal. The card's width is the media's own width, capped at the smaller of 90 vw and what fits under the footer's 13.5 rem in 90 dvh. Space is reserved from the media's width and height before it loads, and the footer never widens the card. Warning banners stack above the card at the card's width. With a mouse, a corner grip lets the visitor resize the card.
- **The dashboard** has a 16 rem sidebar on Card Slate from 1024 px up. Below that, a 56 px sticky header with a blurred Frame Charcoal backdrop opens the same nav as a drawer (18 rem, at most 85 vw) over a 60% black scrim. Content sits in a centred column up to 72 rem wide, with side padding of 16, 24 and 40 px at phone, 640 px and 1024 px widths.
- **Public pages** (home, convert, changelog, legal) use a centred column up to 64 rem, with the header and footer inside the same width.
- **Rhythm:** a 4 px base. Rows and controls group at 8–12 px. Card padding is 20 px. Sections are 24 px apart in the dashboard and 48 px apart on the home page.
- **Dialogs** become bottom sheets below 640 px (full width, top corners rounded, at most 92 dvh tall) and centred cards above it.

**The Media Decides Rule.** In the viewer, never give the card a fixed width or a layout grid. The file sets the size, and the interface fits around it.

## Elevation & Depth

Flat tonal layering. Depth reads as lightness: Media Well, then Frame Charcoal, Card Slate, Raised Slate, with a 1 px Hairline Grey border around every in-flow card and between rows. Overlays dim the page with a 60% black scrim.

### Shadow Vocabulary
- **Card shadow** (`box-shadow: 0 9px 30px rgba(6, 6, 7, 0.3)`, `--shadow-card`): the viewer card, dialogs and sheets. Things that float above the frame.

### Named Rules
**The One Shadow Rule.** In-flow surfaces are flat. Only something floating above the page (the viewer card, a dialog, a menu) casts the card shadow, and nothing gets a second, different shadow.

## Shapes

Soft, rounded corners that echo the logo's folded tile.

- **Controls** (buttons, inputs, selects, nav items, menu items): 12 px.
- **Cards, dialogs and the viewer card:** 16 px. A dialog shown as a bottom sheet rounds only its top corners.
- **Chips, toggles, avatars and progress pills:** fully round.
- **Small marks** (focus outline targets, the resize grip, tiny badges): 4 px.
- **Borders:** a full 1 px Hairline Grey on every side, or none. Status banners use a full border in the status colour at 40%.

**The Tile Echo Rule.** A corner is a control (12 px), a card (16 px) or a pill. Don't invent sizes in between.

**Where it lives.** Buttons take their size from `buttonClass(variant, extra, size)` in `components/buttonClass.ts` (`md` 42 px, `sm` 32 px for dense rows and banners, `icon` a 42 px square); fields use `fieldClass` in `app/access/fieldUtils.ts`. Pick a size rather than overriding height or padding through `extra`, because two utilities for the same property don't reliably override each other. Icon-only buttons inside rows and the media and PDF toolbars stay 32–36 px with 12 px corners.

## Components

### Buttons
Soft and friendly: 42 px tall, 12 px corners, 15 px medium labels, an icon gap of 6 px, colour transitions on hover.
- **Primary:** Signal Green with Tile Ink text; hover deepens to Deep Signal Green. Used for the main action in the dashboard and on public pages: Upload, Choose files, Sign in. Not on the viewer (see the Quiet Viewer Rule).
- **Secondary:** Raised Slate with Paper White text; hover goes to Hairline Grey. Download, Raw and other neighbouring actions.
- **Ghost:** no fill, Quiet Grey text; hover gets Raised Slate and Paper White. Header links like Sign in, and icon buttons such as close and menu.
- **Danger:** Deep Alert Red with white text; hover deepens to the hover fill.
- **Small (`sm`):** 32 px tall, 10 px side padding, 14 px labels, for dense rows such as conversion history and link warnings.
- **Disabled:** 50% opacity, no pointer events.
- **Focus (all):** a 2 px Signal Green outline, offset 2 px.

### Chips
- **Style:** fully round, 34 px tall, a 1 px Hairline Grey border, Quiet Grey text.
- **Selected (`aria-pressed`):** border Signal Green at 60%, fill Signal Green at 10%, text Signal Green.
- **Hover (unselected):** Raised Slate fill, Paper White text.

### Cards / Containers
- **Corner Style:** 16 px.
- **Background:** Card Slate.
- **Shadow Strategy:** none in flow; the card shadow only when floating (see Elevation & Depth).
- **Border:** 1 px Hairline Grey.
- **Internal Padding:** 20 px. Headed sections inside a card are divided by a hairline.

### Inputs / Fields
- **Style:** 42 px tall, 12 px corners, Frame Charcoal fill (recessed below the card), 1 px Hairline Grey border, 15 px Paper White text.
- **Focus:** the global 2 px Signal Green outline.
- **Disabled:** 50% opacity.
- **Help and errors:** 12 px Label text under the field, in Quiet Grey or Alert Red.

### Navigation
- **Dashboard sidebar:** the files.gg lockup at the top, a full-width primary Upload button, then groups headed by Overline labels. Items are 14 px with a 16 px icon. Idle items are Quiet Grey and hover to a 60% Raised Slate fill. The active item gets Raised Slate, Paper White text and a Signal Green icon. The footer links sit at the bottom above a hairline.
- **Mobile:** a sticky 56 px header with a menu button and the lockup; the nav opens as a drawer on Card Slate.
- **Public header:** the lockup on the left, then ghost "Sign in" and secondary "Create account" (or "Dashboard" when signed in).

### Viewer Card (signature)
The file in a frame. Card Slate, 16 px corners, 1 px hairline and the card shadow, with the media on Media Well (or the checkerboard for transparency) sized by its own dimensions. Below it is the footer: the file name as a title; size, dimensions and type as a Label line; "Uploaded …" and the expiry in Caution Amber when it's soon; then a row of 42 px square icon buttons: Copy link (grey, with only its link icon in Signal Green), Download (grey), and Convert when the type has targets and Open original (no fill), each with a tooltip and an accessible name; then the Terms, Privacy and Report links. Files with no preview show a centred icon, the type and size, and a Download button in the well.

### Dialogs
A Card Slate card with 16 px corners, a hairline and the card shadow over a 60% black scrim. The title and description go at the top with a ghost close button; the body scrolls; the actions sit on the right in a footer divided by a hairline. Below 640 px it becomes a bottom sheet.

## Do's and Don'ts

### Do:
- **Do** let the media set the viewer card's size, and reserve its space from the width and height before it loads.
- **Do** keep at most one primary (Signal Green) button per card or toolbar in the dashboard; on the viewer, none (the Quiet Viewer Rule).
- **Do** separate layers by tone (Media Well < Frame Charcoal < Card Slate < Raised Slate) and a 1 px Hairline Grey, not by shadow.
- **Do** use 12 px corners on controls, 16 px on cards and dialogs, and full pills on chips, with controls 42 px tall.
- **Do** show status as a 10–15% tint of Alert Red or Caution Amber with a full border in the same colour at 40%.
- **Do** put white text only on `danger-fill`, never on `danger`.
- **Do** keep the 2 px Signal Green focus outline, offset 2 px, on every interactive element.
- **Do** meet WCAG 2.2 AA contrast for all text, including Quiet Grey on Raised Slate.

### Don't:
- **Don't** drop the fold from the logo tile, draw the f in white, or use the lockup below about 120 px wide (see `branding/README.md`).
- **Don't** put a coloured stripe down one side of a rounded card (as `app/notices/NoticeCard.tsx` does today). Use a full border, a tint, or a leading icon.
- **Don't** fill a surface larger than a button with Signal Green, or use it for decoration.
- **Don't** add a webfont or a second type family.
- **Don't** add new shadow styles; floating things use the card shadow, everything else is flat.
- **Don't** treat today's Discord-matching greys as fixed identity; change them only on `:root` in `theme.css`.
