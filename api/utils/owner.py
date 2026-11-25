"""Who is calling an owner endpoint (contract milestone-3 §6): a signed-in user, or an
anonymous fingerprint (`X-Fingerprint`) that gets its own anonymous files and albums."""

from utils import limits as limits_module
from utils.helpers import get_user
from utils import errors

import utils.parameters as parameters


class Caller:
    def __init__(self, user, fingerprint):
        self.user = user
        self.fingerprint = None if user is not None else fingerprint
        self.limits = limits_module.get_limits(user)

    @property
    def anonymous(self):
        return self.user is None

    def file_filter(self, alias='f'):
        if self.user is not None:
            return '{}.user_id = %s'.format(alias), [self.user.id]
        return '{0}.user_id IS NULL AND {0}.fingerprint = %s'.format(alias), [self.fingerprint]

    def album_filter(self, alias='al'):
        if self.user is not None:
            return '{}.owner_user_id = %s'.format(alias), [self.user.id]
        return '{0}.owner_user_id IS NULL AND {0}.owner_fingerprint = %s'.format(alias), [self.fingerprint]

    def owns_file(self, fobj):
        if self.user is not None:
            return fobj.user_id == self.user.id
        return fobj.user_id is None and fobj.fingerprint == self.fingerprint


async def caller_of(conn, request):
    """The signed-in user, else the fingerprint; 401 with neither. A bad token is a 401,
    never a silent fall back to the fingerprint."""
    authorization = request.headers.get('authorization')
    if authorization is not None:
        return Caller(await get_user(conn, authorization), None)
    raw = request.headers.get('x-fingerprint')
    fingerprint = parameters.fingerprint(raw) if raw else None
    if fingerprint is None:
        raise errors.unauthorized()
    return Caller(None, fingerprint)
