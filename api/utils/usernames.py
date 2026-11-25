"""Usernames and display names (contract milestone-6 §2.2, §2.3).

`python -m tools.username_rules` prints `RULES` as JSON: the web app's `web/src/lib/usernameRules.json`
is that output, so the register form explains a refusal with the same rules before sending.
"""

import re
import secrets
import unicodedata

MIN_LENGTH = 2
MAX_LENGTH = 32
DISPLAY_NAME_MAX = 32
CHARACTERS = re.compile(r'^[a-z0-9_.]+$')
STAFF_RESET = re.compile(r'^u[0-9]+$')
RESERVED = (
    'about', 'abuse', 'account', 'accounts', 'admin', 'administrator', 'album', 'albums', 'anonymous', 'api', 'app',
    'assets', 'auth', 'billing', 'blog', 'bot', 'cdn', 'contact', 'convert', 'copyright', 'dashboard', 'deleted',
    'discord', 'dmca', 'docs', 'domains', 'download', 'email', 'files', 'gg', 'guest', 'help', 'info', 'internal',
    'legal', 'login', 'logout', 'mail', 'me', 'mod', 'moderator', 'moderators', 'news', 'noreply', 'null', 'official',
    'owner', 'password', 'premium', 'press', 'privacy', 'register', 'report', 'reports', 'root', 'security',
    'settings', 'signin', 'signup', 'staff', 'status', 'support', 'system', 'team', 'terms', 'test', 'undefined',
    'upload', 'uploads', 'user', 'users', 'verify', 'www',
)
RESERVED_PREFIXES = ('filesgg', 'files.gg', 'files_gg')
_RESERVED_SET = frozenset(RESERVED)

DISPLAY_RESERVED = ('staff', 'files.gg staff', 'moderator', 'admin', 'support')
# bidi controls, zero-width characters and the like (the Milestone 1 filename cleaning)
_INVISIBLE = re.compile('[­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]')
_CONTROL = re.compile('[\x00-\x1f\x7f-\x9f]')
_SPACES = re.compile(r'\s+')

RULES = {
    'min_length': MIN_LENGTH,
    'max_length': MAX_LENGTH,
    'characters': '[a-z0-9_.]',
    'reserved': sorted(RESERVED),
    'reserved_prefixes': list(RESERVED_PREFIXES),
    'staff_reset_pattern': STAFF_RESET.pattern,
    'display_name_max_length': DISPLAY_NAME_MAX,
    'display_name_reserved': list(DISPLAY_RESERVED),
}


def normalize(raw):
    return str(raw if raw is not None else '').strip().lower()


def check(raw):
    """(username, reason): the trimmed, lowercased name and None when it's valid, else the first
    failing rule: `length`, `characters`, `dots`, `numeric` or `reserved`. `taken` is the database's."""
    name = normalize(raw)
    if not MIN_LENGTH <= len(name) <= MAX_LENGTH:
        return name, 'length'
    if not CHARACTERS.match(name):
        return name, 'characters'
    if name.startswith('.') or name.endswith('.') or '..' in name:
        return name, 'dots'
    if name.isdigit():
        return name, 'numeric'
    if name in _RESERVED_SET or STAFF_RESET.match(name) or name.startswith(RESERVED_PREFIXES):
        return name, 'reserved'
    return name, None


REASON_MESSAGES = {
    'length': 'Use 2 to 32 characters',
    'characters': 'Use only letters, numbers, _ and .',
    'dots': "Don't start or end with a dot, or use two in a row",
    'numeric': 'Use at least one letter or _',
    'reserved': "That username isn't available",
}


def clean_display_name(raw):
    """NFC, invisible and control characters removed, whitespace collapsed, trimmed. Empty = None."""
    if raw is None:
        return None
    text = unicodedata.normalize('NFC', str(raw))
    text = _INVISIBLE.sub('', text)
    text = _CONTROL.sub(' ', text)
    text = _SPACES.sub(' ', text).strip()
    return text or None


def display_name_reason(name):
    """None when `name` (already cleaned) is fine, else `length` or `reserved`."""
    if name is None:
        return None
    if not 1 <= len(name) <= DISPLAY_NAME_MAX:
        return 'length'
    # compared case-insensitively after removing spaces, `.`, `_` and `-`: "Files GG", "files_gg" and
    # "FILES.GG Staff" are all refused
    squashed = _squash(name)
    if 'filesgg' in squashed or squashed in _DISPLAY_RESERVED_SQUASHED:
        return 'reserved'
    return None


def _squash(text):
    return re.sub(r'[\s._-]', '', text.casefold())


_DISPLAY_RESERVED_SQUASHED = frozenset(_squash(r) for r in DISPLAY_RESERVED)


def suggestions(discord_username):
    """The Discord name lowercased, then with _2 ... _9 (cut to fit), then user_ + 6 random digits (§5.5)."""
    base = normalize(discord_username)
    yield base
    for n in range(2, 10):
        suffix = '_{}'.format(n)
        yield base[:MAX_LENGTH - len(suffix)] + suffix
    yield 'user_{:06d}'.format(secrets.randbelow(10 ** 6))
