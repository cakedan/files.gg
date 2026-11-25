"""Upload-time checks (contract milestone-4 §2.5, §5.1): bans and restrictions first, then the
libmagic sniff, then known content (blocked hashes, blocked, NSFW and encrypted hashes).

The single-request path (async, views/files.py) and `finalize_upload` (sync, jobs/finalize.py)
both use these; a refused upload stores nothing.
"""

import asyncio

from safety import core
from safety.states import CSAM_REASONS
from utils import filetypes

# a known blocked hash's refusal, by its scan reason
SCAN_REFUSALS = {'malware': 'MALWARE_DETECTED', 'blocked_type': 'FILE_TYPE_NOT_ALLOWED'}


def sniffed_type(head):
    """libmagic's type of the first 64 KiB (python-magic), or None."""
    try:
        import magic
        sniffed = (magic.from_buffer(bytes(head[:filetypes.SNIFF_BYTES]), mime=True) or '').split(';', 1)[0] \
            .strip().lower() or None
        return filetypes.trusted_sniff(sniffed, head)
    except Exception:
        return None


def sniff_blocked(head):
    """True when the sniffed type is in BLOCKED_MIMETYPES (§5.1): FILE_TYPE_NOT_ALLOWED."""
    return filetypes.blocked_mimetype(sniffed_type(head))


async def sniff_blocked_async(head):
    """`sniff_blocked` for the API: libmagic is CPU-bound C, so it runs in the default executor
    instead of on the event loop."""
    head = bytes(head[:filetypes.SNIFF_BYTES])
    return await asyncio.get_running_loop().run_in_executor(None, sniff_blocked, head)


def refusal(blocked_reason=None, scan_state=None, scan_reason=None, nsfw_auto=False, warnings=(), anonymous=False,
            nsfw=False):
    """(code, csam) for known content, or (None, False). §2.5 steps 1 to 4."""
    if blocked_reason is not None:
        if blocked_reason == 'csam':
            return 'FILE_BLOCKED', True
        return ('MALWARE_DETECTED' if blocked_reason == 'malware' else 'FILE_BLOCKED'), False
    if scan_state == 'blocked':
        return SCAN_REFUSALS.get(scan_reason, 'FILE_BLOCKED'), scan_reason in CSAM_REASONS
    if anonymous and (nsfw or nsfw_auto):
        return 'NSFW_REQUIRES_ACCOUNT', False
    if anonymous and 'encrypted_archive' in (warnings or ()):
        return 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT', False
    if anonymous and 'encrypted_pdf' in (warnings or ()):
        return 'ENCRYPTED_PDF_REQUIRES_ACCOUNT', False
    return None, False


KNOWN_SQL = (
    'SELECT (SELECT id FROM blocked_hashes b WHERE b.blake2b = %(b)s AND b.sha1 = %(s)s AND b.md5 = %(m)s), '
    '(SELECT reason FROM blocked_hashes b WHERE b.blake2b = %(b)s AND b.sha1 = %(s)s AND b.md5 = %(m)s), '
    'h.scan_state, h.scan_reason, h.nsfw_auto, h.scan->\'warnings\' '
    'FROM (SELECT 1) one LEFT JOIN file_hashes h ON h.blake2b = %(b)s AND h.sha1 = %(s)s AND h.md5 = %(m)s')


def known_content(conn, blake2b, md5, sha1, anonymous, nsfw=False):
    """Sync: (code or None, csam): `csam` when the refusal must also run §3.6's uploader steps."""
    row = conn.execute(KNOWN_SQL, {'b': blake2b, 's': sha1, 'm': md5}).fetchone()
    return _decide(row, anonymous, nsfw)


async def known_content_async(conn, blake2b, md5, sha1, anonymous, nsfw=False):
    cursor = await conn.execute(KNOWN_SQL, {'b': blake2b, 's': sha1, 'm': md5})
    return _decide(await cursor.fetchone(), anonymous, nsfw)


def _decide(row, anonymous, nsfw):
    entry_id, reason, scan_state, scan_reason, nsfw_auto, warnings = row
    return refusal(reason, scan_state, scan_reason, bool(nsfw_auto), warnings or (), anonymous, nsfw)


def standing(conn, user_id=None, fingerprint=None, ip_hash=None):
    """Sync: an error code and its `until` for a banned or restricted uploader, else (None, None)."""
    if user_id is None and core.active_ban(conn, fingerprint=fingerprint, ip_hash=ip_hash):
        return 'BANNED', None
    if user_id is not None:
        if core.active_ban(conn, ip_hash=ip_hash):
            return 'BANNED', None
        for _, kind, _, ends_at, _ in core.active_restrictions(conn, user_id):
            if kind == 'suspended':
                return 'ACCOUNT_SUSPENDED', ends_at
        for _, kind, _, ends_at, _ in core.active_restrictions(conn, user_id):
            if kind == 'uploads':
                return 'UPLOADS_RESTRICTED', ends_at
    return None, None
