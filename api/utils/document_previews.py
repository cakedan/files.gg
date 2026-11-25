"""Document previews on the API side (contract milestone-5 §9.1, decision 2): when a document-kind hash gets its
`jobs.convert.preview` job.

A document hash (§1.1) is queued once it's scanned `passed` or `flagged` and at least one live File of it is owned
by a **user** (never for guest-only content: no new LibreOffice input comes from anonymous uploads). Queuing is
two steps, as for conversions (decision 17): `preview_state = 'queued'` is committed with whatever made the hash
eligible (its scan, staff clearing it, a claim into an account), then the RQ job is enqueued after the commit. Where
the caller can't enqueue after its own commit (a claim inside a sign-in transaction, staff actions), the sweeper
(`convert_sweep`) enqueues the queued preview within a minute.

`DOCUMENT_PREVIEWS=0` turns previews off (§14).
"""

import os

from media import formats

DOCUMENTS = sorted(formats.DOCUMENT_MIMETYPES)
# a queued preview's hash: eligible right now
MARK_SQL = (
    "UPDATE file_hashes h SET preview_state = 'queued' WHERE h.id = ANY(%s) AND h.preview_state = 'none' "
    "AND h.scan_state IN ('passed', 'flagged') AND EXISTS (SELECT 1 FROM files f WHERE f.hash_id = h.id "
    'AND f.user_id IS NOT NULL AND f.deleted_at IS NULL AND (f.expires_at IS NULL OR f.expires_at > now()) '
    'AND f.mimetype_id = ANY(%s)) RETURNING h.id')


def enabled():
    return (os.getenv('DOCUMENT_PREVIEWS', '1').strip().lower() not in ('0', 'false', 'no', 'off'))


def mark(conn, hash_ids):
    """Sync, in the caller's transaction: `queued` for the eligible ones among `hash_ids`. Returns those ids, for
    `enqueue` once the transaction commits."""
    if not enabled() or not hash_ids:
        return []
    return [r[0] for r in conn.execute(MARK_SQL, (list(hash_ids), DOCUMENTS)).fetchall()]


async def mark_async(conn, hash_ids):
    if not enabled() or not hash_ids:
        return []
    cursor = await conn.execute(MARK_SQL, (list(hash_ids), DOCUMENTS))
    return [r[0] for r in await cursor.fetchall()]


def enqueue(hash_ids):
    """After the commit: `jobs.convert.preview` on `convert_previews` for each. A failure is left to the sweeper."""
    from utils import convert_queue
    for hash_id in hash_ids:
        convert_queue.enqueue_preview(hash_id)
