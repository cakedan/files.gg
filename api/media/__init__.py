"""Media processing (contract §2): `probe` fills `file_hashes.media`, `derive` makes the
assets in `file_hash_assets`. The untrusted parsing runs in `python -m media.process`
under media/sandbox.py's limits; jobs/media.py moves blobs and rows around it."""

# the preview kinds (contract §3): a fixed set, each with one extension and content type.
# Stored at derived/<hash_id>/<kind>.<ext>, served at /previews/<kind>/<vanity>.<ext>.
PREVIEW_KINDS = {
    'thumb': ('webp', 'image/webp'),
    'thumb-2x': ('webp', 'image/webp'),
    'display': ('webp', 'image/webp'),
    'poster': ('webp', 'image/webp'),
    'cover': ('webp', 'image/webp'),
    'waveform': ('webp', 'image/webp'),
    'peaks': ('json', 'application/json'),
    'hover': ('mp4', 'video/mp4'),
}


def preview_extension(kind):
    return PREVIEW_KINDS[kind][0]


def preview_content_type(kind):
    return PREVIEW_KINDS[kind][1]


def preview_filename(kind):
    """`thumb.webp`, `peaks.json`, ...: the object name under derived/<hash_id>/."""
    return '{}.{}'.format(kind, preview_extension(kind))

# images every current browser displays (the viewer's `kind: image`)
BROWSER_IMAGES = frozenset((
    'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
    'image/x-icon', 'image/vnd.microsoft.icon', 'image/x-png',
))
# never parsed: SVG is served as text/plain and is "other"
NOT_IMAGES = frozenset(('image/svg+xml',))
TEXT_EXCLUDED = frozenset(('text/html', 'text/xml', 'text/xsl'))
# Plain-text formats with application/* types: shown in the text viewer like text/*
TEXT_APPLICATIONS = frozenset((
    'application/json', 'application/ld+json', 'application/manifest+json', 'application/geo+json',
    'application/x-ipynb+json', 'application/x-ndjson', 'application/x-subrip',
))

# `media.language` from the extension: a fixed map of Shiki language ids, else null
LANGUAGES = {
    'py': 'python', 'pyw': 'python', 'pyi': 'python',
    'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript', 'jsx': 'jsx',
    'ts': 'typescript', 'mts': 'typescript', 'cts': 'typescript', 'tsx': 'tsx',
    'json': 'json', 'jsonc': 'jsonc', 'json5': 'json5',
    'md': 'markdown', 'markdown': 'markdown', 'mdx': 'mdx',
    'html': 'html', 'htm': 'html', 'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less',
    'c': 'c', 'h': 'c', 'cpp': 'cpp', 'cc': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hh': 'cpp', 'hxx': 'cpp',
    'cs': 'csharp', 'java': 'java', 'kt': 'kotlin', 'kts': 'kotlin', 'go': 'go', 'rs': 'rust', 'rb': 'ruby',
    'php': 'php', 'sh': 'bash', 'bash': 'bash', 'zsh': 'zsh', 'fish': 'fish', 'ps1': 'powershell',
    'bat': 'bat', 'cmd': 'bat', 'sql': 'sql', 'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml', 'xml': 'xml',
    'ini': 'ini', 'cfg': 'ini', 'lua': 'lua', 'swift': 'swift', 'dart': 'dart', 'r': 'r', 'pl': 'perl',
    'pm': 'perl', 'scala': 'scala', 'hs': 'haskell', 'ex': 'elixir', 'exs': 'elixir', 'erl': 'erlang',
    'clj': 'clojure', 'vue': 'vue', 'svelte': 'svelte', 'diff': 'diff', 'patch': 'diff',
    'dockerfile': 'dockerfile', 'mk': 'makefile', 'graphql': 'graphql', 'gql': 'graphql', 'tex': 'latex',
    'm': 'objective-c', 'mm': 'objective-cpp', 'zig': 'zig', 'nim': 'nim', 'vb': 'vb', 'fs': 'fsharp',
    'proto': 'proto', 'tf': 'terraform', 'nix': 'nix', 'csv': 'csv', 'tsv': 'tsv', 'log': 'log',
}


def language_of(extension):
    return LANGUAGES.get((extension or '').lower())


def base_kind(mimetype):
    """The viewer's `kind` from the mimetype alone (web/README.md §3)."""
    mimetype = (mimetype or '').lower()
    if mimetype in BROWSER_IMAGES:
        return 'image'
    if mimetype == 'application/pdf':
        return 'pdf'
    major = mimetype.split('/', 1)[0]
    if major in ('video', 'audio'):
        return major
    if (major == 'text' and mimetype not in TEXT_EXCLUDED) or mimetype in TEXT_APPLICATIONS:
        return 'text'
    return 'file'


def is_other_image(mimetype):
    """An image browsers can't display (HEIC/HEIF, TIFF, PSD, ...): gets a `display` preview."""
    mimetype = (mimetype or '').lower()
    if mimetype in BROWSER_IMAGES or mimetype in NOT_IMAGES:
        return False
    return mimetype.startswith('image/') or mimetype in ('application/x-photoshop', 'application/photoshop',
                                                         'application/psd')


def probe_kind(mimetype):
    """Which prober reads a blob: image, av, pdf, text, or None (skipped)."""
    kind = base_kind(mimetype)
    if kind == 'image' or is_other_image(mimetype):
        return 'image'
    if kind in ('video', 'audio'):
        return 'av'
    if kind in ('pdf', 'text'):
        return kind
    return None


def category(mimetype, media):
    """What `derive` makes (contract §2 table): image, image_other, animated, video,
    audio, pdf, text or other."""
    media = media or {}
    prober = probe_kind(mimetype)
    if prober == 'image':
        if (media.get('framecount') or 1) > 1:
            return 'animated'
        return 'image_other' if is_other_image(mimetype) else 'image'
    if prober == 'av':
        # probe only sets width/height for a real video stream (not an audio file's cover art)
        return 'video' if media.get('width') else 'audio'
    if prober in ('pdf', 'text'):
        return prober
    return 'other'
