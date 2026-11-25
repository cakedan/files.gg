"""View limits (contract milestone-6 §19): a file stops being viewable after N unique viewers.

- **A viewer** is the milestone-4 abuse IP hash (HMAC with ABUSE_HASH_SECRET, IPv6 grouped by /64,
  safety/ip.py), so reopening, refreshing or coming back another day never uses a second view.
- **The owner and staff never count**: the owner's session (files.gg/api), an anonymous owner's
  guest token, an owner pass, or a staff session.
- **Counting** (`count_view`) runs in one transaction with the file row locked: the viewer's row is
  inserted if it's new, `views_used` goes up with it, and when that makes `views_used == view_limit`
  this viewer is the last one and the action fires in the same transaction:
  - `expire`: the file expires, and `access_version` is bumped so every URL given out earlier stops
    working;
  - `private`: `visibility = 'private'` and `access_version` is bumped.
  The last viewer's URLs are signed with the new `access_version`, so they still get the file (§19.4);
  for `expire` the file stays live for LAST_VIEW_SECONDS for those URLs only (see `expire_at`).
- **Once the limit is reached** the file is missing to everyone but the owner and staff, on every
  public endpoint, and it's never described as "view limit reached".
- **Signed URLs** handed to a viewer last OPEN_SECONDS (1 h), never past the file's own expiry.
"""

from db.models import epoch

MIN_LIMIT = 1
MAX_LIMIT = 1000
ACTIONS = ('expire', 'private')
DEFAULT_ACTION = 'expire'
# what a viewer's signed URLs from /access/open last (they call it again to refresh)
OPEN_SECONDS = 3600
# milestone-6 §19.4 says `expire` sets expires_at = now(). Then the last viewer's URLs would point at an
# expired file, which the CDN answers 404, so "the last viewer still gets the file" couldn't hold. The file
# expires this long after the last view instead: long enough for the last viewer's 1 h URLs, and nobody else
# can open it meanwhile (`reached`), nor use a URL given out before (the access_version bump).
LAST_VIEW_SECONDS = OPEN_SECONDS


def limit_value(value):
    """`view_limit` on uploads and the owner PATCH: 1 to 1000. An empty form value means none."""
    if isinstance(value, bool):
        raise ValueError('Must be a number from {} to {}'.format(MIN_LIMIT, MAX_LIMIT))
    if isinstance(value, str) and not value.strip():
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError('Must be a number from {} to {}'.format(MIN_LIMIT, MAX_LIMIT))
    if isinstance(value, float) and value != number:
        raise ValueError('Must be a number from {} to {}'.format(MIN_LIMIT, MAX_LIMIT))
    if not MIN_LIMIT <= number <= MAX_LIMIT:
        raise ValueError('Must be a number from {} to {}'.format(MIN_LIMIT, MAX_LIMIT))
    return number


def action_value(value):
    text = str(value).strip().lower()
    if text not in ACTIONS:
        raise ValueError('Must be expire or private')
    return text


def limited(fobj):
    return getattr(fobj, 'view_limit', None) is not None


def remaining(fobj):
    return max(0, int(fobj.view_limit) - int(fobj.views_used or 0)) if limited(fobj) else None


def reached(fobj):
    """The limit is used up: the action fired, so the file is missing to everyone but its owner and staff."""
    return limited(fobj) and int(fobj.views_used or 0) >= int(fobj.view_limit)


def public_field(fobj):
    """The public payload's `view_limit` (§19.6), or None when there's no limit."""
    return {'remaining': remaining(fobj)} if limited(fobj) else None


def lookup_field(fobj):
    """The internal lookup's `view_limit` (§19.5), or None."""
    if not limited(fobj):
        return None
    return {'limit': int(fobj.view_limit), 'used': int(fobj.views_used or 0), 'action': fobj.view_limit_action}


def owner_fields(fobj):
    """The owner payload's additions (§19.6)."""
    return {'view_limit': fobj.view_limit, 'view_limit_action': fobj.view_limit_action,
            'views_used': int(fobj.views_used or 0)}


def url_expiry(fobj, expires):
    """A viewer's signed URLs end at `expires`, or at the file's own expiry when that's earlier."""
    file_expiry = epoch(fobj.expires_at)
    return min(int(expires), file_expiry) if file_expiry is not None else int(expires)


def stub(fobj):
    """`GET /files/<vanity>` for a view-limited `link` file before /access/open: no name, no URLs (§19.4)."""
    return {'vanity': fobj.vanity, 'view_limited': True, 'views_remaining': remaining(fobj)}


def with_stub(data, fobj):
    """A locked password file's payload, saying unlocking uses a view."""
    if limited(fobj):
        data['view_limited'] = True
        data['views_remaining'] = remaining(fobj)
    return data


# --- who never counts ------------------------------------------------------------------------------------------

async def is_staff(conn, user):
    """A staff member in good standing (a suspended one is no staff member, milestone-4 §8.4)."""
    if user is None:
        return False
    from utils import standing
    cursor = await conn.execute('SELECT 1 FROM staff WHERE user_id = %s', (user.id,))
    if await cursor.fetchone() is None:
        return False
    return await standing.suspension(conn, user.id) is None


async def privileged(conn, request, fobj, claims=None):
    """The owner (session, or an anonymous upload's guest), an owner pass, or staff: served without
    counting, whatever the limit."""
    from utils import access
    from utils.auth import guest_of
    if claims is not None and claims.get('s') == 'owner':
        return True
    user = await access.optional_user(conn, request)
    if access.is_owner(fobj, user, guest_of(request)):
        return True
    return await is_staff(conn, user)


# --- counting --------------------------------------------------------------------------------------------------

def viewer_of(request):
    """The viewer's abuse IP hash, or None when there's no usable IP or secret."""
    from safety import ip as abuse_ip
    from safety.settings import safety_settings
    from utils.helpers import client_ip
    return abuse_ip.abuse_ip_hash(client_ip(request), safety_settings().abuse_hash_secret)


async def count_view(conn, request, fobj):
    """Count this request's viewer for a view-limited file (one transaction, the file row locked) and return the
    file as it is now. A viewer already counted reopens without counting. Raises UNKNOWN_FILE once the limit is
    used up (or the file went away meanwhile), exactly like a missing file. The returned file's
    `access_version` is the one the viewer's URLs must be signed with: after the last view, the new one."""
    from db import queries
    from utils import errors
    if not limited(fobj):
        return fobj
    viewer = viewer_of(request)
    if viewer is None:
        # no IP to count by: never serve uncounted (fail closed)
        raise errors.forbidden("This file can't be opened right now")
    async with conn.transaction():
        cursor = await conn.execute(
            'SELECT view_limit, view_limit_action, views_used FROM files AS f WHERE f.id = %s AND {} '
            'FOR UPDATE'.format(queries.LIVE), (fobj.id,))
        row = await cursor.fetchone()
        if row is None:
            raise errors.unknown_file()
        limit, action, used = row
        if limit is None:
            # the owner removed the limit meanwhile
            return await _reload(conn, fobj)
        if used >= limit:
            raise errors.unknown_file()
        cursor = await conn.execute(
            'INSERT INTO file_limit_viewers (file_id, viewer) VALUES (%s, %s) ON CONFLICT DO NOTHING RETURNING 1',
            (fobj.id, viewer))
        if await cursor.fetchone() is None:
            return await _reload(conn, fobj)
        used += 1
        if used < limit:
            await conn.execute('UPDATE files SET views_used = %s WHERE id = %s', (used, fobj.id))
        elif action == 'private':
            await conn.execute("UPDATE files SET views_used = %s, visibility = 'private', "
                               'access_version = access_version + 1 WHERE id = %s', (used, fobj.id))
        else:
            await conn.execute(
                'UPDATE files SET views_used = %s, access_version = access_version + 1, '
                "expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), "
                'now() + make_interval(secs => %s)) WHERE id = %s', (used, LAST_VIEW_SECONDS, fobj.id))
        return await _reload(conn, fobj)


async def _reload(conn, fobj):
    """The file row as it is now (live or not: the last viewer of a `private` file still gets it)."""
    from db import queries
    fresh = await queries.get_file(conn, fobj.id)
    if fresh is None:
        from utils import errors
        raise errors.unknown_file()
    fresh.user = fobj.user
    return fresh
