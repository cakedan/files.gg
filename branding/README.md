# files.gg brand assets

The mark is a **folded tile f.**: a rounded green tile with a page-fold corner, a lowercase **f**, and the dot from `.gg`. The wordmark is drawn from the same 8-unit round strokes as the f, so it needs no font file.

Every file here comes from [`build.py`](build.py). Edit the shapes or colours there, then run:

```bash
python3 branding/build.py
```

This writes the SVGs and renders the PNGs and the ICO. Rendering compiles `render.swift` (AppKit's native SVG renderer) into a temp folder, so it needs macOS with the Xcode command-line tools and nothing else. On any other OS the SVGs are still written and rendering is skipped.

## Files

| File | Use |
|---|---|
| `filesgg-mark.svg` | The mark, with gradient. Use it at 48 px and above. |
| `filesgg-mark-small.svg` / `favicon.svg` | The mark for 16–32 px: flat green, heavier strokes, bigger dot. |
| `filesgg-mark-mono.svg` | One colour, using `currentColor`. For stamps, watermarks and monochrome UI. |
| `filesgg-wordmark.svg` / `-light.svg` | "files.gg" for dark or light backgrounds. |
| `filesgg-lockup.svg` / `-light.svg` | The mark and wordmark side by side. Use this in the navbar. |
| `filesgg-app-icon.svg` | The mark on a dark square. The OS applies its own corner mask. |
| `filesgg-og.svg` | The default link-preview image (1200×630). |
| `favicon.ico` | 16, 32 and 48 px in one file. |
| `png/favicon-{16,32,48}.png` | Favicons. 16 and 32 use the small mark. |
| `png/apple-touch-icon.png` | 180 px icon for iOS home screens. |
| `png/icon-{192,512}.png` | PWA manifest icons (maskable: the mark sits inside the safe zone). |
| `png/filesgg-mark-{256,512}.png` | Mark rasters, for example a Discord or GitHub avatar. |
| `png/filesgg-lockup{,-light}.png` | Lockup rasters (945×228). |
| `png/og-image.png` | The default `og:image`. |

## Colours

| Token | Hex | Use |
|---|---|---|
| `--gg` | `#3DEB7E` | Brand green: the tile, `.gg`, links |
| `--gg-end` | `#25B874` | The tile gradient's end colour |
| `--gg-fold` | `#1B7945` | The folded corner; also a dark accent |
| `--gg-ink` | `#16301F` | The f and dot on the tile |
| `--gg-on-light` | `#1FA86A` | `.gg` on light backgrounds (better contrast) |
| `--bg` | `#1E1F22` | Page background |
| `--text` | `#F2F3F5` | "files" on dark backgrounds |

## Rules

- **Don't drop the fold** from the tile. Without it, the mark becomes the generic "f in a rounded square" outline, which looks like other brands.
- **Don't draw the f in white** on the tile. The dark ink is part of what makes the mark recognisable.
- **Spacing:** leave clear space around the mark of at least ¼ of its width.
- **Size:** use the mark alone below 120 px wide; the lockup only from about 120 px up.

## HTML `<head>`

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#1E1F22">
<meta property="og:image" content="https://files.gg/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
```
