"""Who is calling an owner endpoint (contract milestone-3 §6): a signed-in user, or a guest
(`Authorization: Guest`, milestone-5 §20) that gets its own anonymous files and albums."""

from utils import limits as limits_module
from utils import errors


class Caller:
    def __init__(self, user, guest_id):
        self.user = user
        self.guest_id = None if user is not None else guest_id
        self.limits = limits_module.get_limits(user)

    @property
    def anonymous(self):
        return self.user is None

    def file_filter(self, alias='f'):
        if self.user is not None:
            return '{}.user_id = %s'.format(alias), [self.user.id]
        return '{0}.user_id IS NULL AND {0}.guest_id = %s'.format(alias), [self.guest_id]

    def album_filter(self, alias='al'):
        if self.user is not None:
            return '{}.owner_user_id = %s'.format(alias), [self.user.id]
        return '{0}.owner_user_id IS NULL AND {0}.owner_guest_id = %s'.format(alias), [self.guest_id]

    def owns_file(self, fobj):
        if self.user is not None:
            return fobj.user_id == self.user.id
        return fobj.user_id is None and fobj.guest_id == self.guest_id


async def caller_of(conn, request):
    """The signed-in user (the session cookie), else the guest; 401 with neither. A dead session
    cookie is a 401, never a silent fall back to the guest."""
    from utils.auth import auth_of
    current = auth_of(request)
    if current.kind == 'session':
        # owner payloads use the owner's link domain and domain-only signing (milestone-6 §10.6, §10.9)
        from utils import links
        await links.prepare(conn, current.user)
        return Caller(current.user, None)
    if current.dead:
        raise errors.unauthorized()
    if current.guest_id is None:
        raise errors.unauthorized()
    return Caller(None, current.guest_id)
