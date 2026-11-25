"""The `scan` and `rescan` jobs (contract milestone-4 §2): publication gating for every new hash.

    scan    {"hash_id"}               queue `scan`   (the `scanner` service, WORKER_QUEUES=scan)
    rescan  {"hash_id", "checks"}     queue `rescan` (the `rescanner` service, WORKER_QUEUES=rescan)

Strict order: `scan` -> (`passed` or `flagged`) -> `probe` -> `derive`. Split as the media jobs:
the sandboxed child (`python -m media.process scan`, media/scanning.py) parses the upload; this
process talks to every service (blocked_hashes, the HashMatcher, ClamAV, Web Risk) and writes the
results in one transaction.

Failing closed (§2.6): every check but Web Risk is required. An error raises, the job retries
(10 attempts, the queue's backoff) and the hash stays `pending`; the `scan_sweeper` re-queues
any pending hash without a runnable scan, so nothing is ever published by giving up.
"""

import json
import logging
import os
import shutil
import sys
import tempfile

from datetime import datetime, timedelta, timezone

import db
from jobs.queue import register
from media import sandbox
from safety import core, csam
from safety.settings import safety_settings
from utils import storage as storage_module

log = logging.getLogger(__name__)

QUEUE = 'scan'
RESCAN_QUEUE = 'rescan'
MAX_ATTEMPTS = 10
API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP_DIR = os.getenv('MEDIA_TMP_DIR') or None
MEDIA_KINDS = ('image', 'animated', 'video', 'audio')
MATCHED_KINDS = ('image', 'animated', 'video')
RESCAN_CHECKS = ('clamav', 'csam', 'pdq', 'web_risk')

# §2.3: (code, state), strongest state wins, then the first code in this order
CODES = (
    ('csam_match', 'blocked'), ('hash_list', 'blocked'), ('pdq_near_match', 'held'), ('malware', 'blocked'),
    ('unwanted_software', 'flagged'), ('blocked_type', 'blocked'), ('archive_bomb', 'blocked'),
    ('pdf_dangerous', 'blocked'), ('pdf_javascript', 'flagged'), ('polyglot_archive', 'flagged'),
    ('web_risk', 'flagged'),
)
CODE_STATE = dict(CODES)
CODE_ORDER = [code for code, _ in CODES]
STRENGTH = {'pending': 0, 'passed': 1, 'flagged': 2, 'held': 3, 'blocked': 4}
# the rule a scan block's notice cites (§8.1)
BLOCK_RULES = {'malware': 'malware', 'blocked_type': 'malware', 'archive_bomb': 'malware', 'pdf_dangerous': 'malware',
               'hash_list': 'other'}
HASH_LIST_RULES = {'csam': 'csam', 'ncii': 'ncii', 'terrorism': 'violence', 'malware': 'malware', 'moderator': 'other'}
# an anonymous file of a blocked hash is soft-deleted with this (§2.5)
REJECTIONS = {'malware': 'MALWARE_DETECTED', 'blocked_type': 'FILE_TYPE_NOT_ALLOWED'}


# --- queueing ---------------------------------------------------------------------------------------------

ENQUEUE_SCAN_SQL = (
    "INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) "
    "SELECT 'scan', %s::jsonb, now() + make_interval(secs => %s::float8), %s, 'scan' "
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s "
    "AND done_at IS NULL AND failed_at IS NULL) RETURNING id")


def _scan_params(hash_id, delay=0):
    return (json.dumps({'hash_id': str(hash_id)}), delay, MAX_ATTEMPTS, str(hash_id))


def queue_scan(conn, hash_id, delay=0):
    """One runnable `scan` per hash (NOT EXISTS deduplication, like album_collage)."""
    return conn.execute(ENQUEUE_SCAN_SQL, _scan_params(hash_id, delay)).fetchone()


async def queue_scan_async(conn, hash_id, delay=0):
    cursor = await conn.execute(ENQUEUE_SCAN_SQL, _scan_params(hash_id, delay))
    return await cursor.fetchone()


def queue_rescan(conn, hash_id, checks, delay=0):
    """A `rescan` on the rescan queue; a waiting one for the same hash takes the union of checks."""
    checks = sorted(set(checks) & set(RESCAN_CHECKS))
    if not checks:
        return None
    waiting = conn.execute("SELECT id, payload FROM jobs WHERE kind = 'rescan' AND payload->>'hash_id' = %s "
                           "AND done_at IS NULL AND failed_at IS NULL AND locked_by IS NULL LIMIT 1 FOR UPDATE",
                           (str(hash_id),)).fetchone()
    if waiting is not None:
        merged = sorted(set(waiting[1].get('checks') or ()) | set(checks))
        conn.execute("UPDATE jobs SET payload = %s::jsonb, run_at = LEAST(run_at, now() + make_interval("
                     "secs => %s::float8)) WHERE id = %s",
                     (json.dumps({'hash_id': str(hash_id), 'checks': merged}), delay, waiting[0]))
        return waiting[0]
    return conn.execute("INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) VALUES ('rescan', %s::jsonb, "
                        "now() + make_interval(secs => %s::float8), %s, 'rescan') RETURNING id",
                        (json.dumps({'hash_id': str(hash_id), 'checks': checks}), delay, MAX_ATTEMPTS)).fetchone()[0]


# --- services (tests replace these) ---------------------------------------------------------------------

def get_matcher():
    from safety.matchers import get_matcher as configured
    return configured()


def get_clamav():
    from safety.clamav import ClamAV
    return ClamAV.from_settings(safety_settings())


def get_webrisk():
    from safety.webrisk import WebRisk
    return WebRisk.from_settings(safety_settings())


_s3 = None


def s3():
    global _s3
    if _s3 is None:
        _s3 = storage_module.sync_client()
    return _s3


def bucket():
    return storage_module.S3Settings.from_env().bucket


# --- outcomes ------------------------------------------------------------------------------------------------

def outcome(findings):
    """(state, reason) of a list of findings: `passed` with none."""
    if not findings:
        return 'passed', None
    codes = {f['code'] for f in findings}
    state = max((CODE_STATE[c] for c in codes), key=STRENGTH.get)
    reason = next(c for c in CODE_ORDER if c in codes and CODE_STATE[c] == state)
    return state, reason


def is_cleared(finding, cleared):
    return any(c.get('check') == finding['check'] and c.get('detail') == finding.get('detail') for c in cleared or ())


# --- the child ---------------------------------------------------------------------------------------------

class ScanFailed(Exception):
    pass


def run_child(path, outdir, hints, settings):
    hints = dict(hints, budget=settings.scan_wall - 5)
    cmd = [sys.executable, '-s', '-m', 'media.process', 'scan', path, outdir, json.dumps(hints)]
    try:
        out = sandbox.run(cmd, timeout=settings.scan_wall, cpu_seconds=settings.scan_cpu, cwd=API_DIR,
                          env=sandbox.clean_env(PYTHONPATH=API_DIR, TMPDIR=outdir, HOME=outdir),
                          address_space=settings.scan_address_space)
    except (sandbox.Failed, sandbox.Timeout) as error:
        raise ScanFailed('scan child failed: {}'.format(error))
    lines = [line for line in (out or b'').splitlines() if line.strip()]
    try:
        result = json.loads(lines[-1])
    except (IndexError, ValueError):
        raise ScanFailed('scan child printed no result')
    if not isinstance(result, dict) or 'error' in result:
        raise ScanFailed('scan child: {}'.format(result.get('error') if isinstance(result, dict) else result))
    return result


def load(conn, hash_id):
    row = conn.execute('SELECT id, blake2b, sha1, md5, size, scan_state, scan_reason, scan, nsfw_auto '
                       'FROM file_hashes WHERE id = %s', (hash_id,)).fetchone()
    if row is None:
        return None
    files = conn.execute('SELECT id, mimetype_id, extension, filename FROM files WHERE hash_id = %s ORDER BY id '
                         'LIMIT 20', (hash_id,)).fetchall()
    extensions = sorted({f[2].lower() for f in files if f[2]})
    by_extension = [r[0] for r in conn.execute(
        'SELECT DISTINCT ON (extension) mimetype_id FROM mimetype_extensions WHERE extension = ANY(%s) '
        'ORDER BY extension, ctid', (extensions,)).fetchall()] if extensions else []
    keys = ('id', 'blake2b', 'sha1', 'md5', 'size', 'scan_state', 'scan_reason', 'scan', 'nsfw_auto')
    info = dict(zip(keys, row))
    info['hints'] = {
        'mimetype': files[0][1] if files else None,
        'extension': files[0][2] if files else None,
        'filename': (files[0][3] + ('.' + files[0][2] if files[0][2] else '')) if files else None,
        'filenames': [f[3] + ('.' + f[2] if f[2] else '') for f in files[1:]],
        'types': sorted({f[1] for f in files} | set(by_extension)),
    }
    return info


def child_hints(info, settings, nsfw=True):
    return dict(info['hints'], nsfw=nsfw,
                archive_max_entries=settings.archive_max_entries, archive_max_depth=settings.archive_max_depth,
                archive_max_unpacked=settings.archive_max_unpacked, archive_max_ratio=settings.archive_max_ratio,
                archive_max_matched_images=settings.archive_max_matched_images,
                archive_max_image_bytes=settings.archive_max_image_bytes)


def match_images(child, outdir):
    from safety.matchers import MatchImage
    pdq = {p['frame']: p for p in child.get('pdq') or ()}
    out = []
    for item in child.get('images') or ():
        name = os.path.basename(item['file'])
        with open(os.path.join(outdir, name), 'rb') as handle:
            jpeg = handle.read()
        entry = pdq.get(item['frame']) or {}
        out.append(MatchImage(frame=item['frame'], source=item['source'], jpeg=jpeg, width=item['width'],
                              height=item['height'], pdq=entry.get('hash'), pdq_quality=entry.get('quality')))
    return out


def pdq_near(conn, hashes, settings):
    """Blocked PDQs within PDQ_MATCH_DISTANCE of these [(frame, hex, quality)] (quality >= 50 on
    both sides): [(frame, blocked_hash_id, reason, distance)]."""
    from safety.pdq import MIN_QUALITY, to_bits
    hits = []
    for frame, hex_hash, quality in hashes:
        if quality < MIN_QUALITY:
            continue
        for blocked_id, reason, distance in conn.execute(
                'SELECT b.id, b.reason, bit_count(p.pdq # %s::bit(256)) AS d FROM blocked_hash_pdq p '
                'JOIN blocked_hashes b ON b.id = p.blocked_hash_id WHERE p.quality >= %s '
                'AND bit_count(p.pdq # %s::bit(256)) <= %s ORDER BY d LIMIT 5',
                (to_bits(hex_hash), MIN_QUALITY, to_bits(hex_hash), settings.pdq_match_distance)).fetchall():
            hits.append((frame, blocked_id, reason, distance))
    return hits


# --- the scan ------------------------------------------------------------------------------------------------

class Workspace:
    def __init__(self, hash_id):
        self.dir = tempfile.mkdtemp(prefix='scan-{}-'.format(hash_id), dir=TMP_DIR)
        self.input = os.path.join(self.dir, 'input')
        self.out = os.path.join(self.dir, 'out')
        os.mkdir(self.out, 0o700)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        shutil.rmtree(self.dir, ignore_errors=True)
        return False


def run_checks(info, checks, client, settings, rescan=False):
    """Run the named checks. Returns (results, findings, warnings, link_warnings, extra)."""
    results, findings, warnings, link_warnings = {}, [], [], []
    extra = {'pdq': None, 'nsfw': None, 'kind': (info.get('scan') or {}).get('kind'), 'decodable': None,
             'sniffed': (info.get('scan') or {}).get('sniffed'), 'csam': None}
    size = info['size']
    with db.connect() as conn:
        if 'hash_list' in checks:
            row = conn.execute('SELECT id, reason FROM blocked_hashes WHERE blake2b = %s AND sha1 = %s AND md5 = %s',
                               (info['blake2b'], info['sha1'], info['md5'])).fetchone()
            results['hash_list'] = {'result': 'match' if row else 'clean'}
            if row:
                findings.append({'check': 'hash_list', 'code': 'hash_list', 'detail': row[1]})
                extra['hash_list'] = {'id': row[0], 'reason': row[1]}
    needs_child = bool({'csam', 'web_risk', 'content'} & set(checks))
    needs_blob = needs_child or 'clamav' in checks
    with Workspace(info['id']) as space:
        if needs_blob:
            client.download_file(bucket(), storage_module.blob_key(info['id']), space.input)
        child = None
        if needs_child:
            child = run_child(space.input, space.out, child_hints(info, settings, nsfw='nsfw' in checks), settings)
            extra['kind'] = child.get('kind')
            extra['sniffed'] = child.get('sniffed')
            extra['decodable'] = child.get('decodable')
        if 'csam' in checks:
            images = match_images(child, space.out)
            extra['pdq'] = [(p['frame'], p['hash'], p['quality']) for p in child.get('pdq') or ()]
            if images:
                matched = get_matcher().match(images, blake2b=info['blake2b'])
                results['csam'] = {'result': 'match' if matched.hits else 'clean', 'matcher': matched.matcher,
                                   'images': len(images), 'unmatchable': len(matched.unmatchable)}
                if matched.hits:
                    findings.append({'check': 'csam', 'code': 'csam_match'})
                    extra['csam'] = matched
            else:
                results['csam'] = {'result': 'skipped', 'images': 0}
        if 'pdq' in checks:
            hashes = extra['pdq']
            if hashes is None:
                with db.connect() as conn:
                    from safety.pdq import from_bits
                    hashes = [(r[0], from_bits(r[1]), r[2]) for r in conn.execute(
                        'SELECT frame, pdq::text, quality FROM file_hash_pdq WHERE hash_id = %s ORDER BY frame',
                        (info['id'],)).fetchall()]
            with db.connect() as conn:
                near = pdq_near(conn, hashes, settings)
            results['pdq'] = {'result': 'match' if near else 'clean', 'frames': len(hashes)}
            if near and not extra['csam']:
                frame, blocked_id, reason, distance = near[0]
                findings.append({'check': 'pdq', 'code': 'pdq_near_match', 'detail': 'blocked:{}'.format(blocked_id)})
                extra['pdq_near'] = {'blocked_hash_id': blocked_id, 'reason': reason, 'distance': distance,
                                     'frame': frame}
        if child is not None and 'nsfw' in checks:
            nsfw = child.get('nsfw')
            if nsfw and nsfw.get('classified'):
                results['nsfw'] = {'result': 'done', 'score': round(float(nsfw['score']), 4),
                                   'classified': nsfw['classified'], 'model': nsfw['model']}
                extra['nsfw'] = float(nsfw['score'])
            else:
                results['nsfw'] = {'result': 'skipped'}
        if 'clamav' in checks:
            results['clamav'] = clamav_check(space.input, size, extra['kind'], settings, findings, warnings)
        if child is not None and 'content' in checks:
            content_checks(child, results, findings, warnings)
        if child is not None and 'web_risk' in checks:
            result, hits = get_webrisk().check(child.get('urls') or [])
            results['web_risk'] = result
            if hits:
                findings.append({'check': 'web_risk', 'code': 'web_risk', 'detail': hits[0]['url'][:500]})
                link_warnings += hits
            if result['result'] != 'skipped':
                extra['web_risk_ran'] = True
    return results, findings, warnings, link_warnings, extra


def clamav_check(path, size, kind, settings, findings, warnings):
    from safety.clamav import PARTIALLY_SCANNED, classify
    if size > settings.clamav_max_bytes:
        if kind not in MEDIA_KINDS:
            warnings.append('too_large_to_scan')
        return {'result': 'skipped', 'reason': 'too_large'}
    clamav = get_clamav()
    version = clamav.version()
    signature = clamav.scan_file(path)
    result = {'result': 'detected' if signature else 'clean', 'engine': version.get('engine'), 'db': version.get('db')}
    if signature:
        code = classify(signature, settings.clamav_flag_only_prefixes)
        result['signature'] = signature
        if code == PARTIALLY_SCANNED:
            # over clamd's limits: scanned partially, with a warning (§5.3), not a detection
            result['result'] = 'clean'
            result['partial'] = True
            warnings.append(PARTIALLY_SCANNED)
            return result
        findings.append({'check': 'clamav', 'code': code, 'detail': signature})
        if code == 'unwanted_software':
            warnings.append('unwanted_software')
    return result


def content_checks(child, results, findings, warnings):
    """Archive, Office, PDF and polyglot findings (§5.3-§5.5), and blocked sniffed types (§5.1)."""
    for blocked in child.get('blocked_types') or ():
        findings.append({'check': 'type', 'code': 'blocked_type', 'detail': blocked})
    archive = child.get('archive')
    if archive is None:
        results['archive'] = {'result': 'skipped'}
    else:
        result = {'result': 'clean', 'entries': archive['entries'], 'partial': archive['partial'],
                  'encrypted': archive['encrypted'], 'depth': archive['depth']}
        if archive.get('unreadable'):
            result['unreadable'] = True
        if archive['bomb']:
            result['result'] = 'block'
            findings.append({'check': 'archive', 'code': 'archive_bomb', 'detail': str(archive['unpacked'])})
        if archive['blocked']:
            result['result'] = 'block'
            findings.append({'check': 'archive', 'code': 'blocked_type', 'detail': archive['blocked'][0][:200]})
        if archive['encrypted']:
            warnings.append('encrypted_archive')
        if archive['partial']:
            warnings.append('archive_partially_scanned')
        results['archive'] = result
    office = child.get('office')
    if office is None:
        results['office'] = {'result': 'skipped'}
    else:
        results['office'] = {'result': 'block' if office['blocked'] else 'clean'}
        if office['blocked']:
            kinds = [k for k in ('vba', 'xlm', 'dde') if office.get(k)] + (['external'] if office['external'] else [])
            findings.append({'check': 'office', 'code': 'blocked_type', 'detail': ','.join(kinds)})
    pdf = child.get('pdf')
    if pdf is None:
        results['pdf'] = {'result': 'skipped'}
    else:
        result = {'result': 'clean'}
        if pdf.get('encrypted'):
            # a user password: its streams couldn't be checked (§5.3's rule for encrypted archives)
            result['encrypted'] = True
            warnings.append('encrypted_pdf')
        if pdf['javascript']:
            result['result'] = 'flag'
            findings.append({'check': 'pdf', 'code': 'pdf_javascript', 'detail': ','.join(pdf['javascript'])})
        if pdf['dangerous']:
            result['result'] = 'block'
            findings.append({'check': 'pdf', 'code': 'pdf_dangerous', 'detail': ','.join(pdf['dangerous'])})
        results['pdf'] = result
    for item in child.get('polyglot') or ():
        findings.append({'check': 'polyglot', 'code': 'polyglot_archive',
                         'detail': '{}+{}'.format(item['container'], item['archive'])})


def next_rescan(kind, first_at, now, initial):
    """§2.7: non-media kinds at +24 h then +7 d; images, animated files and videos at +7 d; then none."""
    if kind in MATCHED_KINDS:
        return now + timedelta(days=7) if initial else None
    if kind in MEDIA_KINDS:
        return None
    if initial:
        return now + timedelta(hours=24)
    seventh = first_at + timedelta(days=7)
    return seventh if seventh > now + timedelta(hours=1) else None


def scan(hash_id, job=None, client=None):
    """The first scan of a hash. Returns its new state (or the current one if it isn't pending)."""
    settings = safety_settings()
    with db.connect() as conn:
        info = load(conn, hash_id)
    if info is None:
        return None
    if info['scan_state'] != 'pending':
        return info['scan_state']
    checks = ('hash_list', 'csam', 'pdq', 'nsfw', 'clamav', 'content', 'web_risk')
    results, findings, warnings, link_warnings, extra = run_checks(info, checks, client or s3(), settings)
    state, reason = outcome(findings)
    nsfw_score = extra['nsfw']
    nsfw_auto = nsfw_score is not None and nsfw_score >= settings.nsfw_threshold
    kind = extra['kind'] or 'other'
    now = core.utcnow()
    document = {
        'version': 1, 'at': int(now.timestamp()), 'first_at': int(now.timestamp()), 'kind': kind,
        'sniffed': extra['sniffed'], 'decodable': extra['decodable'], 'checks': results,
        'findings': findings, 'cleared': [], 'warnings': sorted(set(warnings)), 'link_warnings': link_warnings[:20],
    }
    serve_inline = not (extra['decodable'] is False and kind in ('image', 'animated', 'video'))
    matched_csam = reason == 'csam_match' or (
        reason == 'hash_list' and (extra.get('hash_list') or {}).get('reason') == 'csam')
    # a re-scan of content already listed keeps its entry; a new match records the matcher
    csam_source = extra['csam'].matcher if extra['csam'] else 'staff'
    handle_job = None
    with db.connect() as conn:
        with conn.transaction():
            updated = conn.execute(
                'UPDATE file_hashes SET scan_state = %s, scan_reason = %s, scan = %s::jsonb, scanned_at = now(), '
                'next_rescan_at = %s, nsfw_score = %s, nsfw_auto = %s, serve_inline = %s '
                "WHERE id = %s AND scan_state = 'pending' RETURNING id",
                (state, reason, json.dumps(document), None if state == 'blocked' else next_rescan(
                    kind, now, now, True), nsfw_score, nsfw_auto, serve_inline, hash_id)).fetchone()
            if updated is None:
                return None
            store_pdq(conn, hash_id, extra['pdq'] or [])
            apply_outcome(conn, hash_id, state, reason, findings, warnings, nsfw_auto, extra, source='scan',
                          public_before=False)
            if matched_csam:
                # committed with the match, so §3.6 runs even if this process dies or the steps fail
                handle_job = csam.queue_handle(conn, hash_id, csam_source, extra['csam'])
    if matched_csam:
        csam.handle_now(hash_id, csam_source, extra['csam'], handle_job, client=client)
    log.info('scanned hash %s: %s %s', hash_id, state, reason or '')
    return state


def store_pdq(conn, hash_id, hashes):
    from safety.pdq import to_bits
    conn.execute('DELETE FROM file_hash_pdq WHERE hash_id = %s', (hash_id,))
    for frame, hex_hash, quality in hashes:
        conn.execute('INSERT INTO file_hash_pdq (hash_id, frame, pdq, quality) VALUES (%s, %s, %s::bit(256), %s)',
                     (hash_id, frame, to_bits(hex_hash), quality))


def apply_outcome(conn, hash_id, state, reason, findings, warnings, nsfw_auto, extra, source, public_before):
    """What a scan result does to the hash's files (§2.5, §2.7, §8.1), in the result's transaction."""
    files = conn.execute('SELECT id, user_id, fingerprint, nsfw_marked, nsfw_override FROM files WHERE hash_id = %s '
                         'AND deleted_at IS NULL ORDER BY id', (hash_id,)).fetchall()
    csam = reason == 'csam_match' or (reason == 'hash_list' and (extra.get('hash_list') or {}).get('reason') == 'csam')
    if state in ('passed', 'flagged'):
        core.queue_probe(conn, hash_id)
    if state == 'flagged':
        action_id = core.log_action(conn, core.SYSTEM, 'scan_flag', hash_id=hash_id, details={'reason': reason})
        for finding in findings:
            if CODE_STATE[finding['code']] == 'flagged':
                core.flag_hash(conn, hash_id, source, finding['code'], details=finding)
    if state == 'held':
        near = extra.get('pdq_near') or {}
        child_safety = near.get('reason') == 'csam'
        case_id = core.flag_hash(conn, hash_id, source, 'pdq_near_match', details=near, child_safety=child_safety,
                                 priority=0 if child_safety else 1)
        core.log_action(conn, core.SYSTEM, 'scan_hold', hash_id=hash_id, case_id=case_id,
                        details={'reason': reason}, child_safety=child_safety)
        if public_before:
            core.invalidate_collages(conn, core.albums_of_hash(conn, hash_id))
            for file_id, user_id, _, _, _ in files:
                core.notify(conn, user_id, 'scan_hold', 'other', core.file_target(conn, file_id),
                            appealable=False) if not child_safety else None
    if state == 'blocked':
        if not csam:
            rule = HASH_LIST_RULES.get((extra.get('hash_list') or {}).get('reason')) if reason == 'hash_list' \
                else BLOCK_RULES.get(reason, 'malware')
            case_id = core.flag_hash(conn, hash_id, source, reason, details={'findings': findings}) \
                if public_before else None
            action_id = core.log_action(conn, core.SYSTEM, 'scan_block', rule=rule, hash_id=hash_id, case_id=case_id,
                                        details={'reason': reason})
            for file_id, user_id, _, _, _ in files:
                if user_id is not None:
                    core.notify(conn, user_id, 'scan_block', rule, core.file_target(conn, file_id),
                                appealable=True, strike=False, action_id=action_id)
        if public_before:
            core.invalidate_collages(conn, core.albums_of_hash(conn, hash_id))
            delete_assets_later(conn, hash_id)
    # rejections after the fact (§2.5): anonymous files
    anonymous = [f[0] for f in files if f[1] is None]
    if anonymous:
        rejection = None
        if state == 'blocked':
            rejection = REJECTIONS.get(reason, 'FILE_BLOCKED')
        elif nsfw_auto:
            rejection = 'NSFW_REQUIRES_ACCOUNT'
        elif 'encrypted_archive' in warnings:
            rejection = 'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT'
        elif 'encrypted_pdf' in warnings:
            rejection = 'ENCRYPTED_PDF_REQUIRES_ACCOUNT'
        if rejection is not None:
            core.soft_delete_files(conn, anonymous, rejection)
    # signed-in files the classifier marked that their uploaders hadn't (§4.3)
    if nsfw_auto and state != 'blocked':
        unmarked = [(f[0], f[1]) for f in files if f[1] is not None and not f[3] and f[4] is None]
        for file_id, user_id in unmarked:
            conn.execute('UPDATE files SET nsfw_unmarked_at = now() WHERE id = %s AND nsfw_unmarked_at IS NULL',
                         (file_id,))
        for user_id in sorted({u for _, u in unmarked}):
            check_unmarked_rule(conn, user_id)


def check_unmarked_rule(conn, user_id, settings=None):
    """3 files auto-marked NSFW that their uploader hadn't marked, in 30 days, give an automatic
    notice (rule adult_unmarked, a strike, appealable); counting restarts after each notice."""
    settings = settings or safety_settings()
    last = conn.execute("SELECT max(created_at) FROM user_warnings WHERE user_id = %s AND rule = 'adult_unmarked' "
                        "AND action = 'adult_unmarked'", (user_id,)).fetchone()[0]
    since = core.utcnow() - timedelta(days=30)
    if last is not None and last > since:
        since = last
    count = conn.execute('SELECT count(*) FROM files WHERE user_id = %s AND nsfw_unmarked_at > %s',
                         (user_id, since)).fetchone()[0]
    if count >= settings.nsfw_unmarked_warn:
        action_id = core.log_action(conn, core.SYSTEM, 'adult_unmarked', rule='adult_unmarked', user_id=user_id,
                                    details={'files': count})
        core.notify(conn, user_id, 'adult_unmarked', 'adult_unmarked', core.account_target(user_id),
                    appealable=True, strike=True, action_id=action_id)


def delete_assets_later(conn, hash_id):
    """Previews of content that's no longer public go (a rescan block or hold): rows now, the
    objects through `delete_assets`."""
    keys = [r[0] for r in conn.execute('DELETE FROM file_hash_assets WHERE hash_id = %s RETURNING storage_key',
                                       (hash_id,)).fetchall()]
    conn.execute("UPDATE file_hashes SET processing_state = 'skipped', derived_at = NULL WHERE id = %s", (hash_id,))
    if keys:
        conn.execute("INSERT INTO jobs (kind, payload, queue, max_attempts) VALUES ('delete_objects', %s::jsonb, "
                     "'default', 5)", (json.dumps({'keys': keys}),))


@register('delete_objects')
def delete_objects_job(payload, job):
    client = s3()
    for key in payload.get('keys') or ():
        client.delete_object(Bucket=bucket(), Key=key)


@register('scan')
def scan_job(payload, job):
    scan(int(payload['hash_id']), job)


# --- rescans (§2.7) --------------------------------------------------------------------------------------------

def rescan(hash_id, checks, job=None, client=None):
    """Run only `checks`; it can only escalate, and findings staff cleared are ignored."""
    settings = safety_settings()
    checks = [c for c in checks if c in RESCAN_CHECKS]
    with db.connect() as conn:
        info = load(conn, hash_id)
    if info is None or info['scan_state'] in ('pending', 'blocked') or not checks:
        return info and info['scan_state']
    document = dict(info['scan'] or {})
    cleared = document.get('cleared') or []
    results, findings, warnings, link_warnings, extra = run_checks(info, checks, client or s3(), settings, rescan=True)
    findings = [f for f in findings if not is_cleared(f, cleared)]
    state, reason = outcome(findings)
    now = core.utcnow()
    document['checks'] = dict(document.get('checks') or {}, **results)
    document['at'] = int(now.timestamp())
    first = datetime.fromtimestamp(document['first_at'], tz=timezone.utc) if document.get('first_at') else now
    with db.connect() as conn:
        with conn.transaction():
            current = conn.execute('SELECT scan_state, next_rescan_at FROM file_hashes WHERE id = %s FOR UPDATE',
                                   (hash_id,)).fetchone()
            if current is None or current[0] in ('pending', 'blocked'):
                return current and current[0]
            escalates = STRENGTH[state] > STRENGTH[current[0]]
            if escalates:
                document['findings'] = (document.get('findings') or []) + findings
                document['warnings'] = sorted(set(document.get('warnings') or ()) | set(warnings))
            if extra.get('web_risk_ran'):
                # a fresh Web Risk answer replaces the stored matches (with their new expireTime)
                document['link_warnings'] = link_warnings[:20]
            # the "scanned partially" warnings hold whatever the outcome
            partial = {'too_large_to_scan', 'archive_partially_scanned'} & set(warnings)
            if not escalates and partial:
                document['warnings'] = sorted(set(document.get('warnings') or ()) | partial)
            scheduled = current[1] is not None and current[1] <= now + timedelta(minutes=10)
            next_at = next_rescan(document.get('kind'), first, now, False) if scheduled else current[1]
            conn.execute('UPDATE file_hashes SET scan = %s::jsonb, scanned_at = now(), next_rescan_at = %s{} '
                         'WHERE id = %s'.format(', scan_state = %s, scan_reason = %s' if escalates else ''),
                         [json.dumps(document), None if escalates and state == 'blocked' else next_at] +
                         ([state, reason] if escalates else []) + [hash_id])
            if escalates:
                apply_outcome(conn, hash_id, state, reason, findings, warnings, False, extra, source='rescan',
                              public_before=True)
            handle_job = None
            if escalates and reason == 'csam_match':
                handle_job = csam.queue_handle(conn, hash_id, extra['csam'].matcher, extra['csam'])
    if escalates and reason == 'csam_match':
        csam.handle_now(hash_id, extra['csam'].matcher, extra['csam'], handle_job, client=client)
    return state if escalates else info['scan_state']


@register('rescan')
def rescan_job(payload, job):
    rescan(int(payload['hash_id']), payload.get('checks') or [], job)


# --- the sweeper, the scheduler and the PDQ sweep (§2.6, §2.7) -------------------------------------------------

DEFAULT_MAX_FAILURES = 5


def max_failures():
    """SCAN_MAX_FAILURES: scan jobs that may fail (each after MAX_ATTEMPTS attempts) before the hash is
    held for staff instead of re-queued."""
    return max(1, int(os.getenv('SCAN_MAX_FAILURES', DEFAULT_MAX_FAILURES)))


def sweep(conn):
    """Re-queue every pending hash with no runnable scan job (failed after 10 attempts, or lost),
    counting each as a failure. At SCAN_MAX_FAILURES the hash isn't re-queued: it stays pending
    (failing closed) and is held for staff, with a `scan_failing` flag (P1) on its case."""
    limit = max_failures()
    rows = conn.execute(
        "SELECT h.id FROM file_hashes h WHERE h.scan_state = 'pending' AND h.scan_stuck_at IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM jobs j "
        "WHERE j.kind = 'scan' AND j.payload->>'hash_id' = h.id::text AND j.done_at IS NULL AND j.failed_at IS NULL) "
        "AND EXISTS (SELECT 1 FROM files f WHERE f.hash_id = h.id) LIMIT 1000").fetchall()
    requeued = 0
    for (hash_id,) in rows:
        with conn.transaction():
            row = conn.execute("UPDATE file_hashes SET scan_failures = scan_failures + 1 WHERE id = %s "
                               "AND scan_state = 'pending' AND scan_stuck_at IS NULL RETURNING scan_failures",
                               (hash_id,)).fetchone()
            if row is None:
                continue
            if row[0] >= limit:
                hold_failing(conn, hash_id, row[0])
            else:
                queue_scan(conn, hash_id)
                requeued += 1
    return requeued


def hold_failing(conn, hash_id, failures):
    """Stop retrying a scan that keeps failing: the hash stays pending (nothing is published) and
    staff get a P1 `scan_failing` flag with the last error."""
    last = conn.execute("SELECT last_error FROM jobs WHERE kind = 'scan' AND payload->>'hash_id' = %s "
                        'ORDER BY id DESC LIMIT 1', (str(hash_id),)).fetchone()
    detail = {'failures': failures, 'last_error': ((last and last[0]) or 'no scan job')[:1000]}
    conn.execute('UPDATE file_hashes SET scan_stuck_at = now() WHERE id = %s', (hash_id,))
    case_id = core.flag_hash(conn, hash_id, 'scan', 'scan_failing', details=detail, priority=1)
    core.log_action(conn, core.SYSTEM, 'scan_hold', hash_id=hash_id, case_id=case_id,
                    details={'reason': 'scan_failing', 'failures': failures})
    log.error('scan of hash %s failed %d times; held for staff (case %s)', hash_id, failures, case_id)
    return case_id


def retry_failing(conn, hash_id):
    """Staff: try a held hash's scan again (counting restarts)."""
    conn.execute("UPDATE file_hashes SET scan_failures = 0, scan_stuck_at = NULL WHERE id = %s "
                 "AND scan_state = 'pending'", (hash_id,))
    return queue_scan(conn, hash_id)


def schedule_rescans(conn, limit=1000):
    """Queue due rescans for live hashes, at most `limit` a run, spread over the next 10 minutes."""
    rows = conn.execute(
        "SELECT h.id, h.scan->>'kind', h.scan->'checks'->'web_risk'->>'result', h.scan->>'first_at', "
        "jsonb_array_length(COALESCE(h.scan->'link_warnings', '[]'::jsonb)) > 0 "
        "FROM file_hashes h WHERE h.next_rescan_at <= now() AND h.scan_state IN ('passed', 'flagged', 'held') "
        "AND EXISTS (SELECT 1 FROM files f WHERE f.hash_id = h.id AND f.deleted_at IS NULL) "
        "AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'rescan' AND j.payload->>'hash_id' = h.id::text "
        "AND j.done_at IS NULL AND j.failed_at IS NULL) ORDER BY h.next_rescan_at LIMIT %s", (limit,)).fetchall()
    for index, (hash_id, kind, web_risk, first_at, has_matches) in enumerate(rows):
        if kind in MATCHED_KINDS:
            checks = ['csam', 'pdq']
        else:
            checks = ['clamav']
            first = int(first_at or 0)
            # +24 h: again when it was skipped; and whenever stored matches need a fresh expireTime
            if (web_risk == 'skipped' and core.utcnow().timestamp() < first + 2 * 86400) or has_matches:
                checks.append('web_risk')
        queue_rescan(conn, hash_id, checks, delay=600 * index / max(1, len(rows)))
    # albums whose Web Risk matches expired get their text checked again
    for (album_id,) in conn.execute(
            "SELECT id FROM albums WHERE deleted_at IS NULL AND jsonb_array_length(link_warnings) > 0 AND EXISTS ("
            "SELECT 1 FROM jsonb_array_elements(link_warnings) m WHERE (m->>'expires_at')::bigint <= "
            "extract(epoch FROM now())) LIMIT %s", (limit,)).fetchall():
        conn.execute(ENQUEUE_ALBUM_TEXT_SQL, (json.dumps({'album_id': str(album_id)}), str(album_id)))
    return len(rows)


def queue_pdq_sweep(conn, blocked_hash_id):
    conn.execute("INSERT INTO jobs (kind, payload, queue, max_attempts) VALUES ('pdq_sweep', %s::jsonb, 'rescan', %s)",
                 (json.dumps({'blocked_hash_id': str(blocked_hash_id)}), MAX_ATTEMPTS))


def pdq_sweep(blocked_hash_id):
    """A new blocked hash's PDQs against every scanned hash (database only, no blob reads):
    near matches are held (§3.5)."""
    from safety.pdq import MIN_QUALITY
    settings = safety_settings()
    held = []
    with db.connect() as conn:
        with conn.transaction():
            blocked = conn.execute('SELECT reason, blake2b, sha1, md5 FROM blocked_hashes WHERE id = %s',
                                   (blocked_hash_id,)).fetchone()
            if blocked is None:
                return []
            rows = conn.execute(
                'SELECT DISTINCT ON (h.id) h.id, h.scan_state, bit_count(fp.pdq # bp.pdq) AS d FROM blocked_hash_pdq bp '
                'JOIN file_hash_pdq fp ON bit_count(fp.pdq # bp.pdq) <= %s AND fp.quality >= %s '
                'JOIN file_hashes h ON h.id = fp.hash_id '
                "WHERE bp.blocked_hash_id = %s AND bp.quality >= %s AND h.scan_state IN ('passed', 'flagged') "
                'AND NOT (h.blake2b = %s AND h.sha1 = %s AND h.md5 = %s) ORDER BY h.id, d',
                (settings.pdq_match_distance, MIN_QUALITY, blocked_hash_id, MIN_QUALITY, blocked[1], blocked[2],
                 blocked[3])).fetchall()
            for hash_id, scan_state, distance in rows:
                child_safety = blocked[0] == 'csam'
                conn.execute("UPDATE file_hashes SET scan_state = 'held', scan_reason = 'pdq_near_match' WHERE id = %s",
                             (hash_id,))
                near = {'blocked_hash_id': blocked_hash_id, 'reason': blocked[0], 'distance': distance}
                case_id = core.flag_hash(conn, hash_id, 'rescan', 'pdq_near_match', details=near,
                                         child_safety=child_safety, priority=0 if child_safety else 1)
                core.log_action(conn, core.SYSTEM, 'pdq_sweep_hit', hash_id=hash_id, case_id=case_id, details=near,
                                child_safety=child_safety)
                core.invalidate_collages(conn, core.albums_of_hash(conn, hash_id))
                delete_assets_later(conn, hash_id)
                held.append(hash_id)
    return held


@register('pdq_sweep')
def pdq_sweep_job(payload, job):
    pdq_sweep(int(payload['blocked_hash_id']))


# --- album text (§5.7) ---------------------------------------------------------------------------------------

ENQUEUE_ALBUM_TEXT_SQL = (
    "INSERT INTO jobs (kind, payload, run_at, max_attempts, queue) "
    "SELECT 'album_text_scan', %s::jsonb, now() + interval '5 seconds', 5, 'scan' "
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'album_text_scan' AND payload->>'album_id' = %s "
    "AND done_at IS NULL AND failed_at IS NULL AND locked_by IS NULL)")


async def queue_album_text_async(conn, album_id):
    await conn.execute(ENQUEUE_ALBUM_TEXT_SQL, (json.dumps({'album_id': str(album_id)}), str(album_id)))


def album_text_scan(album_id):
    """Web Risk on an album's title, description and captions; never gates the album."""
    from safety.webrisk import extract_urls
    settings = safety_settings()
    with db.connect() as conn:
        row = conn.execute('SELECT title, description FROM albums WHERE id = %s AND deleted_at IS NULL',
                           (album_id,)).fetchone()
        if row is None:
            return None
        captions = [r[0] for r in conn.execute('SELECT caption FROM album_files WHERE album_id = %s AND caption IS '
                                               'NOT NULL ORDER BY position', (album_id,)).fetchall()]
    urls = extract_urls('\n'.join([row[0] or '', row[1] or ''] + captions), settings.web_risk_max_urls)
    result, hits = get_webrisk().check(urls)
    if result['result'] == 'skipped' and result.get('error'):
        return None  # fails open; nothing changes
    with db.connect() as conn:
        with conn.transaction():
            previous = conn.execute('SELECT link_warnings FROM albums WHERE id = %s FOR UPDATE', (album_id,)).fetchone()
            conn.execute('UPDATE albums SET link_warnings = %s::jsonb WHERE id = %s', (json.dumps(hits[:20]), album_id))
            known = {m.get('url') for m in previous[0] or () if isinstance(m, dict)}
            if hits and {m['url'] for m in hits} - known:
                case_id = core.open_case(conn, 'album', 1, album_id)
                core.add_flag(conn, 'scan', 'web_risk', case_id=case_id, album_id=album_id,
                              details={'urls': [m['url'] for m in hits[:20]], 'reason': 'malware'})
    return hits


@register('album_text_scan')
def album_text_scan_job(payload, job):
    album_text_scan(int(payload['album_id']))
