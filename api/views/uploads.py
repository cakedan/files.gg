"""Chunked, resumable uploads (contract §6, PLAN.md "Chunked, resumable uploads").

Chunks go straight to B2 as parts of one S3 multipart upload at
`staging/<upload_id>`, so any API server can take any chunk, in any order, in
parallel; Postgres records the parts. `complete` finishes the multipart upload
and queues `finalize_upload`, which `python -m worker` runs (jobs/finalize.py).
Nothing is written to the API server's disk; a chunk (at most chunk_size) is
held in memory while it is sent to B2.
"""

import math
import os

from datetime import timedelta
from typing import Annotated, Optional

from sanic import Blueprint

import db
import jobs
from db import queries
from db.models import epoch
from utils import errors, filetypes, limits as limits_module, passwords, payloads, storage as storage_module, uploading
from utils.cdn_signing import Grant
from utils.generators import Snowflake
from utils.helpers import client_ip, get_user
from utils.params import Arg, Args
from utils.responses import ApiResponse
from utils.turnstile import Turnstile
from utils.wrappers import parse_args, route
from safety import ip as abuse_ip, uploads as safety_uploads
from safety.settings import safety_settings
from utils import standing

import utils.parameters as parameters

uploads = Blueprint('uploads', url_prefix='/uploads')

DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
SESSION_HOURS = 24
# open chunked uploads per user, or per anonymous fingerprint and per IP (each S3 multipart upload
# holds its parts until it's completed or aborted)
DEFAULT_MAX_OPEN_UPLOADS = 20
OPEN_SESSION = "status = 'open' AND expires_at > now()"


def chunk_size():
    return int(os.getenv('UPLOAD_CHUNK_SIZE', DEFAULT_CHUNK_SIZE))


def max_open_uploads():
    return int(os.getenv('UPLOAD_MAX_OPEN_SESSIONS', DEFAULT_MAX_OPEN_UPLOADS))


async def _count(conn, sql, params):
    cursor = await conn.execute(sql, params)
    return (await cursor.fetchone())[0]


async def check_open_uploads(conn, owner):
    """Raise TOO_MANY_UPLOADS when the owner already has max_open_uploads() open sessions: a
    signed-in user by account, an anonymous caller by fingerprint and by IP (today's and
    yesterday's hashes, as the rolling cap)."""
    limit = max_open_uploads()
    if owner.user is not None:
        count = await _count(conn, 'SELECT count(*) FROM upload_sessions WHERE owner_user_id = %s AND ' + OPEN_SESSION,
                             (owner.user.id,))
    else:
        count = 0
        if owner.fingerprint is not None:
            count = await _count(
                conn, 'SELECT count(*) FROM upload_sessions WHERE owner_fingerprint = %s AND ' + OPEN_SESSION,
                (owner.fingerprint,))
        if owner.ip_hashes:
            count = max(count, await _count(
                conn, 'SELECT count(*) FROM upload_sessions WHERE owner_ip_hash = ANY(%s) AND ' + OPEN_SESSION,
                (list(owner.ip_hashes),)))
    if count >= limit:
        raise errors.too_many_uploads(limit)


async def abort_session_upload(storage, session):
    """Abort the session's S3 multipart upload, so its parts don't stay on B2. Idempotent. Once it's
    gone the upload id is cleared; if the abort fails it stays set and the upload reaper retries."""
    if not session.b2_upload_id:
        return True
    if not await storage.abort_multipart(session.storage_key, session.b2_upload_id):
        return False
    async with db.connection() as conn:
        await conn.execute("UPDATE upload_sessions SET b2_upload_id = NULL WHERE id = %s AND b2_upload_id = %s "
                           "AND status = 'failed'", (session.id, session.b2_upload_id))
    return True


async def fail_session(storage, session, code):
    """Fail an open session (which frees its reservation) and abort its multipart upload."""
    async with db.connection() as conn:
        await conn.execute("UPDATE upload_sessions SET status = 'failed', error = %s WHERE id = %s AND status = 'open'",
                           (code, session.id))
    await abort_session_upload(storage, session)


def nonempty_filename(value):
    value = str(value)
    if not value.strip():
        raise ValueError('Must not be empty')
    return value[:512]


class Caller:
    """The token or fingerprint making the request."""

    def __init__(self, user, fingerprint):
        self.user = user
        self.fingerprint = None if user is not None else fingerprint

    def owns(self, session):
        if self.user is not None:
            return session.owner_user_id == self.user.id
        return self.fingerprint is not None and session.owner_user_id is None \
            and session.owner_fingerprint == self.fingerprint


async def caller_of(request):
    authorization = request.headers.get('authorization')
    user = None
    if authorization is not None:
        async with db.connection() as conn:
            user = await get_user(conn, authorization)
    fingerprint = parameters.fingerprint(request.headers.get('x-fingerprint')) \
        if request.headers.get('x-fingerprint') else None
    if user is None and fingerprint is None:
        raise errors.unauthorized()
    return Caller(user, fingerprint)


async def owned_session(conn, caller, upload_id, for_update=False):
    try:
        upload_id = int(upload_id)
    except ValueError:
        raise errors.unknown_upload()
    session = await queries.get_session(conn, upload_id, for_update=for_update)
    if session is None or not caller.owns(session):
        raise errors.unknown_upload()
    return session


class CreateUploadArgs(Args):
    filename: Annotated[Optional[str], Arg(type=nonempty_filename)]
    size: Annotated[Optional[int], Arg(type=uploading.positive_int)]
    # optional: the browser's File.type; otherwise the type comes from the extension
    mimetype: Annotated[Optional[str], Arg()] = None
    expires_in: Annotated[Optional[int], Arg(type=uploading.positive_int)] = None
    visibility: Annotated[Optional[str], Arg(choices=uploading.VISIBILITIES)] = None
    password: Annotated[Optional[str], Arg(type=passwords.validate, trim=False)] = None
    generate_password: Annotated[Optional[bool], Arg(type=uploading.boolean)] = False
    unlock_ttl: Annotated[Optional[int], Arg(type=uploading.unlock_ttl)] = None
    password_expires_in: Annotated[Optional[int], Arg(type=uploading.positive_int)] = None
    turnstile_token: Annotated[Optional[str], Arg()] = None
    # Milestone 3: the file joins this album (one of yours, by vanity) when it's finalized
    album: Annotated[Optional[str], Arg()] = None
    # Milestone 4 (§4.3): adult content; signed in only
    nsfw: Annotated[Optional[bool], Arg(type=uploading.boolean)] = False


@route(uploads, '', ['POST'])
@parse_args(CreateUploadArgs)
async def create_upload(request, args):
    caller = await caller_of(request)
    settings = safety_settings()
    abuse_hash, sealed_ip = abuse_ip.for_request(client_ip(request), settings)
    async with db.connection() as conn:
        await standing.check_uploader(conn, caller.user, caller.fingerprint, abuse_hash)
    if args.nsfw and caller.user is None:
        raise errors.nsfw_requires_account()
    owner = uploading.Owner(caller.user, caller.fingerprint, client_ip(request), request.app.ctx.view_hash_secret)
    limits = owner.limits
    if args.size > limits.max_file_size_chunked:
        raise limits_module.file_too_large(limits.max_file_size_chunked)
    expires_in = limits_module.resolve_expiry(limits, args.expires_in)
    if args.visibility == 'private' and caller.user is None:
        raise uploading.private_requires_account()

    async with db.connection() as conn:
        name, extension, mimetype = await uploading.resolve_name(
            conn, args.filename, None, uploading.mimetype_of(args.mimetype or 'application/octet-stream'))
        await owner.check(conn, args.size)
        await check_open_uploads(conn, owner)
        album_id = await uploading.resolve_album(conn, caller.user, args.album)

    if caller.user is None and not await Turnstile.verify(args.turnstile_token, 'upload', client_ip(request)):
        raise errors.captcha_invalid()

    access_columns, generated = await uploading.resolve_access(
        caller.user, args.visibility, args.password, args.generate_password, args.unlock_ttl,
        args.password_expires_in)

    size_of_chunk = chunk_size()
    upload_id = Snowflake.generate()
    key = storage_module.staging_key(upload_id)
    storage = request.app.ctx.storage
    b2_upload_id = await storage.create_multipart(key)
    try:
        async with db.connection() as conn:
            async with conn.transaction():
                # reserves the declared size (quota reservation) once inserted
                await owner.check(conn, args.size, lock=True)
                await check_open_uploads(conn, owner)
                session = await queries.create_session(
                    conn,
                    id=upload_id,
                    owner_user_id=caller.user.id if caller.user else None,
                    owner_fingerprint=caller.fingerprint,
                    owner_ip_hash=owner.ip_hash,
                    filename=args.filename,
                    name=name,
                    extension=extension,
                    mimetype_id=mimetype,
                    size=args.size,
                    chunk_size=size_of_chunk,
                    chunk_count=math.ceil(args.size / size_of_chunk),
                    expires_in=expires_in,
                    storage_key=key,
                    b2_upload_id=b2_upload_id,
                    expires_at=uploading.utcnow() + timedelta(hours=SESSION_HOURS),
                    album_id=album_id,
                    nsfw_marked=bool(args.nsfw),
                    owner_abuse_ip_hash=abuse_hash,
                    owner_ip_sealed=sealed_ip,
                    **access_columns,
                )
    except BaseException:
        await storage.abort_multipart(key, b2_upload_id)
        raise

    body = {
        'upload_id': str(session.id),
        'chunk_size': session.chunk_size,
        'chunk_count': session.chunk_count,
        'expires_at': epoch(session.expires_at),
    }
    if generated is not None:
        # never stored: shown once, here (the file doesn't exist yet)
        body['password'] = generated
    return ApiResponse(body, status=201)


async def read_chunk(request, expected):
    body = bytearray()
    while True:
        piece = await request.stream.read()
        if piece is None:
            break
        body += piece
        if len(body) > expected:
            raise errors.chunk_size_mismatch(expected)
    return bytes(body)


async def put_chunk(request, upload_id, index):
    caller = await caller_of(request)
    async with db.connection() as conn:
        session = await owned_session(conn, caller, upload_id)
    if session.status != 'open' or epoch(session.expires_at) <= uploading.utcnow().timestamp():
        raise errors.unknown_upload()
    try:
        index = int(index)
    except ValueError:
        raise errors.unknown_upload()
    if not 0 <= index < session.chunk_count:
        raise errors.unknown_upload()
    expected = session.chunk_length(index)
    try:
        declared = int(request.headers.get('content-length'))
    except (TypeError, ValueError):
        declared = None
    if declared is not None and declared != expected:
        raise errors.chunk_size_mismatch(expected)
    data = await read_chunk(request, expected)
    if len(data) != expected:
        raise errors.chunk_size_mismatch(expected)
    storage = request.app.ctx.storage
    if index == 0 and (filetypes.sniff_executable(data) or await safety_uploads.sniff_blocked_async(data)):
        # fail the session now rather than after the whole upload (finalize checks again), and
        # drop the parts already sent
        await fail_session(storage, session, 'FILE_TYPE_NOT_ALLOWED')
        raise errors.file_type_not_allowed()

    try:
        etag = await storage.upload_part(session.storage_key, session.b2_upload_id, index + 1, data)
    except Exception as error:
        if storage_module.missing_upload(error):
            # aborted meanwhile: the session failed, or was deleted or reaped
            raise errors.unknown_upload()
        raise
    async with db.connection() as conn:
        async with conn.transaction():
            # the row lock orders this against fail_session, DELETE and the reaper
            cursor = await conn.execute('SELECT status FROM upload_sessions WHERE id = %s FOR SHARE', (session.id,))
            row = await cursor.fetchone()
            status = row[0] if row is not None else None
            if status == 'open':
                await queries.record_part(conn, session.id, index, etag, len(data))
    if status in (None, 'failed'):
        # it failed or went away while this part was in flight, so its abort may have run before
        # the part landed: abort again (S3 asks for this)
        await storage.abort_multipart(session.storage_key, session.b2_upload_id)
    if status != 'open':
        raise errors.unknown_upload()
    return ApiResponse(status=204)


route(uploads, '/<upload_id:str>/chunks/<index:str>', ['PUT'], stream=True)(put_chunk)


@route(uploads, '/<upload_id:str>', ['GET'])
async def get_upload(request, upload_id):
    caller = await caller_of(request)
    async with db.connection() as conn:
        session = await owned_session(conn, caller, upload_id)
        received = await queries.session_part_indexes(conn, session.id)
        fobj = await queries.get_file(conn, session.file_id) if session.file_id else None
        if fobj is not None:
            await queries.attach_safety(conn, [fobj])
    body = {'status': session.status, 'received': received, 'size': session.size}
    if session.status == 'complete' and fobj is not None:
        # the uploader owns it: a protected file's URLs are signed for 1 h
        body['file'] = payloads.with_safety(payloads.public_file(fobj, grant=Grant.owner_file(fobj)), fobj)
    if session.status == 'failed':
        body['error'] = session.error or 'UPLOAD_FAILED'
    return ApiResponse(body)


@route(uploads, '/<upload_id:str>/complete', ['POST'])
async def complete_upload(request, upload_id):
    caller = await caller_of(request)
    async with db.connection() as conn:
        async with conn.transaction():
            session = await owned_session(conn, caller, upload_id, for_update=True)
            if session.status in ('processing', 'complete'):
                return ApiResponse({'status': 'processing'} if session.status == 'processing'
                                   else {'status': 'complete'}, status=202)
            if session.status != 'open':
                raise errors.unknown_upload()
            parts = await queries.session_parts(conn, session.id)
            have = {part.index for part in parts}
            missing = [i for i in range(session.chunk_count) if i not in have]
            if missing:
                raise errors.upload_incomplete(missing)
            if sum(part.size for part in parts) != session.size:
                raise errors.upload_incomplete([])
            await request.app.ctx.storage.complete_multipart(
                session.storage_key, session.b2_upload_id, [(p.index + 1, p.etag) for p in parts])
            await queries.set_session_status(conn, session.id, 'processing', from_status='open')
            await jobs.enqueue_async('finalize_upload', {'upload_id': str(session.id)}, conn=conn)
    return ApiResponse({'status': 'processing'}, status=202)


@route(uploads, '/<upload_id:str>', ['DELETE'])
async def delete_upload(request, upload_id):
    """Abort an open or failed upload: its multipart upload (and, for a failed one, any staging
    object) is removed from B2 and the row deleted, which frees the reservation. A session that is
    already processing or complete is left to finish (and to the reaper). If B2 refuses the abort,
    the session is failed and expired instead, so the upload reaper retries it."""
    caller = await caller_of(request)
    storage = request.app.ctx.storage
    async with db.connection() as conn:
        async with conn.transaction():
            session = await owned_session(conn, caller, upload_id, for_update=True)
            if session.status in ('open', 'failed'):
                gone = True
                if session.b2_upload_id:
                    gone = await storage.abort_multipart(session.storage_key, session.b2_upload_id)
                if gone and session.status == 'failed':
                    # finalize fails a session after completing its multipart upload
                    try:
                        await storage.delete(session.storage_key)
                    except Exception:
                        gone = False
                if gone:
                    await queries.delete_session(conn, session.id)
                else:
                    await conn.execute("UPDATE upload_sessions SET status = 'failed', error = COALESCE(error, "
                                       "'CANCELLED'), expires_at = now() WHERE id = %s", (session.id,))
    return ApiResponse(status=204)
