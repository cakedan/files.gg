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

import utils.parameters as parameters

uploads = Blueprint('uploads', url_prefix='/uploads')

DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
SESSION_HOURS = 24


def chunk_size():
    return int(os.getenv('UPLOAD_CHUNK_SIZE', DEFAULT_CHUNK_SIZE))


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


@route(uploads, '', ['POST'])
@parse_args(CreateUploadArgs)
async def create_upload(request, args):
    caller = await caller_of(request)
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
    if index == 0 and filetypes.sniff_executable(data):
        # fail the session now rather than after the whole upload; finalize checks again
        async with db.connection() as conn:
            await conn.execute("UPDATE upload_sessions SET status = 'failed', error = 'FILE_TYPE_NOT_ALLOWED' "
                               "WHERE id = %s AND status = 'open'", (session.id,))
        raise errors.file_type_not_allowed()

    etag = await request.app.ctx.storage.upload_part(session.storage_key, session.b2_upload_id, index + 1, data)
    async with db.connection() as conn:
        await queries.record_part(conn, session.id, index, etag, len(data))
    return ApiResponse(status=204)


route(uploads, '/<upload_id:str>/chunks/<index:str>', ['PUT'], stream=True)(put_chunk)


@route(uploads, '/<upload_id:str>', ['GET'])
async def get_upload(request, upload_id):
    caller = await caller_of(request)
    async with db.connection() as conn:
        session = await owned_session(conn, caller, upload_id)
        received = await queries.session_part_indexes(conn, session.id)
        fobj = await queries.get_file(conn, session.file_id) if session.file_id else None
    body = {'status': session.status, 'received': received, 'size': session.size}
    if session.status == 'complete' and fobj is not None:
        # the uploader owns it: a protected file's URLs are signed for 1 h
        body['file'] = payloads.public_file(fobj, grant=Grant.owner_file(fobj))
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
    """Abort an open upload and free its reservation. A session that is already
    processing or complete is left to finish (and to the reaper)."""
    caller = await caller_of(request)
    async with db.connection() as conn:
        async with conn.transaction():
            session = await owned_session(conn, caller, upload_id, for_update=True)
            if session.status in ('open', 'failed'):
                if session.status == 'open' and session.b2_upload_id:
                    await request.app.ctx.storage.abort_multipart(session.storage_key, session.b2_upload_id)
                await queries.delete_session(conn, session.id)
    return ApiResponse(status=204)
