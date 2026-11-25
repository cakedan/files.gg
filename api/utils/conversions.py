"""Conversions on the API side (contract milestone-5 §5, §7, §8, §10.2, §3.3's sweeper):

- **who** converts (`Caller`): the session's user, or the guest with the abuse IP hash;
- **source access** (§5.1): the caller must be able to view each source right now;
- **limits** (§7): sizes, durations, pages and images (`check_size`), then the daily count, the concurrent limit
  and the CPU budget (`reserve`), under per-subject locks in the transaction that creates the conversions;
- **usage accounting** (§7.3): `conversion_usage` per subject and UTC day; the converter charges CPU time with
  `charge_usage(conn, conversion_id, cpu_ms)`;
- **the conversion object** (§10.2);
- **the sweeper** (`sweep`, decision 17) and batch items waiting for a concurrent slot (`release_held`).

Subjects are `u:<user id>`, or `g:<guest id>` and `i:<hex abuse IP hash>` for anonymous callers (§2.5): an
anonymous caller is limited per guest **and** per IP.
"""

import json
import logging

from datetime import datetime, timedelta, timezone

from db import queries
from db.models import Album, epoch, from_row
from media import formats
from utils import convert_queue, errors, limits as limits_module, payloads, view_limits

log = logging.getLogger(__name__)

COLUMNS = ('id', 'owner_user_id', 'owner_guest_id', 'owner_ip_hash', 'batch_id', 'source_file_id',
           'source_album_id', 'source_hash_id', 'source_kind', 'target', 'options', 'recipe_hash', 'status',
           'progress', 'output_file_id', 'output_album_id', 'cached', 'queue', 'job_id', 'queued_at', 'stage',
           'time_limit', 'error', 'failure_reason', 'cpu_ms', 'input_size', 'output_size', 'output_settings',
           'hidden_at', 'created_at', 'started_at', 'finished_at')
SELECT = 'SELECT {} FROM conversions c'.format(', '.join('c.' + c for c in COLUMNS))
ACTIVE = ('queued', 'running')
FINISHED = ('succeeded', 'failed', 'cancelled')
# on its RQ queue or running: what the concurrent limit counts (a batch item still waiting for a slot doesn't)
ACTIVE_SQL = "(c.status IN ('queued', 'running') AND c.queued_at IS NOT NULL)"
HELD_SQL = "(c.status = 'queued' AND c.queued_at IS NULL)"
# retry_after for the concurrent limit: the page polls every second, one finishing frees a slot
CONCURRENT_RETRY_AFTER = 5
# §3.3: how long a queued conversion may wait before CONVERTER_BUSY (premium: never)
QUEUE_WAIT = {convert_queue.ANONYMOUS: 10 * 60, convert_queue.MEMBER: 60 * 60}
# the sweeper leaves a just-committed conversion to its own enqueue this long (§3.3)
ENQUEUE_GRACE = 30
# a running conversion whose job is gone is lost this long after its time limit (§3.3)
LOST_AFTER = 2 * 60
# a queued document preview whose job keeps disappearing is `failed` after this many re-enqueues
PREVIEW_REQUEUES = 3
PREVIEW_REQUEUE_KEY = 'filesgg:preview-requeues:{}'


def row_dict(row):
    return dict(zip(COLUMNS, row)) if row is not None else None


def utcnow():
    return datetime.now(timezone.utc)


def utc_day():
    return utcnow().date()


def seconds_to_midnight():
    """retry_after for the daily limits: days are UTC (§7.3)."""
    now = utcnow()
    tomorrow = datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=1)
    return max(1, int((tomorrow - now).total_seconds()))


# --- the caller ---------------------------------------------------------------------------------------------------

class Caller:
    """Who converts: their user, or their guest with the abuse IP hash (§5.2, §7.1)."""

    def __init__(self, user, guest_id=None, ip_hash=None):
        self.user = user
        self.guest_id = None if user is not None else guest_id
        self.ip_hash = None if user is not None else ip_hash
        self.limits = limits_module.get_limits(user)

    @property
    def anonymous(self):
        return self.user is None

    @property
    def subjects(self):
        return owner_subjects(self.user.id if self.user else None, self.guest_id, self.ip_hash)

    def owner_sql(self, alias='c'):
        """The caller's own conversions (history, GET, DELETE)."""
        if self.user is not None:
            return '{}.owner_user_id = %s'.format(alias), [self.user.id]
        return '{0}.owner_user_id IS NULL AND {0}.owner_guest_id = %s'.format(alias), [self.guest_id]

    def concurrent_sql(self, alias='c'):
        """What the concurrent limit counts: an anonymous caller's per guest **and** per IP."""
        if self.user is not None or self.ip_hash is None:
            return self.owner_sql(alias)
        return ('{0}.owner_user_id IS NULL AND ({0}.owner_guest_id = %s OR {0}.owner_ip_hash = %s)'.format(alias),
                [self.guest_id, self.ip_hash])

    def owns_file(self, fobj):
        if self.user is not None:
            return fobj.user_id == self.user.id
        return fobj.user_id is None and self.guest_id is not None and fobj.guest_id == self.guest_id

    def owns_album(self, album):
        if self.user is not None:
            return album.owner_user_id == self.user.id
        return album.owner_user_id is None and self.guest_id is not None and \
            album.owner_guest_id == self.guest_id

    @property
    def queue(self):
        return self.limits.conversion_queue


def owner_subjects(user_id, guest_id, ip_hash):
    """`conversion_usage` subjects (§2.5)."""
    if user_id is not None:
        return ['u:{}'.format(user_id)]
    subjects = ['g:{}'.format(guest_id)] if guest_id is not None else []
    if ip_hash is not None:
        subjects.append('i:' + bytes(ip_hash).hex())
    return subjects


# --- source access (§5.1) -------------------------------------------------------------------------------------------

async def viewable_file(conn, request, caller, vanity):
    """The live File `vanity` names, if the caller can view it right now (§5.1): `link` for anyone, `password`
    with its unlock token (or an album token that shows it) or for the owner, `private` for the owner only. Not
    deleted, expired, hidden or removed, and its hash `passed` or `flagged`: else SOURCE_UNAVAILABLE (one code for
    all). A view-limited file is its owner's only: VIEW_LIMITED_SOURCE."""
    from utils import access
    from utils.accounts import owner_offline
    if not isinstance(vanity, str) or not vanity.strip():
        raise errors.source_unavailable()
    fobj = await queries.get_file_by_vanity(conn, vanity.strip().split('.', 1)[0])
    if fobj is None or await owner_offline(conn, fobj.user_id):
        raise errors.source_unavailable()
    owner = caller.owns_file(fobj)
    if not owner:
        if fobj.visibility == 'private' or view_limits.reached(fobj):
            raise errors.source_unavailable()
        if fobj.visibility == 'password':
            claims, _ = await access.file_or_album_claims(conn, request, fobj, request.ctx.access_token)
            if claims is None:
                raise errors.source_unavailable()
    if payloads.file_state(fobj) not in ('ok', 'flagged'):
        raise errors.source_unavailable()
    if view_limits.limited(fobj) and not owner:
        raise errors.view_limited_source()
    return fobj


async def viewable_album(conn, request, caller, vanity):
    """(album, its shown items as files, in order) when the caller can view the album (§5.1): the album's own rules
    (its unlock token in X-Filesgg-Access), live and not hidden or removed. Its shown items are what the public sees
    through the album, so each is viewable through it."""
    from db import albums as album_queries
    from utils import access
    from utils.accounts import owner_offline
    if not isinstance(vanity, str) or not vanity.strip():
        raise errors.source_unavailable()
    album = await album_queries.get_album_by_vanity(conn, vanity.strip())
    if album is None or album.moderation_state != 'visible' or await owner_offline(conn, album.owner_user_id):
        raise errors.source_unavailable()
    if not caller.owns_album(album):
        if album.visibility == 'private':
            raise errors.source_unavailable()
        if album.visibility == 'password' and access.token_claims(
                request, album, request.ctx.access_token, kind='album') is None:
            raise errors.source_unavailable()
    items, _ = await album_queries.shown_items(conn, album, limit=None)
    return album, [f for f, _, _ in items]


def kind_of(fobj):
    """§1.1 for a viewable file; 409 FILE_PENDING while the probe it needs hasn't finished."""
    fhash = fobj.hash
    try:
        return formats.source_kind(fobj.mimetype_id, fhash.media if fhash else None,
                                   fhash.processing_state if fhash else 'pending')
    except formats.ProbePending:
        raise errors.file_pending()


def duration_of(fobj):
    """The source's duration in seconds (the limits, trims and target_size work in seconds); the probe stores
    milliseconds (media/process.py)."""
    media = (fobj.hash.media if fobj.hash is not None else None) or {}
    value = media.get('duration')
    return float(value) / 1000 if isinstance(value, (int, float)) and value > 0 else None


def page_count_of(fobj):
    media = (fobj.hash.media if fobj.hash is not None else None) or {}
    value = media.get('pages')
    return int(value) if isinstance(value, int) and value > 0 else None


# --- limits (§7) -----------------------------------------------------------------------------------------------------

def too_large(caller, limit, value, unit):
    return errors.conversion_too_large(limit, value, unit, sign_in=caller.anonymous)


def check_size(caller, kind, files, options):
    """§7.2 step 5: input size, duration, PDF pages after `pages`, and images -> PDF's image count:
    413 CONVERSION_TOO_LARGE { limit, value, unit }."""
    limits = caller.limits
    if kind == formats.IMAGES and len(files) > limits.conversion_max_images_to_pdf:
        raise too_large(caller, limits.conversion_max_images_to_pdf, len(files), 'images')
    size = sum(f.size or 0 for f in files)
    if size > limits.conversion_max_input:
        raise too_large(caller, limits.conversion_max_input, size, 'bytes')
    if kind in formats.TIMED_KINDS:
        duration = duration_of(files[0])
        if duration is not None and duration > limits.conversion_max_duration:
            raise too_large(caller, limits.conversion_max_duration, round(duration, 3), 'seconds')
    if kind == 'pdf':
        count = page_count_of(files[0])
        if count is not None:
            pages = len(formats.page_numbers(options.get('pages'), count))
            if pages > limits.conversion_max_pdf_pages:
                raise too_large(caller, limits.conversion_max_pdf_pages, pages, 'pages')


async def _lock_subjects(conn, subjects):
    for subject in sorted(subjects):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('conversion:' + subject,))


async def usage_today(conn, subjects):
    """{subject: (count, cpu_ms)} for today (UTC)."""
    cursor = await conn.execute('SELECT subject, count, cpu_ms FROM conversion_usage WHERE subject = ANY(%s) AND '
                                'day = %s', (list(subjects), utc_day()))
    found = {r[0]: (r[1], r[2]) for r in await cursor.fetchall()}
    return {subject: found.get(subject, (0, 0)) for subject in subjects}


async def active_count(conn, caller):
    where, params = caller.concurrent_sql()
    cursor = await conn.execute('SELECT count(*) FROM conversions c WHERE {} AND {}'.format(ACTIVE_SQL, where),
                                params)
    return (await cursor.fetchone())[0]


async def reserve(conn, caller, count=1, concurrent=True):
    """§7.2 step 6, in the transaction that creates the conversions: the daily count (every conversion counts, cache
    hits too), the concurrent limit (unless a batch, whose extra items wait for a slot) and CPU budget left > 0, all
    under per-subject locks. Counts the `count` conversions. Returns how many may go on the queue now (the rest of a
    batch waits, §10.6). 429 CONVERSION_LIMIT_REACHED { limit, retry_after }."""
    limits = caller.limits
    subjects = caller.subjects
    await _lock_subjects(conn, subjects)
    used = await usage_today(conn, subjects)
    sign_in = caller.anonymous
    if any(n + count > limits.conversion_count_per_day for n, _ in used.values()):
        raise errors.conversion_limit_reached('count', seconds_to_midnight(), sign_in)
    active = await active_count(conn, caller)
    free = max(0, limits.conversion_concurrent - active)
    if concurrent and free < count:
        raise errors.conversion_limit_reached('concurrent', CONCURRENT_RETRY_AFTER, sign_in)
    if any(cpu_ms >= limits.conversion_cpu_seconds_per_day * 1000 for _, cpu_ms in used.values()):
        raise errors.conversion_limit_reached('cpu', seconds_to_midnight(), sign_in)
    day = utc_day()
    for subject in subjects:
        await conn.execute('INSERT INTO conversion_usage AS u (subject, day, count) VALUES (%s, %s, %s) '
                           'ON CONFLICT (subject, day) DO UPDATE SET count = u.count + EXCLUDED.count',
                           (subject, day, count))
    return min(count, free)


def _subjects_of(conversion):
    return owner_subjects(conversion['owner_user_id'], conversion['owner_guest_id'], conversion['owner_ip_hash'])


def charge_usage(conn, conversion_id, cpu_ms):
    """§7.3, called by the converter's worker class (sync psycopg) when it reaps a work horse, killed ones too: adds
    `cpu_ms` to the conversion and to today's `conversion_usage` of every subject (the user, or the guest and
    the IP)."""
    cpu_ms = max(0, int(cpu_ms))
    with conn.transaction():
        row = conn.execute('UPDATE conversions SET cpu_ms = cpu_ms + %s WHERE id = %s RETURNING owner_user_id, '
                           'owner_guest_id, owner_ip_hash', (cpu_ms, conversion_id)).fetchone()
        if row is None:
            return
        day = utc_day()
        for subject in owner_subjects(*row):
            conn.execute('INSERT INTO conversion_usage AS u (subject, day, cpu_ms) VALUES (%s, %s, %s) '
                         'ON CONFLICT (subject, day) DO UPDATE SET cpu_ms = u.cpu_ms + EXCLUDED.cpu_ms',
                         (subject, day, cpu_ms))


def cpu_seconds_left(conn, conversion_id):
    """§7.3, for the work horse's RLIMIT_CPU: the smallest budget left today of the conversion's subjects, in
    seconds (it may be 0; the horse uses at least 5 s)."""
    row = conn.execute('SELECT owner_user_id, owner_guest_id, owner_ip_hash FROM conversions WHERE id = %s',
                       (conversion_id,)).fetchone()
    if row is None:
        return 0
    user = load_owner(conn, row[0]) if row[0] is not None else None
    budget = limits_module.get_limits(user).conversion_cpu_seconds_per_day * 1000
    subjects = owner_subjects(*row)
    used = {r[0]: r[1] for r in conn.execute('SELECT subject, cpu_ms FROM conversion_usage WHERE subject = ANY(%s) '
                                             'AND day = %s', (subjects, utc_day())).fetchall()}
    return max(0, min(budget - used.get(s, 0) for s in subjects) // 1000)


def load_owner(conn, user_id):
    """A conversion's owning user, for their limits, from a sync connection (the converter and the output store).
    None for a deleted account."""
    from utils.accounts import USER_SELECT, user_from_row
    row = conn.execute(USER_SELECT + ' WHERE u.id = %s', (user_id,)).fetchone()
    return user_from_row(row) if row else None


# --- reading conversions ------------------------------------------------------------------------------------------

async def get_own(conn, caller, conversion_id, lock=False):
    where, params = caller.owner_sql()
    cursor = await conn.execute('{} WHERE c.id = %s AND c.hidden_at IS NULL AND {}{}'.format(
        SELECT, where, ' FOR UPDATE' if lock else ''), [conversion_id] + params)
    return row_dict(await cursor.fetchone())


async def get_many(conn, ids):
    cursor = await conn.execute('{} WHERE c.id = ANY(%s) ORDER BY c.id'.format(SELECT), (list(ids),))
    return [row_dict(r) for r in await cursor.fetchall()]


async def history(conn, caller, before=None, limit=50, batch_id=None):
    """The caller's conversions, newest first (§10.5), or one batch's in order (§10.6)."""
    where, params = caller.owner_sql()
    where = '{} AND c.hidden_at IS NULL'.format(where)
    order = 'c.id DESC'
    if batch_id is not None:
        where += ' AND c.batch_id = %s'
        params.append(batch_id)
        order = 'c.id'
    if before is not None:
        where += ' AND c.id < %s'
        params.append(before)
    cursor = await conn.execute('{} WHERE {} ORDER BY {} LIMIT %s'.format(SELECT, where, order), params + [limit])
    return [row_dict(r) for r in await cursor.fetchall()]


# --- the conversion object (§10.2) ------------------------------------------------------------------------------

def took(conversion):
    """Milliseconds from creation until it finished (or until now)."""
    end = conversion['finished_at'] or utcnow()
    return max(0, int((end - conversion['created_at']).total_seconds() * 1000))


def _held_positions(conversions, lengths):
    """A batch item waiting for a concurrent slot: everything on its queue and the queues before it, plus its own
    batch's earlier waiting items."""
    out, seen = {}, {}
    for c in sorted(conversions, key=lambda c: c['id']):
        if c['status'] == 'queued' and c['queued_at'] is None:
            ahead = sum(lengths.get(q, 0) for q in (c['queue'],) + convert_queue.AHEAD.get(c['queue'], ()))
            key = c['owner_user_id'] or c['owner_guest_id']
            out[c['id']] = ahead + seen.get(key, 0)
            seen[key] = seen.get(key, 0) + 1
    return out


async def queue_positions(conversions):
    """{conversion id: jobs ahead} for the queued ones (§8): one Redis pipeline, from an executor thread. Redis
    being down only costs the position (0)."""
    queued = [c for c in conversions if c['status'] == 'queued']
    if not queued:
        return {}
    on_queue = [(c['job_id'], c['queue']) for c in queued if c['queued_at'] is not None and c['job_id']]
    held = [c for c in queued if c['queued_at'] is None]
    try:
        found = await convert_queue.in_executor(convert_queue.positions, on_queue) if on_queue else {}
        lengths = await convert_queue.in_executor(convert_queue.queue_lengths, convert_queue.CONVERSION_QUEUES) \
            if held else {}
    except Exception:
        log.warning('could not read queue positions', exc_info=True)
        return {}
    out = {c['id']: found.get(c['job_id'], 0) for c in queued if c['queued_at'] is not None and c['job_id']}
    out.update(_held_positions(held, lengths))
    return out


async def conversion_objects(conn, caller, conversions, password=None):
    """The conversion objects (§10.2) for the caller's own conversions. `password` is the generated one, given only
    on the response that created the conversion."""
    from db import albums as album_queries
    from utils import albums as album_rules
    from utils.cdn_signing import Grant
    if not conversions:
        return []
    positions = await queue_positions(conversions)
    source_ids = {c['source_file_id'] for c in conversions if c['source_file_id']}
    sources = {f.id: f for f in await queries.files_where(conn, 'f.id = ANY(%s)', (list(source_ids),))} \
        if source_ids else {}
    output_ids = {c['output_file_id'] for c in conversions if c['output_file_id']}
    outputs = {}
    if output_ids:
        files = await queries.files_where(conn, 'f.id = ANY(%s)', (list(output_ids),))
        await album_queries.attach_albums(conn, files)
        await queries.attach_safety(conn, files)
        outputs = {f.id: f for f in files if caller.owns_file(f)}
    album_ids = {c['output_album_id'] for c in conversions if c['output_album_id']} | \
        {c['source_album_id'] for c in conversions if c['source_album_id']}
    albums = {}
    for album_id in album_ids:
        cursor = await conn.execute('SELECT {} FROM albums AS al WHERE al.id = %s AND {}'.format(
            album_queries.ALBUM_COLUMNS, album_rules.ALBUM_LIVE_SQL), (album_id,))
        row = await cursor.fetchone()
        if row is not None:
            albums[album_id] = from_row(Album, row)
    counts = await album_queries.shown_counts(conn, list(albums))
    sources_count = {}
    multi = [c['id'] for c in conversions if c['source_kind'] == formats.IMAGES]
    if multi:
        cursor = await conn.execute('SELECT conversion_id, count(*) FROM conversion_sources WHERE conversion_id = '
                                    'ANY(%s) GROUP BY conversion_id', (multi,))
        sources_count = {r[0]: r[1] for r in await cursor.fetchall()}

    def source_file(c):
        fobj = sources.get(c['source_file_id'])
        if fobj is None:
            return None
        if caller.owns_file(fobj):
            return payloads.owner_dict(fobj, grant=Grant.owner_file(fobj))
        # someone else's file: only while anyone may still see it as it is
        if fobj.visibility != 'link' or view_limits.limited(fobj) or payloads.file_state(fobj) not in ('ok', 'flagged'):
            return None
        return payloads.public_file(fobj)

    def album_summary(album_id, own):
        album = albums.get(album_id)
        if album is None:
            return None
        if caller.owns_album(album):
            return album_rules.owner_summary(album, counts.get(album_id, 0))
        if own or album.visibility != 'link' or album.moderation_state != 'visible':
            return None
        return {'id': str(album.id), 'vanity': album.vanity, 'url': album_rules.album_url(album),
                'title': album.title or '', 'count': counts.get(album_id, 0)}

    out = []
    for c in conversions:
        output = {'file': None, 'album': None}
        if c['output_file_id'] in outputs:
            output['file'] = payloads.owner_dict(outputs[c['output_file_id']])
        if c['output_album_id']:
            output['album'] = album_summary(c['output_album_id'], True)
        if password is not None:
            output['password'] = password
        error = c['error']
        out.append({
            'id': str(c['id']),
            'status': c['status'],
            'position': positions.get(c['id'], 0) if c['status'] == 'queued' else 0,
            'queue': convert_queue.QUEUE_NAMES.get(c['queue']),
            'stage': c['stage'] if c['status'] == 'running' else None,
            'progress': float(c['progress'] or 0),
            'time_limit': c['time_limit'],
            'took': took(c),
            'batch_id': str(c['batch_id']) if c['batch_id'] else None,
            'source': {
                'kind': c['source_kind'],
                'file': source_file(c),
                'album': album_summary(c['source_album_id'], False) if c['source_album_id'] else None,
                'count': sources_count.get(c['id'], 1),
            },
            'target': c['target'],
            'options': c['options'],
            'cached': c['cached'],
            'output': output,
            'error': error if isinstance(error, dict) else None,
            'input_size': c['input_size'],
            'output_size': c['output_size'],
            'cpu_seconds': round((c['cpu_ms'] or 0) / 1000, 3),
            'created_at': epoch(c['created_at']),
            'started_at': epoch(c['started_at']),
            'finished_at': epoch(c['finished_at']),
        })
    return out


# --- the sweeper (§3.3, decision 17), sync on the Postgres scheduler -----------------------------------------------------

def _save_error(conn, conversion_id, status, error, failure_reason, from_status):
    return conn.execute(
        'UPDATE conversions SET status = %s, error = %s::jsonb, failure_reason = %s, stage = NULL, finished_at = now() '
        'WHERE id = %s AND status = %s RETURNING id',
        (status, json.dumps(errors.conversion_error(error)), failure_reason, conversion_id, from_status)).fetchone()


def busy_error(queue):
    error = errors.converter_busy()
    if queue != convert_queue.ANONYMOUS:
        # signing in is what skips the anonymous queue; a member is signed in already
        error.data.pop('sign_in', None)
    return error


def sweep(conn, connection=None):
    """Every minute (`convert_sweep`):
    - a `queued` conversion older than 30 s whose RQ job doesn't exist is enqueued again (same job id: never twice);
    - one queued longer than its tier's wait (anonymous 10 minutes, members 60, premium never) is `cancelled` with
      CONVERTER_BUSY, and its RQ job cancelled;
    - a `running` one whose job is gone and whose `started_at` is past its time limit plus 2 minutes is `failed`
      with `work_horse_lost`;
    - batch items waiting for a concurrent slot go on the queue as slots free up (§10.6);
    - a `queued` document preview whose job is missing is enqueued again (§9.1).
    Returns counts."""
    connection = connection or convert_queue.redis()
    out = {'requeued': 0, 'busy': 0, 'lost': 0, 'released': 0, 'previews': 0}
    rows = conn.execute(
        "SELECT id, queue, job_id, time_limit, extract(epoch FROM now() - queued_at) FROM conversions "
        "WHERE status = 'queued' AND queued_at IS NOT NULL AND created_at < now() - make_interval(secs => %s) "
        'ORDER BY id LIMIT 1000', (ENQUEUE_GRACE,)).fetchall()
    for conversion_id, queue, job_id, time_limit, waited in rows:
        wait = QUEUE_WAIT.get(queue)
        if wait is not None and waited > wait:
            if _save_error(conn, conversion_id, 'cancelled', busy_error(queue), 'CONVERTER_BUSY', 'queued'):
                convert_queue.cancel(job_id or convert_queue.conversion_job_id(conversion_id), connection)
                out['busy'] += 1
            continue
        if not convert_queue.job_exists(job_id or convert_queue.conversion_job_id(conversion_id), connection):
            if convert_queue.enqueue_conversion(conversion_id, queue, time_limit, connection):
                out['requeued'] += 1
    rows = conn.execute(
        "SELECT id, job_id FROM conversions WHERE status = 'running' AND started_at < now() - "
        'make_interval(secs => time_limit + %s) ORDER BY id LIMIT 1000', (LOST_AFTER,)).fetchall()
    for conversion_id, job_id in rows:
        if not convert_queue.job_exists(job_id or convert_queue.conversion_job_id(conversion_id), connection):
            if _save_error(conn, conversion_id, 'failed', errors.conversion_failed('internal'), 'work_horse_lost',
                           'running'):
                out['lost'] += 1
    out['released'] = release_held(conn, connection=connection)
    out['previews'] = sweep_previews(conn, connection)
    return out


def sweep_previews(conn, connection):
    requeued = 0
    for (hash_id,) in conn.execute("SELECT id FROM file_hashes WHERE preview_state = 'queued' ORDER BY id "
                                   'LIMIT 1000').fetchall():
        if convert_queue.job_exists(convert_queue.preview_job_id(hash_id), connection):
            continue
        key = PREVIEW_REQUEUE_KEY.format(hash_id)
        attempts = connection.incr(key)
        connection.expire(key, 86400)
        if attempts > PREVIEW_REQUEUES:
            conn.execute("UPDATE file_hashes SET preview_state = 'failed' WHERE id = %s AND preview_state = 'queued'",
                         (hash_id,))
            continue
        if convert_queue.enqueue_preview(hash_id, connection):
            requeued += 1
    return requeued


def release_held(conn, user_id=None, connection=None):
    """Batch items waiting for a concurrent slot (§10.6) go on their queue, oldest first, while their owner has
    slots free. Each is marked `queued_at` in its own transaction, then enqueued after the commit. Returns how many
    went on a queue."""
    if user_id is None:
        owners = [r[0] for r in conn.execute(
            "SELECT DISTINCT owner_user_id FROM conversions WHERE status = 'queued' AND queued_at IS NULL AND "
            'owner_user_id IS NOT NULL LIMIT 1000').fetchall()]
    else:
        owners = [user_id]
    released = []
    for owner in owners:
        user = load_owner(conn, owner)
        if user is None:
            continue
        limit = limits_module.get_limits(user).conversion_concurrent
        with conn.transaction():
            conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', ('conversion:u:{}'.format(owner),))
            active = conn.execute('SELECT count(*) FROM conversions c WHERE c.owner_user_id = %s AND ' + ACTIVE_SQL,
                                  (owner,)).fetchone()[0]
            if active >= limit:
                continue
            released += conn.execute(
                'UPDATE conversions SET queued_at = now() WHERE id IN (SELECT id FROM conversions c WHERE '
                'c.owner_user_id = %s AND ' + HELD_SQL + ' ORDER BY id LIMIT %s FOR UPDATE) RETURNING id, queue, '
                'time_limit', (owner, limit - active)).fetchall()
    for conversion_id, queue, time_limit in released:
        convert_queue.enqueue_conversion(conversion_id, queue, time_limit, connection)
    return len(released)


def cleanup(conn):
    """Hourly: `conversion_usage` rows older than 2 days (§2.5), and the anonymous daily upload IP hashes kept for an
    output's caps once they're older than the 2 days uploads keep theirs."""
    usage = conn.execute("DELETE FROM conversion_usage WHERE day < (now() AT TIME ZONE 'UTC')::date - 2").rowcount
    scrubbed = conn.execute(
        "UPDATE conversions SET output_settings = output_settings - 'upload_ip_hashes' WHERE output_settings ? "
        "'upload_ip_hashes' AND created_at < now() - interval '2 days'").rowcount
    return usage, scrubbed
