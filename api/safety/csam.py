"""On a CSAM match (contract milestone-4 §3.6). Triggered by a HashMatcher hit (scan or rescan),
an exact `blocked_hashes` entry with reason `csam`, or child-safety staff confirming a report or
a held file (`confirm_csam`, source `staff`). All steps are automatic and in this order, and each
is idempotent, so a retry finishes what failed:

1. Block: `blocked` / `csam_match`; derived assets deleted; album collages cleared.
2. Remember: `blocked_hashes` (reason csam) with the PDQs, then a `pdq_sweep`.
3. Preserve evidence: server-side copy `files/<hash_id>` to the evidence bucket at
   `csam/<case_id>/<hash_id>` with Object Lock (compliance) until now + EVIDENCE_RETENTION_DAYS,
   then `evidence_holds`; only after both, delete `files/<hash_id>` (all versions).
4. Restrict the uploaders: owners suspended (rule csam, no notice, no appeal); guests and IP
   hashes banned without expiry; every other file and album of those owners hidden (rule csam).
5. Open the case: `hash`, P0, child safety, the vendor references in an action's details.
6. Record: `csam_match`, `block`, `preserve_evidence`, `suspend_user` and `ban` rows, on the case.

Hash-matched content is never displayable: no API returns a URL for it, no staff grant is
signed for it, and the files bucket no longer has it. Nothing here notifies anyone.

A scan or rescan that finds a match queues `csam_handle {"hash_id", "source", "outcome"}` (queue
`scan`) in the same transaction that commits `csam_match`, then runs the steps at once; if they
fail, the job runs them again (with backoff, CSAM_HANDLE_ATTEMPTS times) until they're all done.
Runs for one hash are serialised by an advisory lock.
"""

import base64
import json
import logging

from datetime import timedelta

import db
from jobs.queue import register
from safety import core
from safety.settings import safety_settings
from utils import storage as storage_module
from utils.generators import EPOCH

log = logging.getLogger(__name__)

HANDLE_JOB = 'csam_handle'
HANDLE_QUEUE = 'scan'
# with the queue's backoff (capped at an hour) this keeps retrying for about two days, loudly
CSAM_HANDLE_ATTEMPTS = 60
# the scan runs the steps at once; the queued job is the safety net, so it waits a little
HANDLE_DELAY = 60
# pg_advisory_lock(int, int) namespace for one hash's §3.6 run
LOCK_NAMESPACE = 3060

ENQUEUE_HANDLE_SQL = (
    "INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) "
    "SELECT %s, %s::jsonb, now() + make_interval(secs => %s::float8), %s, %s "
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = %s AND payload->>'hash_id' = %s "
    "AND done_at IS NULL AND failed_at IS NULL) RETURNING id")


def outcome_payload(outcome):
    """A MatchOutcome as JSON for the job (it holds vendor references, never images)."""
    if outcome is None:
        return None
    return {'matcher': outcome.matcher, 'vendor_refs': list(outcome.vendor_refs),
            'unmatchable': list(outcome.unmatchable),
            'hits': [{'frame': h.frame, 'list_id': h.list_id, 'vendor_ref': h.vendor_ref} for h in outcome.hits]}


def outcome_from(payload):
    from safety.matchers import MatchHit, MatchOutcome
    if not payload:
        return None
    return MatchOutcome(matcher=payload['matcher'], vendor_refs=list(payload.get('vendor_refs') or ()),
                        unmatchable=list(payload.get('unmatchable') or ()),
                        hits=[MatchHit(frame=h['frame'], list_id=h.get('list_id'), vendor_ref=h.get('vendor_ref'))
                              for h in payload.get('hits') or ()])


def queue_handle(conn, hash_id, source, outcome=None, delay=HANDLE_DELAY):
    """Queue §3.6 for a matched hash (one runnable job per hash), in the caller's transaction.
    Returns the new job's id, or None when one is already queued."""
    payload = {'hash_id': str(hash_id), 'source': source, 'outcome': outcome_payload(outcome)}
    row = conn.execute(ENQUEUE_HANDLE_SQL, (HANDLE_JOB, json.dumps(payload), delay, CSAM_HANDLE_ATTEMPTS, HANDLE_QUEUE,
                                            HANDLE_JOB, str(hash_id))).fetchone()
    return row and row[0]


def handle_now(hash_id, source, outcome, job_id, client=None):
    """Run §3.6 right after the transaction that queued `job_id`. On success the job is marked done
    (unless a worker already claimed it: it then finds everything done); a failure is logged and
    left to the job."""
    try:
        handle_match(hash_id, source=source, outcome=outcome, client=client)
    except Exception:
        log.exception('CSAM handling for hash %s failed; the %s job retries it', hash_id, HANDLE_JOB)
        return False
    if job_id is not None:
        with db.connect() as conn:
            conn.execute('UPDATE jobs SET done_at = now() WHERE id = %s AND done_at IS NULL AND locked_by IS NULL',
                         (job_id,))
    return True


@register(HANDLE_JOB)
def handle_job(payload, job):
    handle_match(int(payload['hash_id']), source=payload.get('source') or 'scan',
                 outcome=outcome_from(payload.get('outcome')))


def preserved(conn, hash_id):
    """True when the hash's bytes are kept as evidence: copied to the evidence bucket, or held in
    the files bucket by an unreleased hold."""
    return conn.execute("SELECT 1 FROM evidence_holds WHERE hash_id = %s AND (bucket = 'evidence' OR "
                        'released_at IS NULL) LIMIT 1', (hash_id,)).fetchone() is not None


def evidence_client(settings):
    """boto3 with the evidence key: it can write and copy into the evidence bucket (and read the
    files bucket, the copy's source), never read or delete evidence."""
    import boto3
    from botocore.config import Config
    files = storage_module.S3Settings.from_env()
    kwargs = files.client_kwargs()
    kwargs.update(aws_access_key_id=settings.s3_evidence_access_key_id,
                  aws_secret_access_key=settings.s3_evidence_secret_access_key)
    return boto3.client('s3', config=Config(**files.config_kwargs()), **kwargs)


def evidence_key(case_id, hash_id):
    return 'csam/{}/{}'.format(case_id, hash_id)


def snowflake_seconds(value):
    return ((int(value) >> 22) + EPOCH) // 1000


def snapshot(conn, hash_id, source, outcome):
    """The evidence record (§3.6), with each file's owner, IP hash and sealed IP."""
    h = conn.execute('SELECT blake2b, sha1, md5, size FROM file_hashes WHERE id = %s', (hash_id,)).fetchone()
    files = []
    for row in conn.execute(
            'SELECT f.id, f.vanity, f.filename, f.extension, f.mimetype_id, f.visibility, f.user_id, f.guest_id, '
            'f.uploader_abuse_ip_hash, f.uploader_ip_sealed, f.view_count, u.email, u.username '
            'FROM files f LEFT JOIN users u ON u.id = f.user_id WHERE f.hash_id = %s ORDER BY f.id',
            (hash_id,)).fetchall():
        (file_id, vanity, filename, extension, mimetype, visibility, user_id, guest_id, ip_hash, sealed, views,
         email, username) = row
        files.append({
            'id': str(file_id), 'vanity': vanity, 'filename': filename + ('.' + extension if extension else ''),
            'mimetype': mimetype, 'uploaded_at': snowflake_seconds(file_id), 'visibility': visibility,
            'user_id': str(user_id) if user_id is not None else None,
            'guest_id': str(guest_id) if guest_id is not None else None,
            'account': {'email': email, 'username': username, 'created_at': snowflake_seconds(user_id)}
            if user_id is not None else None,
            'abuse_ip_hash': ip_hash.hex() if ip_hash else None,
            'ip_sealed': base64.b64encode(sealed).decode('ascii') if sealed else None,
            'views': views,
        })
    return {
        'matcher': outcome.matcher if outcome is not None else source,
        'vendor_refs': list(outcome.vendor_refs) if outcome is not None else [],
        'hits': [{'frame': hit.frame, 'list_id': hit.list_id} for hit in (outcome.hits if outcome else [])],
        'hash': {'blake2b': h[0], 'sha1': h[1], 'md5': h[2], 'size': h[3]} if h else None,
        'files': files,
    }


def block(conn, hash_id, source, outcome, actor):
    """Steps 1, 2 and 5 (with the first records of 6), in one transaction. Returns the case id."""
    from safety.scan import delete_assets_later, queue_pdq_sweep
    row = conn.execute('SELECT blake2b, sha1, md5, size, scan, scan_state, scan_reason FROM file_hashes '
                       'WHERE id = %s FOR UPDATE', (hash_id,)).fetchone()
    if row is None:
        return None
    blake2b, sha1, md5, size, document, scan_state, scan_reason = row
    document = dict(document or {'version': 1})
    checks = dict(document.get('checks') or {})
    checks['csam'] = {'result': 'match', 'matcher': outcome.matcher if outcome else source}
    document['checks'] = checks
    findings = [f for f in document.get('findings') or () if f.get('code') != 'csam_match']
    document['findings'] = findings + [{'check': 'csam', 'code': 'csam_match'}]
    already = scan_state == 'blocked' and scan_reason == 'csam_match'
    conn.execute("UPDATE file_hashes SET scan_state = 'blocked', scan_reason = 'csam_match', scan = %s::jsonb, "
                 'next_rescan_at = NULL WHERE id = %s', (json.dumps(document), hash_id))
    delete_assets_later(conn, hash_id)
    core.invalidate_collages(conn, core.albums_of_hash(conn, hash_id))
    if not already:
        # milestone-5 §5.4: conversion outputs of the hash's files are removed
        from safety import cascade
        cascade.queue(conn, 'remove', hash_id=hash_id)
    case_id = core.open_case(conn, 'hash', 0, hash_id, child_safety=True)
    # step 2: remember (PDQs of the frames that were matched)
    entry = conn.execute(
        "INSERT INTO blocked_hashes (blake2b, sha1, md5, size, reason, source) VALUES (%s, %s, %s, %s, 'csam', %s) "
        'ON CONFLICT (blake2b, sha1, md5) DO UPDATE SET reason = \'csam\' RETURNING id, (xmax = 0)',
        (blake2b, sha1, md5, size, source)).fetchone()
    blocked_id, inserted = entry
    if inserted:
        conn.execute('INSERT INTO blocked_hash_pdq (blocked_hash_id, frame, pdq, quality) '
                     'SELECT %s, frame, pdq, quality FROM file_hash_pdq WHERE hash_id = %s ON CONFLICT DO NOTHING',
                     (blocked_id, hash_id))
        queue_pdq_sweep(conn, blocked_id)
    if not already or inserted:
        details = {'matcher': outcome.matcher if outcome else source,
                   'vendor_refs': list(outcome.vendor_refs) if outcome else [],
                   'hits': [{'frame': h.frame, 'list_id': h.list_id, 'vendor_ref': h.vendor_ref}
                            for h in (outcome.hits if outcome else [])]}
        match_action = core.log_action(conn, actor, 'csam_match', rule='csam', hash_id=hash_id, case_id=case_id,
                                       details=details, child_safety=True)
        conn.execute('UPDATE blocked_hashes SET action_id = COALESCE(action_id, %s) WHERE id = %s',
                     (match_action, blocked_id))
        core.log_action(conn, actor, 'block', rule='csam', hash_id=hash_id, case_id=case_id, child_safety=True,
                        details={'blocked_hash_id': blocked_id})
    return case_id


def preserve(hash_id, case_id, source, outcome, settings, files_client, actor):
    """Step 3: copy, record, then delete from the files bucket."""
    files_bucket = storage_module.S3Settings.from_env().bucket
    blob = storage_module.blob_key(hash_id)
    with db.connect() as conn:
        hold = conn.execute("SELECT id, storage_key FROM evidence_holds WHERE hash_id = %s AND bucket = 'evidence' "
                            "AND reason = 'csam' AND released_at IS NULL", (hash_id,)).fetchone()
    if hold is None:
        key = evidence_key(case_id, hash_id)
        retain_until = core.utcnow() + timedelta(days=settings.evidence_retention_days)
        evidence_client(settings).copy(
            {'Bucket': files_bucket, 'Key': blob}, settings.s3_bucket_evidence, key,
            ExtraArgs={'ObjectLockMode': 'COMPLIANCE', 'ObjectLockRetainUntilDate': retain_until})
        with db.connect() as conn:
            with conn.transaction():
                record = snapshot(conn, hash_id, source, outcome)
                h = record['hash'] or {}
                hold_id = conn.execute(
                    "INSERT INTO evidence_holds (case_id, hash_id, blake2b, sha1, md5, size, bucket, storage_key, "
                    "reason, retain_until, snapshot) VALUES (%s, %s, %s, %s, %s, %s, 'evidence', %s, 'csam', %s, "
                    "%s::jsonb) RETURNING id",
                    (case_id, hash_id, h.get('blake2b'), h.get('sha1'), h.get('md5'), h.get('size'), key, retain_until,
                     json.dumps(record))).fetchone()[0]
                core.log_action(conn, actor, 'preserve_evidence', rule='csam', hash_id=hash_id, case_id=case_id,
                                child_safety=True, details={'hold_id': hold_id, 'bucket': 'evidence'})
    delete_all_versions(files_client, files_bucket, blob)


def delete_all_versions(client, bucket, key):
    try:
        listing = client.list_object_versions(Bucket=bucket, Prefix=key)
        for version in (listing.get('Versions') or []) + (listing.get('DeleteMarkers') or []):
            if version.get('Key') == key and version.get('VersionId'):
                client.delete_object(Bucket=bucket, Key=key, VersionId=version['VersionId'])
    except Exception:
        log.warning('listing versions of %s failed; deleting the current one', key)
    client.delete_object(Bucket=bucket, Key=key)


def restrict_uploaders(conn, hash_id, case_id, actor, guest_ids=(), user_ids=(), ip_hashes=()):
    """Step 4 (and the records of step 6): suspend owners, ban guests and IP hashes, hide
    the owners' other content. Also soft-deletes the hash's anonymous files (§2.5)."""
    from jobs.gc import after_delete
    rows = conn.execute('SELECT id, user_id, guest_id, uploader_abuse_ip_hash, deleted_at FROM files '
                        'WHERE hash_id = %s', (hash_id,)).fetchall() if hash_id is not None else []
    users = set(user_ids) | {r[1] for r in rows if r[1] is not None}
    guests = set(guest_ids) | {r[2] for r in rows if r[1] is None and r[2] is not None}
    ips = set(ip_hashes) | {bytes(r[3]) for r in rows if r[3]}
    for user_id in sorted(users):
        active = [r for r in core.active_restrictions(conn, user_id) if r[1] == 'suspended' and r[2] == 'csam']
        if not active:
            core.restrict(conn, user_id, 'suspended', 'csam', actor=actor, case_id=case_id, notify_owner=False,
                          child_safety=True)
    for guest_id in sorted(guests):
        core.ban(conn, actor, 'csam', guest_id=guest_id, source={'hash_id': str(hash_id)}, case_id=case_id,
                 child_safety=True)
    for ip_hash in sorted(ips):
        core.ban(conn, actor, 'csam', ip_hash=ip_hash, source={'hash_id': str(hash_id)}, case_id=case_id,
                 child_safety=True)
    # the hash's own anonymous files are rejected; everything else of these owners is hidden for review
    anonymous = [r[0] for r in rows if r[1] is None and r[4] is None]
    if anonymous:
        deleted = conn.execute("UPDATE files SET deleted_at = now(), deleted_reason = 'FILE_BLOCKED' WHERE "
                               'id = ANY(%s) AND deleted_at IS NULL RETURNING id, hash_id', (anonymous,)).fetchall()
        after_delete(conn, [r[0] for r in deleted], [r[1] for r in deleted])
    other = conn.execute(
        "SELECT id FROM files WHERE (user_id = ANY(%s) OR (user_id IS NULL AND guest_id = ANY(%s))) "
        "AND deleted_at IS NULL AND moderation_state = 'visible' AND hash_id IS DISTINCT FROM %s",
        (sorted(users), sorted(guests), hash_id)).fetchall()
    core.set_file_state(conn, [r[0] for r in other], 'hidden', 'csam', auto=True)
    from safety import cascade
    cascade.queue(conn, 'hide', [r[0] for r in other])
    albums = conn.execute(
        "SELECT id FROM albums WHERE (owner_user_id = ANY(%s) OR owner_guest_id = ANY(%s)) AND deleted_at IS NULL "
        "AND moderation_state = 'visible'", (sorted(users), sorted(guests))).fetchall()
    core.set_album_state(conn, [r[0] for r in albums], 'hidden', 'csam', auto=True)
    if other or albums:
        core.log_action(conn, actor, 'hide', rule='csam', case_id=case_id, child_safety=True,
                        details={'files': [str(r[0]) for r in other], 'albums': [str(r[0]) for r in albums],
                                 'automatic': True})


def handle_match(hash_id, source, outcome=None, client=None, actor=core.SYSTEM, settings=None):
    """Run every step for a matched hash. Safe to call again: each step checks what's done, and
    concurrent runs for one hash (the scan's own and its csam_handle job) wait for each other."""
    from safety.scan import s3
    settings = settings or safety_settings()
    with db.connect() as lock:
        lock.execute('SELECT pg_advisory_lock(%s::int, hashtext(%s))', (LOCK_NAMESPACE, str(hash_id)))
        try:
            with db.connect() as conn:
                with conn.transaction():
                    case_id = block(conn, hash_id, source, outcome, actor)
            if case_id is None:
                return None
            preserve(hash_id, case_id, source, outcome, settings, client or s3(), actor)
            with db.connect() as conn:
                with conn.transaction():
                    restrict_uploaders(conn, hash_id, case_id, actor)
        finally:
            lock.execute('SELECT pg_advisory_unlock(%s::int, hashtext(%s))', (LOCK_NAMESPACE, str(hash_id)))
    log.warning('hash %s blocked as a CSAM match (case %s)', hash_id, case_id)
    return case_id


def reupload(conn, entry_id, user_id=None, guest_id=None, ip_hash=None, attempt=None):
    """§2.5 step 1 for a `csam` entry: the uploader steps of §3.6 (restriction, bans, a P0 case
    with the attempt's metadata). The bytes are already preserved; nothing is stored."""
    existing = conn.execute('SELECT h.id FROM blocked_hashes b JOIN file_hashes h ON h.blake2b = b.blake2b '
                            'AND h.sha1 = b.sha1 AND h.md5 = b.md5 WHERE b.id = %s', (entry_id,)).fetchone()
    hash_id = existing[0] if existing else None
    if hash_id is not None:
        case_id = core.open_case(conn, 'hash', 0, hash_id, child_safety=True)
    elif user_id is not None:
        case_id = core.open_case(conn, 'user', 0, user_id, child_safety=True)
    else:
        case_id = core.open_case(conn, 'hash', 0, None, child_safety=True)
    core.log_action(conn, core.SYSTEM, 'csam_match', rule='csam', hash_id=hash_id, user_id=user_id, case_id=case_id,
                    child_safety=True, details={'reupload': True, 'blocked_hash_id': str(entry_id),
                                                'attempt': attempt or {}})
    restrict_uploaders(conn, None, case_id, core.SYSTEM, guest_ids=[guest_id] if guest_id else [],
                       user_ids=[user_id] if user_id else [], ip_hashes=[ip_hash] if ip_hash else [])
    return case_id
