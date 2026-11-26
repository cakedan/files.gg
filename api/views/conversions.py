"""Conversions (contract milestone-5 §10):

    GET    /conversions/formats        the format table (§10.1), public
    POST   /conversions                one conversion (§10.3): waits up to 2 s, then 200 or 202
    POST   /conversions/batch          one conversion per source, signed in only (§10.6)
    GET    /conversions?batch=<id>     the caller's batch
    GET    /conversions/<id>           poll (§8)
    DELETE /conversions/<id>           cancel while queued or running, else forget (§10.4)
    GET    /users/@me/conversions      history (§10.5)

Every route is the caller's: their session's user, or their guest (`Authorization: Guest`). Conversions are
addressed by id, never a vanity (§0). Upload keys get 403 UPLOAD_KEY_SCOPE (utils/auth.py).

`POST /conversions` checks, in order (§7.2): Turnstile (anonymous), `document -> pdf` anonymous, source access (§5.1),
the target and its options, sizes, then the daily count, the concurrent limit and the CPU budget. A cache hit
(§4.5) creates the output at once; anything else is committed `queued` and then enqueued on the caller's tier queue
(§3.1, decision 17).
"""

import asyncio
import json

from sanic import Blueprint
from sanic.exceptions import NotFound

import db
from media import formats
from safety import ip as abuse_ip
from safety.run import in_thread
from safety.settings import safety_settings
from utils import (
    conversion_outputs, conversions as rules, convert_queue, errors, limits as limits_module, passwords, payloads,
    regions, standing, upload_defaults, uploading, view_hash, view_limits,
)
from utils.generators import Snowflake
from utils.helpers import client_ip
from utils.params import request_json
from utils.ratelimit import limiter
from utils.responses import ApiError, ApiResponse
from utils.turnstile import Turnstile
from utils.wrappers import route

import utils.parameters as parameters

conversions = Blueprint('conversions', url_prefix='/conversions')
# GET /users/@me/conversions: `@me` is routed as a parameter, as the `me` blueprint's (views/me.py)
my_conversions = Blueprint('my_conversions', url_prefix='/users/<me:str>/conversions')

# §4.1 step 3 (notsobot's `wait_briefly`): re-read at 0.1 s, doubling to 1 s, for at most 2 s
WAIT_SECONDS = 2.0
WAIT_FIRST = 0.1
WAIT_MAX_STEP = 1.0
BATCH_MAX = 100
SOURCES_MAX = 500
HISTORY_LIMIT = 50
CACHE_SQL = ("SELECT cc.output_hash_id FROM conversion_cache cc JOIN file_hashes h ON h.id = cc.output_hash_id "
             "WHERE cc.source_hash_id = %s AND cc.recipe_hash = %s AND h.scan_state NOT IN ('blocked', 'held')")
INSERT_SQL = (
    'INSERT INTO conversions (id, owner_user_id, owner_guest_id, owner_ip_hash, batch_id, source_file_id, '
    'source_album_id, source_hash_id, source_kind, target, options, recipe_hash, status, cached, queue, job_id, '
    'queued_at, stage, started_at, time_limit, input_size, output_settings) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '
    '%s, %s, %s::jsonb, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END, %s, CASE WHEN %s THEN now() END, %s, %s, '
    '%s::jsonb)')


# --- the request ---------------------------------------------------------------------------------------------------

def body_of(request):
    body = request_json(request)
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise errors.invalid_parameters({'body': 'Must be a JSON object'})
    return body


def _field(body, name, check):
    value = body.get(name)
    if value is None:
        return None
    try:
        return check(value)
    except (TypeError, ValueError) as error:
        raise errors.invalid_parameters({name: str(error) or 'Invalid value'})


def _string(value):
    if not isinstance(value, str):
        raise ValueError('Must be a string')
    return value


def _vanities(limit):
    def check(value):
        if not isinstance(value, list) or not 1 <= len(value) <= limit or \
                not all(isinstance(v, str) and v.strip() for v in value):
            raise ValueError('Must be a list of 1 to {} links'.format(limit))
        return [v.strip() for v in value]
    return check


def _visibility(value):
    if value not in uploading.VISIBILITIES:
        raise ValueError('Must be one of {}'.format(', '.join(uploading.VISIBILITIES)))
    return value


class Output:
    """The output fields of a request (§5.3, §5.5, §21): visibility, password, expiry and view limit. `expires_in`
    sent as `null` keeps the output forever (signed in); left out, the caller's default applies."""

    def __init__(self, body):
        self.visibility = _field(body, 'visibility', _visibility)
        self.password = _field(body, 'password', passwords.validate)
        self.generate_password = bool(_field(body, 'generate_password', uploading.boolean))
        self.expires_given = 'expires_in' in body
        self.expires_in = _field(body, 'expires_in', uploading.positive_int)
        self.view_limit = _field(body, 'view_limit', view_limits.limit_value)
        self.view_limit_action = _field(body, 'view_limit_action', view_limits.action_value)

    @property
    def access_given(self):
        return self.visibility is not None or self.password is not None or self.generate_password


async def caller_for(conn, request):
    """The session's user, else the guest (401 with neither, or with a dead cookie), with the abuse
    IP hash for an anonymous caller's per-IP limits."""
    from utils import links
    from utils.auth import auth_of
    current = auth_of(request)
    if current.kind == 'session':
        await links.prepare(conn, current.user)
        return rules.Caller(current.user)
    if current.dead:
        raise errors.unauthorized()
    if current.guest_id is None:
        raise errors.unauthorized()
    return rules.Caller(None, current.guest_id, abuse_ip.abuse_ip_hash(client_ip(request),
                                                                   safety_settings().abuse_hash_secret))


async def turnstile(request, caller, body):
    """§7.2 step 1: anonymous callers pass Turnstile (action `convert`)."""
    if caller.limits.conversion_turnstile and not await Turnstile.verify(
            body.get('turnstile_token'), 'convert', client_ip(request)):
        raise errors.captcha_invalid()


# --- planning one conversion -------------------------------------------------------------------------------------------

class Plan:
    """One conversion to create: its sources, kind, target, normalised options and recipe."""

    def __init__(self, files, kind, target, options, album=None, max_height_cap=None):
        self.files = files
        self.kind = kind
        self.target = target
        self.options = options
        self.album = album
        # the caller's tier cap is part of the recipe (formats.CAPPED_KINDS), so the cache never mixes capped outputs
        self.recipe_hash = formats.recipe_hash(kind, target, options, max_height_cap)
        self.cache_hash = None
        self.settings = None
        # a generated password, shown once on the response that created the conversion
        self.password = None

    @property
    def source(self):
        return self.files[0]

    @property
    def protected(self):
        return any(f.visibility != 'link' for f in self.files)

    @property
    def input_size(self):
        return sum(f.size or 0 for f in self.files)


def try_target(kind, target, mimetype):
    try:
        return formats.resolve_target(kind, target, mimetype)
    except ApiError:
        return None


def plan_for(caller, files, kind, raw_target, raw_options, album=None):
    """The target, the options and the size limits for viewable sources of one kind (§7.2 after step 4):
    UNSUPPORTED_CONVERSION, INVALID_OPTION, TARGET_SIZE_TOO_SMALL, CONVERSION_TOO_LARGE."""
    target = formats.resolve_target(kind, raw_target, files[0].mimetype_id)
    duration = rules.duration_of(files[0]) if kind in formats.TIMED_KINDS else None
    options = formats.normalise(kind, target, raw_options, duration)
    if duration is not None:
        formats.check_target_size(options, formats.trimmed_duration(options, duration))
    rules.check_size(caller, kind, files, options)
    return Plan(files, kind, target, options, album, max_height_cap=caller.limits.conversion_max_height)


async def output_settings(conn, request, caller, plan, output, generated=None):
    """§1.3, §5.3, §5.5, §21: the output's name, access, expiry and view limit, fixed now (the work horse applies
    them). What the request leaves out comes from the signed-in caller's upload defaults, except that a protected
    source's output is protected too; anonymous callers get `link` (or a generated password) and 21 days.
    Returns (settings, generated password)."""
    limits = caller.limits
    defaults = upload_defaults.of(caller.user, limits) if caller.user is not None else None
    visibility, password, generate = output.visibility, output.password, output.generate_password
    if not output.access_given:
        if plan.protected:
            # §5.3: a protected source's output is protected too
            visibility, generate = ('private', False) if caller.user is not None else ('password', True)
        elif defaults is not None:
            visibility = defaults['visibility']
            generate = visibility == 'password'
    if visibility == 'private' and caller.anonymous:
        raise uploading.private_requires_account()
    if caller.anonymous and output.view_limit is not None:
        raise errors.invalid_parameters({'view_limit': 'Sign in to set a view limit'})
    view_limit = uploading.resolve_view_limit(caller.user, output.view_limit, output.view_limit_action)
    if output.expires_given and output.expires_in is None:
        # `null`: never, for those who may keep files
        if not limits.allow_no_expiry:
            raise limits_module.expiry_not_allowed(limits)
        expires_in = None
    elif output.expires_given or defaults is None:
        expires_in = limits_module.resolve_expiry(limits, output.expires_in)
    else:
        expires_in = defaults['expires_in']
    if generate and generated is not None:
        # a batch shares one generated password, hashed once: (plain, hash)
        columns = {'visibility': visibility or 'password', 'password_hash': generated[1], 'unlock_ttl': 3600}
        new_password = generated[0]
    else:
        columns, new_password = await uploading.resolve_access(caller.user, visibility, password, generate)
    if plan.kind == formats.IMAGES:
        title = plan.album.title if plan.album is not None and plan.album.title else plan.source.filename
    else:
        title = plan.source.filename
    # PDF -> images: the pages' type (§4.6); the anonymous ZIP's own name and type come from these (§1.3)
    target = formats.TARGETS[plan.target]
    name, extension, mimetype = await uploading.resolve_name(conn, title + '.' + target.extension, None,
                                                             target.mimetype)
    settings = {
        'name': name, 'extension': extension, 'mimetype': mimetype, 'title': title,
        'visibility': columns['visibility'], 'password_hash': columns['password_hash'],
        'unlock_ttl': columns['unlock_ttl'], 'expires_in': expires_in, **view_limit,
    }
    if caller.anonymous:
        secret = request.app.ctx.view_hash_secret
        settings['upload_ip_hashes'] = [h.hex() for h in view_hash.recent_hashes(secret, uploading.IP_PURPOSE,
                                                                                 client_ip(request))]
        _, sealed = abuse_ip.for_request(client_ip(request), safety_settings())
        if sealed:
            settings['ip_sealed'] = sealed.hex()
    return settings, new_password


async def cache_lookup(conn, plan):
    if not formats.cacheable(plan.kind) or plan.source.hash_id is None:
        return None
    cursor = await conn.execute(CACHE_SQL, (plan.source.hash_id, plan.recipe_hash))
    row = await cursor.fetchone()
    return row[0] if row else None


async def insert(conn, caller, plan, conversion_id, batch_id=None, on_queue=True):
    """The conversion row: a cache hit is `running` until its output is stored (no job); anything else is `queued`
    with its job id, on the queue now or (a batch's extra items) waiting for a concurrent slot."""
    cached = plan.cache_hash is not None
    single = plan.kind != formats.IMAGES
    await conn.execute(INSERT_SQL, (
        conversion_id, caller.user.id if caller.user else None, caller.guest_id, caller.ip_hash, batch_id,
        plan.source.id if single else None, plan.album.id if plan.album is not None else None, plan.source.hash_id,
        plan.kind, plan.target, json.dumps(plan.options), plan.recipe_hash, 'running' if cached else 'queued',
        cached, caller.queue, None if cached else convert_queue.conversion_job_id(conversion_id),
        on_queue and not cached, 'storing' if cached else None, cached, caller.limits.conversion_time_limit,
        plan.input_size, json.dumps(plan.settings)))
    if not single:
        for position, fobj in enumerate(plan.files):
            await conn.execute('INSERT INTO conversion_sources (conversion_id, position, file_id, hash_id) VALUES '
                               '(%s, %s, %s, %s)', (conversion_id, position, fobj.id, fobj.hash_id))


async def store_from_cache(conversion_id, plan, caller):
    """§4.5: the output over the cached hash, in a thread on a sync connection (the work horses' own path). A
    stale hit is dropped and the conversion goes on the queue; a refusal is the conversion's error."""
    try:
        await in_thread(conversion_outputs.store_cached, conversion_id, plan.cache_hash, transaction=False)
        return
    except conversion_outputs.CacheMiss:
        async with db.connection() as conn:
            await conn.execute('DELETE FROM conversion_cache WHERE source_hash_id = %s AND recipe_hash = %s',
                               (plan.source.hash_id, plan.recipe_hash))
            await conn.execute(
                "UPDATE conversions SET status = 'queued', cached = false, stage = NULL, started_at = NULL, "
                "job_id = %s, queued_at = now() WHERE id = %s AND status = 'running'",
                (convert_queue.conversion_job_id(conversion_id), conversion_id))
        await enqueue(conversion_id, caller)
    except ApiError as error:
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE conversions SET status = 'failed', error = %s::jsonb, failure_reason = %s, stage = NULL, "
                "finished_at = now() WHERE id = %s AND status = 'running'",
                (json.dumps(errors.conversion_error(error)), error.code, conversion_id))


async def enqueue(conversion_id, caller):
    """After the commit (decision 17), from an executor thread; a failure is the sweeper's."""
    await convert_queue.in_executor(convert_queue.enqueue_conversion, conversion_id, caller.queue,
                                    caller.limits.conversion_time_limit)


async def wait_briefly(caller, conversion_id):
    """§4.1 step 3: the row, re-read until it's finished or 2 s have passed."""
    waited, step = 0.0, WAIT_FIRST
    while True:
        async with db.connection() as conn:
            row = await rules.get_own(conn, caller, conversion_id)
        if row is None or row['status'] in rules.FINISHED or waited >= WAIT_SECONDS:
            return row
        step = min(step, WAIT_SECONDS - waited)
        await asyncio.sleep(step)
        waited += step
        step = min(step * 2, WAIT_MAX_STEP)


# --- sources --------------------------------------------------------------------------------------------------------

async def single_source(conn, request, caller, body):
    """(files, kind, album, skipped) for `source`, `sources` (images -> PDF, ordered) or `album` (images -> PDF in
    album order). Raises the access error (§5.1) of a single source; several skip what they can't use."""
    given = [name for name in ('source', 'sources', 'album') if body.get(name) is not None]
    if len(given) != 1:
        raise errors.invalid_parameters({'source': 'Give one of source, sources or album'})
    if given[0] == 'source':
        fobj = await rules.viewable_file(conn, request, caller, _field(body, 'source', _string))
        return [fobj], rules.kind_of(fobj), None, []
    album = None
    if given[0] == 'album':
        album, files = await rules.viewable_album(conn, request, caller, _field(body, 'album', _string))
        candidates = [(f.vanity, f) for f in files]
    else:
        candidates = []
        for vanity in _field(body, 'sources', _vanities(SOURCES_MAX)):
            try:
                candidates.append((vanity, await rules.viewable_file(conn, request, caller, vanity)))
            except ApiError as error:
                candidates.append((vanity, error))
    files, skipped = [], []
    for vanity, found in candidates:
        if isinstance(found, ApiError):
            skipped.append({'source': vanity, 'code': found.code})
            continue
        try:
            kind = rules.kind_of(found)
        except ApiError as error:
            skipped.append({'source': vanity, 'code': error.code})
            continue
        if kind != 'image':
            skipped.append({'source': vanity, 'code': 'UNSUPPORTED_CONVERSION'})
            continue
        files.append(found)
    if not files:
        raise errors.source_unavailable()
    return files, formats.IMAGES, album, skipped


# --- routes -----------------------------------------------------------------------------------------------------------

@route(conversions, '/formats', ['GET'])
async def get_formats(request):
    """§10.1: public, cacheable for 5 minutes."""
    response = ApiResponse(formats.formats_document())
    response.headers['cache-control'] = 'public, max-age=300'
    return response


@route(conversions, '', ['POST'])
@limiter.limit('30 per minute', scope='conversions')
async def create_conversion(request):
    """§10.3: `200 <conversion>` when it finished within the brief wait (succeeded, failed or a cache hit), else
    `202 <conversion>`."""
    body = body_of(request)
    output = Output(body)
    async with db.connection() as conn:
        caller = await caller_for(conn, request)
        await standing.check_uploader(conn, caller.user, caller.guest_id, caller.ip_hash)
        # 1. Turnstile
        await turnstile(request, caller, body)
        # 4. source access, read first but answered after 2: a source the caller can't see says nothing about itself
        access_error = None
        try:
            files, kind, album, skipped = await single_source(conn, request, caller, body)
        except ApiError as error:
            if error.code not in ('SOURCE_UNAVAILABLE', 'VIEW_LIMITED_SOURCE'):
                raise
            access_error = error
        # 2. document -> pdf needs an account
        raw_target = body.get('target')
        if access_error is None:
            target = try_target(kind, raw_target, files[0].mimetype_id)
            if target is not None and not caller.limits.conversion_allows(kind, target):
                raise errors.conversion_requires_account()
        if access_error is not None:
            raise access_error
        # milestone-7 §11.3: an output inherits its sources' NSFW, so nothing adult is converted from a blocked country
        if regions.request_blocked(request) and any(payloads.nsfw_of(f)[0] for f in files):
            raise errors.adult_content_unavailable()
        # the target and its options, then 5. sizes
        plan = plan_for(caller, files, kind, raw_target, body.get('options'), album)
        plan.settings, password = await output_settings(conn, request, caller, plan, output)
        plan.cache_hash = await cache_lookup(conn, plan)
        conversion_id = Snowflake.generate()
        async with conn.transaction():
            # 6. count, concurrent, CPU budget
            await rules.reserve(conn, caller)
            await insert(conn, caller, plan, conversion_id)
    if plan.cache_hash is not None:
        await store_from_cache(conversion_id, plan, caller)
    else:
        await enqueue(conversion_id, caller)
    row = await wait_briefly(caller, conversion_id)
    async with db.connection() as conn:
        data = (await rules.conversion_objects(conn, caller, [row], password))[0]
    if kind == formats.IMAGES:
        data['skipped'] = skipped
    return ApiResponse(data, status=200 if row['status'] in rules.FINISHED else 202)


@route(conversions, '/batch', ['POST'])
@limiter.limit('30 per minute', scope='conversions')
async def create_batch(request):
    """§10.6: one conversion per source, sharing a `batch_id`. Sources whose kind has no such target (or that the
    caller can't use) are `skipped` with the reason. The count is checked for the whole batch; the concurrent limit
    doesn't refuse it: the items past it wait for a slot. `202 { batch_id, items, skipped }`."""
    body = body_of(request)
    output = Output(body)
    async with db.connection() as conn:
        caller = await caller_for(conn, request)
        await standing.check_uploader(conn, caller.user, caller.guest_id, caller.ip_hash)
        await turnstile(request, caller, body)
        # 3. batches need an account
        if not caller.limits.conversion_batch:
            raise errors.conversion_requires_account(batch=True)
        given = [name for name in ('files', 'album') if body.get(name) is not None]
        if len(given) != 1:
            raise errors.invalid_parameters({'files': 'Give files or album'})
        if given[0] == 'album':
            _, files = await rules.viewable_album(conn, request, caller, _field(body, 'album', _string))
            candidates = [(f.vanity, f) for f in files[:BATCH_MAX]]
        else:
            candidates = []
            for vanity in _field(body, 'files', _vanities(BATCH_MAX)):
                try:
                    candidates.append((vanity, await rules.viewable_file(conn, request, caller, vanity)))
                except ApiError as error:
                    candidates.append((vanity, error))
        plans, skipped, generated = [], [], None
        blocked = regions.request_blocked(request)
        for vanity, found in candidates:
            try:
                if isinstance(found, ApiError):
                    raise found
                if blocked and payloads.nsfw_of(found)[0]:
                    # milestone-7 §11.3: skipped like any other source this caller can't use here
                    raise errors.adult_content_unavailable()
                kind = rules.kind_of(found)
                plan = plan_for(caller, [found], kind, body.get('target'), body.get('options'))
                plan.settings, plan.password = await output_settings(conn, request, caller, plan, output,
                                                                     generated)
                if plan.password is not None and generated is None:
                    generated = (plan.password, plan.settings['password_hash'])
                plan.cache_hash = await cache_lookup(conn, plan)
                plans.append(plan)
            except ApiError as error:
                if error.code == 'INVALID_PARAMETERS' or error.code == 'PRIVATE_REQUIRES_ACCOUNT' or \
                        error.code == 'EXPIRY_NOT_ALLOWED' or error.code == 'PASSWORD_REQUIRED':
                    raise
                skipped.append({'source': vanity, 'code': error.code})
        batch_id = Snowflake.generate()
        ids = [Snowflake.generate() for _ in plans]
        async with conn.transaction():
            queued = [p for p in plans if p.cache_hash is None]
            free = await rules.reserve(conn, caller, count=len(plans), concurrent=False) if plans else 0
            slots = set(id(p) for p in queued[:free])
            for plan, conversion_id in zip(plans, ids):
                await insert(conn, caller, plan, conversion_id, batch_id=batch_id, on_queue=id(plan) in slots)
    for plan, conversion_id in zip(plans, ids):
        if plan.cache_hash is not None:
            await store_from_cache(conversion_id, plan, caller)
        elif id(plan) in slots:
            await enqueue(conversion_id, caller)
    async with db.connection() as conn:
        rows = await rules.get_many(conn, ids)
        items = await rules.conversion_objects(conn, caller, rows)
    for item, plan in zip(items, plans):
        if plan.password is not None:
            item['output']['password'] = plan.password
    return ApiResponse({'batch_id': str(batch_id), 'items': items, 'skipped': skipped}, status=202)


def _id(value):
    try:
        return parameters.snowflake(value)
    except (TypeError, ValueError):
        raise errors.unknown_conversion()


@route(conversions, '', ['GET'])
async def list_batch(request):
    """`GET /conversions?batch=<id>`: the caller's batch, in order. Items waiting for a concurrent slot go on the
    queue as slots free up (the page polls this)."""
    raw = request.args.get('batch')
    try:
        batch_id = parameters.snowflake(raw)
    except (TypeError, ValueError):
        raise errors.invalid_parameters({'batch': 'A batch id from POST /conversions/batch'})
    async with db.connection() as conn:
        caller = await caller_for(conn, request)
    if caller.user is not None:
        await in_thread(rules.release_held, caller.user.id, transaction=False)
    async with db.connection() as conn:
        rows = await rules.history(conn, caller, limit=BATCH_MAX, batch_id=batch_id)
        items = await rules.conversion_objects(conn, caller, rows)
    # a batch is at most 100 conversions, so it's one page (`next` as in the history)
    return ApiResponse({'batch_id': str(batch_id), 'items': items, 'next': None})


@route(conversions, '/<conversion_id:str>', ['GET'])
@limiter.limit('5 per second', scope='conversion_poll')
async def get_conversion(request, conversion_id):
    """§10.4, §8: the caller's own conversion (404 otherwise), with its position while queued."""
    conversion_id = _id(conversion_id)
    async with db.connection() as conn:
        caller = await caller_for(conn, request)
        row = await rules.get_own(conn, caller, conversion_id)
        if row is None:
            raise errors.unknown_conversion()
        objects = await rules.conversion_objects(conn, caller, [row])
    return ApiResponse(objects[0])


@route(conversions, '/<conversion_id:str>', ['DELETE'])
async def delete_conversion(request, conversion_id):
    """§10.4: `cancelled` while queued or running (`200 <conversion>`, and its RQ job stopped: the stop command when
    a horse has it, `cancel()` while it waits); a finished one leaves the history (`204`), its output untouched."""
    conversion_id = _id(conversion_id)
    async with db.connection() as conn:
        caller = await caller_for(conn, request)
        async with conn.transaction():
            row = await rules.get_own(conn, caller, conversion_id, lock=True)
            if row is None:
                raise errors.unknown_conversion()
            if row['status'] in rules.FINISHED:
                await conn.execute('UPDATE conversions SET hidden_at = now() WHERE id = %s', (conversion_id,))
                return ApiResponse(None)
            await conn.execute("UPDATE conversions SET status = 'cancelled', stage = NULL, failure_reason = "
                               "'cancelled', finished_at = now() WHERE id = %s", (conversion_id,))
    if row['job_id']:
        try:
            await convert_queue.in_executor(convert_queue.cancel, row['job_id'])
        except Exception:
            # the horse sees `cancelled` when it starts, and the sweeper never re-enqueues it
            pass
    async with db.connection() as conn:
        row = await rules.get_own(conn, caller, conversion_id)
        objects = await rules.conversion_objects(conn, caller, [row])
    return ApiResponse(objects[0])


@route(my_conversions, '', ['GET'])
async def my_history(request, me):
    """§10.5: `?before=<id>&limit=` (1-100, default 50), newest first: `{ items, next }`."""
    if me != '@me':
        raise NotFound('Not Found')
    before, limit = request.args.get('before'), request.args.get('limit')
    try:
        before = parameters.snowflake(before) if before else None
    except (TypeError, ValueError):
        raise errors.invalid_parameters({'before': 'An id from `next`'})
    try:
        limit = int(limit) if limit else HISTORY_LIMIT
        if not 1 <= limit <= 100:
            raise ValueError()
    except ValueError:
        raise errors.invalid_parameters({'limit': 'Must be at least or in between 1 and 100'})
    async with db.connection() as conn:
        caller = await caller_for(conn, request)
        rows = await rules.history(conn, caller, before=before, limit=limit)
        items = await rules.conversion_objects(conn, caller, rows)
    return ApiResponse({'items': items, 'next': items[-1]['id'] if len(items) == limit else None})

