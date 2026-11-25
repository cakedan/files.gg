"""Public album endpoints (contract milestone-3 §6, milestone-2 §5):

    GET  /albums/<vanity>?cursor           the album payload, 100 items a page
    POST /access/unlock/albums/<vanity>    { password, turnstile_token }
    POST /access/refresh/albums/<vanity>   { token }
    GET  /access/view/albums/<vanity>      X-Filesgg-Access: <token>

(milestone-6 §20.1: the vanity is always the last path segment; the access routes share the `access` blueprint.)

The access rules are the files' ones: a password album shows a locked payload
without a token, a private album is unknown to everyone but its owner (and owner passes).
An album with nothing to show is unknown too (the viewer's `missing`). A protected album's
URLs are signed with the album grant for whoever may see it (unlock, token or owner).
"""

from typing import Annotated, Optional

from sanic import Blueprint

import db
from db import albums as album_queries
from utils import access, access_token, errors, passwords
from utils import albums as album_rules
from utils.cdn_signing import Grant
from utils.accounts import owner_offline
from utils.auth import guest_of
from utils.helpers import client_ip
from utils.params import Arg, Args
from utils.responses import ApiResponse
from utils.turnstile import Turnstile
from utils.wrappers import parse_args, route
from views.files import access_routes


albums = Blueprint('albums', url_prefix='/albums')


def _cursor(value):
    if value is None or value == '':
        return None
    number = int(value)
    if number < 0:
        raise ValueError('Must be a cursor from next_cursor')
    return number


class AlbumArgs(Args):
    cursor: Annotated[Optional[int], Arg(location='args', type=_cursor)] = None


async def album_body(conn, album, after=None, grant=None):
    """The public payload (URLs signed with `grant`), or None when the album shows nothing.
    With nothing shown yet but items still being checked (milestone-4 §6.4): the payload with
    `items: []` and `pending_count`."""
    items, cursor = await album_queries.shown_items(conn, album, after=after)
    count, size = await album_queries.shown_totals(conn, album.id)
    if count == 0:
        pending = await album_queries.pending_count(conn, album.id)
        if not pending:
            return None
        body = album_rules.album_payload(album, [], 0, 0, None, cover_items=[], grant=grant)
        body['pending_count'] = pending
        return body
    cover_items = [f for f, _, _ in items]
    if album.cover_file_id is not None and album.cover_file_id not in {f.id for f in cover_items}:
        first, _ = await album_queries.shown_items(conn, album, limit=None)
        cover_items = [f for f, _, _ in first]
    nsfw = await album_queries.any_shown_nsfw(conn, album.id)
    body = album_rules.album_payload(album, items, count, size, cursor, cover_items=cover_items, grant=grant,
                                     nsfw=nsfw)
    body['owner'] = await album_owner(conn, album)
    return body


async def album_owner(conn, album):
    """Milestone-6 §8.6: `{ id, username, display_name }` when the owner turned on "Show my name on albums"."""
    if album.owner_user_id is None:
        return None
    cursor = await conn.execute('SELECT id, username, display_name FROM users WHERE id = %s AND show_name_on_albums '
                                'AND deleted_at IS NULL', (album.owner_user_id,))
    row = await cursor.fetchone()
    return {'id': str(row[0]), 'username': row[1], 'display_name': row[2]} if row else None


def check_removed(album):
    """410 ALBUM_REMOVED { reason } for a hidden or removed album (milestone-4 §6.4)."""
    if album.moderation_state != 'visible':
        raise errors.album_removed(album_rules.album_safety(album)['reason'])


def _is_owner(album, user, guest_id):
    if user is not None and album.owner_user_id == user.id:
        return True
    return album.owner_user_id is None and guest_id is not None and album.owner_guest_id == guest_id


def _album_claims(request, album, token):
    return access.token_claims(request, album, token, kind='album')


@route(albums, '/<vanity:str>', ['GET'])
@parse_args(AlbumArgs)
async def fetch_album(request, args, vanity):
    async with db.connection() as conn:
        album = await album_queries.get_album_by_vanity(conn, vanity)
        if album is None or await owner_offline(conn, album.owner_user_id):
            raise errors.unknown_album()
        full, grant = album.visibility == 'link', None
        if not full:
            user = await access.optional_user(conn, request)
            claims = _album_claims(request, album, request.ctx.access_token)
            if _is_owner(album, user, guest_of(request)):
                full, grant = True, Grant.owner_album(album)
            elif claims is not None:
                full, grant = True, Grant.for_album(album, claims['e'])
        if album.visibility == 'private' and not full:
            raise errors.unknown_album()
        check_removed(album)
        body = await album_body(conn, album, args.cursor, grant) if full or album.visibility == 'password' else None
    if body is None:
        raise errors.unknown_album()
    if not full:
        return ApiResponse(album_rules.locked_album(album, access.password_has_expired(album)))
    return ApiResponse(body)


class UnlockArgs(Args):
    password: Annotated[Optional[str], Arg(trim=False)] = None
    turnstile_token: Annotated[Optional[str], Arg()] = None


class RefreshArgs(Args):
    token: Annotated[Optional[str], Arg(trim=False)] = None


@route(access_routes, '/unlock/albums/<vanity:str>', ['POST'])
@parse_args(UnlockArgs)
async def unlock_album(request, args, vanity):
    """Turnstile, then the rate limit, then password expiry, then the password."""
    async with db.connection() as conn:
        album = await album_queries.get_album_by_vanity(conn, vanity)
        if album is None or album.visibility == 'private' or await owner_offline(conn, album.owner_user_id):
            raise errors.unknown_album()
        check_removed(album)
        if await album_body(conn, album) is None:
            raise errors.unknown_album()
    if not await Turnstile.verify(args.turnstile_token, 'unlock', client_ip(request)):
        raise errors.captcha_invalid()
    await access.rate_limit(request, album, 'unlock', kind='album')
    if album.visibility == 'password':
        if access.password_has_expired(album):
            raise errors.password_expired()
        if not await passwords.verify(album.password_hash, args.password):
            raise errors.wrong_password()
    unlocked_at = access.now()
    expires_at = access.unlock_expiry(album, unlocked_at)
    async with db.connection() as conn:
        body = await album_body(conn, album, grant=Grant.for_album(album, expires_at))
    return ApiResponse({
        'token': access.mint(request, album, 'unlock', unlocked_at, expires_at, kind='album'),
        'expires_at': expires_at,
        'album': body,
    })


@route(access_routes, '/refresh/albums/<vanity:str>', ['POST'])
@parse_args(RefreshArgs)
async def refresh_album_unlock(request, args, vanity):
    async with db.connection() as conn:
        album = await album_queries.get_album_by_vanity(conn, vanity)
        if album is None or await owner_offline(conn, album.owner_user_id):
            raise errors.unknown_album()
        claims = _album_claims(request, album, args.token)
        if album.visibility == 'private' and (claims is None or claims['s'] != 'owner'):
            raise errors.unknown_album()
        check_removed(album)
        await access.rate_limit(request, album, 'access', kind='album')
    if claims is None:
        raise errors.unlock_expired()
    now = access.now()
    if claims['s'] == 'owner':
        expires_at = min(now + access_token.REFRESH_SECONDS, claims['u'] + access_token.OWNER_PASS_MAX_SECONDS)
    else:
        expires_at = min(now + access_token.REFRESH_SECONDS, access.unlock_expiry(album, claims['u']))
    if expires_at <= now:
        raise errors.unlock_expired()
    async with db.connection() as conn:
        body = await album_body(conn, album, grant=Grant.for_album(album, expires_at))
    if body is None:
        raise errors.unknown_album()
    return ApiResponse({
        'token': access.mint(request, album, claims['s'], claims['u'], expires_at, kind='album'),
        'expires_at': expires_at,
        'album': body,
    })


@route(access_routes, '/view/albums/<vanity:str>', ['GET'])
async def view_album(request, vanity):
    async with db.connection() as conn:
        album = await album_queries.get_album_by_vanity(conn, vanity)
        if album is None or await owner_offline(conn, album.owner_user_id):
            raise errors.unknown_album()
        claims = _album_claims(request, album, request.ctx.access_token)
        if album.visibility == 'private' and claims is None:
            raise errors.unknown_album()
        check_removed(album)
        await access.rate_limit(request, album, 'access', kind='album')
        if claims is None:
            raise errors.unlock_expired()
        body = await album_body(conn, album, grant=Grant.for_album(album, claims['e']))
    if body is None:
        raise errors.unknown_album()
    return ApiResponse({'album': body, 'expires_at': claims['e']})
