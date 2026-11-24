#!/usr/bin/env python3
"""Build every files.gg brand asset from one set of shapes.

    python3 branding/build.py

Writes the SVG masters into branding/ and the rasters into branding/png/.
Rasterising compiles branding/render.swift (AppKit's native SVG renderer) into
a temp dir, so it needs macOS with Xcode command-line tools and nothing else.
On other platforms the SVGs are still written and rasterising is skipped.
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PNG_DIR = os.path.join(HERE, 'png')

# --- palette ---------------------------------------------------------------
GREEN = '#3DEB7E'       # brand green (the tile's light end)
GREEN_END = '#25B874'   # the tile gradient's dark end
GREEN_LIGHT_BG = '#1FA86A'  # ".gg" on light backgrounds (contrast)
FOLD = '#1B7945'        # the folded corner
INK = '#16301F'         # the f and its dot
INK_SMALL = '#10261A'   # slightly darker ink for the small favicon
TEXT_DARK_BG = '#F2F3F5'
TEXT_LIGHT_BG = '#1E1F22'
BG = '#1E1F22'

# --- the mark: a folded tile with "f." on a 64-unit grid --------------------
TILE = 'M14 0H48L64 16V50A14 14 0 0 1 50 64H14A14 14 0 0 1 0 50V14A14 14 0 0 1 14 0Z'
FOLD_PATH = 'M48 0V10A6 6 0 0 0 54 16H64Z'
FOLD_EDGE = 'M48 0V10A6 6 0 0 0 54 16H64'  # used for the knock-out gap in the mono mark
F_PATHS = ('M27.5 50V26.5C27.5 18.5 31.5 14.5 38.5 14.5H40', 'M19.5 30.5H36.5')
DOT = (44.5, 49.5, 4.75)
STROKE = 8.5

# Small variant for 16-32px: flat colour, heavier strokes, bigger dot.
F_PATHS_SMALL = ('M26 50V28C26 20 30 16 37 16H39', 'M17 31H35')
DOT_SMALL = (44, 49, 6)
STROKE_SMALL = 10

GRADIENT = (f'<linearGradient id="fgg-tile" x1="0" y1="0" x2="1" y2="1">'
            f'<stop offset="0" stop-color="{GREEN}"/><stop offset="1" stop-color="{GREEN_END}"/>'
            f'</linearGradient>')


def f_strokes(paths, width, color):
    inner = ''.join(f'<path d="{d}"/>' for d in paths)
    return (f'<g fill="none" stroke="{color}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round">{inner}</g>')


def dot(d, color):
    cx, cy, r = d
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}"/>'


def mark_body(small=False):
    """The mark's shapes in 64-unit space (expects the fgg-tile gradient in <defs>)."""
    if small:
        return (f'<path d="{TILE}" fill="{GREEN}"/><path d="{FOLD_PATH}" fill="{FOLD}"/>'
                + f_strokes(F_PATHS_SMALL, STROKE_SMALL, INK_SMALL) + dot(DOT_SMALL, INK_SMALL))
    return (f'<path d="{TILE}" fill="url(#fgg-tile)"/><path d="{FOLD_PATH}" fill="{FOLD}"/>'
            + f_strokes(F_PATHS, STROKE, INK) + dot(DOT, INK))


def svg(view_box, width, height, body, defs=''):
    defs = f'<defs>{defs}</defs>' if defs else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" '
            f'width="{width}" height="{height}"><title>files.gg</title>{defs}{body}</svg>\n')


# --- the wordmark: "files.gg" drawn from round 8-unit strokes ---------------
# Grid: x-height 22..54, ascender top 4, descender bottom 74, baseline at 54.
WM_FILES = (
    'M11 50V18C11 11 15 8 22 8H23',  # f
    'M4 26H21',                      # f crossbar
    'M37 26V50',                     # i
    'M53 8V50',                      # l
    'M68 38H92A12 12 0 1 0 88.49 46.49',  # e
    'M124.5 28.5C122 26 119 25 115 25C110 25 106 27.5 106 31.5C106 36 111 37 115 38'
    'C120 39 125 40.5 125 44.5C125 48.5 120.5 51 115 51C111 51 107 49.5 105 47',  # s
)
WM_FILES_DOTS = ((37, 10, 5),)       # dot of the i
WM_GG = (
    'M179 26V58C179 66 174 70 167 70C162 70 158.5 68 156.5 65',
    'M217 26V58C217 66 212 70 205 70C200 70 196.5 68 194.5 65',
)
WM_GG_RINGS = ((167, 38, 12), (205, 38, 12))
WM_GG_DOTS = ((140, 49, 5),)         # the "." of .gg
WM_STROKE = 8


def wordmark(ink, green):
    def strokes(paths, rings, color):
        inner = ''.join(f'<path d="{d}"/>' for d in paths)
        inner += ''.join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y, r in rings)
        return (f'<g fill="none" stroke="{color}" stroke-width="{WM_STROKE}" '
                f'stroke-linecap="round" stroke-linejoin="round">{inner}</g>')

    def dots(ds, color):
        return ''.join(dot(d, color) for d in ds)

    return (strokes(WM_FILES, (), ink) + dots(WM_FILES_DOTS, ink)
            + strokes(WM_GG, WM_GG_RINGS, green) + dots(WM_GG_DOTS, green))


def lockup(ink, green):
    # Mark scaled to 76 tall; the wordmark's x-height centre (y=38) lines up with the mark's centre.
    return (f'<g transform="scale(1.1875)">{mark_body()}</g>'
            f'<g transform="translate(94 0)">{wordmark(ink, green)}</g>')


def on_square(size_units, mark_scale, bg=BG):
    """The mark centred on a solid square (for app icons that get their own corner mask)."""
    off = (size_units - 64 * mark_scale) / 2
    return (f'<rect width="{size_units}" height="{size_units}" fill="{bg}"/>'
            f'<g transform="translate({off} {off}) scale({mark_scale})">{mark_body()}</g>')


def build_svgs():
    files = {
        'filesgg-mark.svg': svg('0 0 64 64', 64, 64, mark_body(), GRADIENT),
        'filesgg-mark-small.svg': svg('0 0 64 64', 32, 32, mark_body(small=True)),
        'filesgg-mark-mono.svg': svg('0 0 64 64', 64, 64,
            f'<path d="{TILE}" fill="currentColor" mask="url(#fgg-knock)"/>',
            '<mask id="fgg-knock" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
            '<rect width="64" height="64" fill="#fff"/>'
            + f_strokes(F_PATHS, STROKE, '#000') + dot(DOT, '#000')
            + f'<path d="{FOLD_EDGE}" fill="none" stroke="#000" stroke-width="3"/>'
            '</mask>'),
        'filesgg-wordmark.svg': svg('0 2 221 74', 221, 74, wordmark(TEXT_DARK_BG, GREEN)),
        'filesgg-wordmark-light.svg': svg('0 2 221 74', 221, 74, wordmark(TEXT_LIGHT_BG, GREEN_LIGHT_BG)),
        'filesgg-lockup.svg': svg('0 0 315 76', 315, 76, lockup(TEXT_DARK_BG, GREEN), GRADIENT),
        'filesgg-lockup-light.svg': svg('0 0 315 76', 315, 76, lockup(TEXT_LIGHT_BG, GREEN_LIGHT_BG), GRADIENT),
        'filesgg-app-icon.svg': svg('0 0 100 100', 512, 512, on_square(100, 1.1), GRADIENT),
        'filesgg-og.svg': svg('0 0 1200 630', 1200, 630,
            f'<rect width="1200" height="630" fill="{BG}"/>'
            '<rect width="1200" height="630" fill="url(#glow)"/>'
            f'<g transform="translate(600 315) scale(2.4) translate(-157.5 -38)">{lockup(TEXT_DARK_BG, GREEN)}</g>',
            GRADIENT + f'<radialGradient id="glow" cx="0.5" cy="0.5" r="0.6">'
            f'<stop offset="0" stop-color="{GREEN}" stop-opacity="0.16"/>'
            f'<stop offset="1" stop-color="{GREEN}" stop-opacity="0"/></radialGradient>'),
    }
    files['favicon.svg'] = files['filesgg-mark-small.svg']
    for name, content in files.items():
        with open(os.path.join(HERE, name), 'w') as fh:
            fh.write(content)
    # filesgg-mark-apple.svg was an early draft name; the app icon replaces it.
    stale = os.path.join(HERE, 'filesgg-mark-apple.svg')
    if os.path.exists(stale):
        os.remove(stale)
    return sorted(files)


# --- rasterising (macOS) -----------------------------------------------------
def render(renderer, svg_name, out_name, width, height=None):
    """Draw the SVG into an exact width x height bitmap with AppKit."""
    subprocess.run([renderer, os.path.join(HERE, svg_name), os.path.join(PNG_DIR, out_name),
                    str(width), str(height or width)], check=True)


def write_ico(out_path, png_paths):
    """Pack PNGs into a .ico (PNG-compressed entries; supported by every current browser)."""
    blobs = [open(p, 'rb').read() for p in png_paths]
    sizes = [struct.unpack('>II', b[16:24]) for b in blobs]
    header = struct.pack('<HHH', 0, 1, len(blobs))
    offset = 6 + 16 * len(blobs)
    entries = b''
    for (w, h), blob in zip(sizes, blobs):
        entries += struct.pack('<BBBBHHII', w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    with open(out_path, 'wb') as fh:
        fh.write(header + entries + b''.join(blobs))


def build_rasters():
    if sys.platform != 'darwin' or not shutil.which('swiftc'):
        print('swiftc not found (needs macOS + Xcode CLT): skipped PNG/ICO output', file=sys.stderr)
        return []
    os.makedirs(PNG_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp()
    renderer = os.path.join(tmp, 'render')
    subprocess.run(['swiftc', '-O', os.path.join(HERE, 'render.swift'), '-o', renderer], check=True)
    jobs = [
        ('filesgg-mark-small.svg', 'favicon-16.png', 16),
        ('filesgg-mark-small.svg', 'favicon-32.png', 32),
        ('filesgg-mark.svg', 'favicon-48.png', 48),
        ('filesgg-mark.svg', 'filesgg-mark-256.png', 256),
        ('filesgg-mark.svg', 'filesgg-mark-512.png', 512),
        ('filesgg-app-icon.svg', 'apple-touch-icon.png', 180),
        ('filesgg-app-icon.svg', 'icon-192.png', 192),
        ('filesgg-app-icon.svg', 'icon-512.png', 512),
        ('filesgg-lockup.svg', 'filesgg-lockup.png', 945, 228),
        ('filesgg-lockup-light.svg', 'filesgg-lockup-light.png', 945, 228),
        ('filesgg-og.svg', 'og-image.png', 1200, 630),
    ]
    out = []
    for svg_name, png_name, *size in jobs:
        render(renderer, svg_name, png_name, *size)
        out.append(png_name)
    shutil.rmtree(tmp, ignore_errors=True)
    write_ico(os.path.join(HERE, 'favicon.ico'),
              [os.path.join(PNG_DIR, n) for n in ('favicon-16.png', 'favicon-32.png', 'favicon-48.png')])
    out.append('../favicon.ico')
    return out


if __name__ == '__main__':
    for name in build_svgs():
        print('svg ', name)
    for name in build_rasters():
        print('png ', name)
