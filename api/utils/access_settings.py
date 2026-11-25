"""Changing a file's or an album's access settings (contract milestone-2 §5 PATCH,
milestone-3 §6 bulk access and album PATCH): the same rules everywhere.

Changing the visibility or the password, or shortening unlock_ttl or
password_expires_at, bumps access_version, which revokes every outstanding token and
#pw= link.
"""

from db.models import epoch
from utils import passwords, uploading
from utils import errors

ACCESS_FIELDS = ('visibility', 'password', 'generate_password', 'unlock_ttl', 'password_expires_at',
                 'password_expires_in', 'show_name_when_locked')


class NewPassword:
    """A password set once for a whole request (one generated password for a batch)."""

    def __init__(self, plain=None, hashed=None, generated=False):
        self.plain = plain
        self.hashed = hashed
        self.generated = generated

    @classmethod
    async def from_args(cls, args):
        if args.generate_password:
            plain = passwords.generate_passphrase()
            return cls(plain, await passwords.hash(plain), True)
        if args.password is not None:
            return cls(args.password, await passwords.hash(args.password))
        return cls()


def access_changes(target, args, sent, now, password, anonymous=False):
    """Column changes for `target` (a File or Album row). `sent` is the set of field
    names present in the request (to tell "null" from "not sent"); `password` a
    NewPassword. Returns (changes, bump)."""
    changes, bump = {}, False
    visibility = args.visibility
    if visibility is None and password.hashed is not None:
        visibility = 'password'
    visibility = visibility or target.visibility
    if visibility == 'private' and anonymous:
        raise uploading.private_requires_account()
    if visibility != target.visibility:
        changes['visibility'] = visibility
        bump = True
    if visibility == 'password':
        if password.hashed is not None:
            changes['password_hash'] = password.hashed
            bump = True
        elif target.password_hash is None:
            raise errors.password_required()
    elif target.password_hash is not None:
        changes['password_hash'] = None

    if args.unlock_ttl is not None and args.unlock_ttl != target.unlock_ttl:
        changes['unlock_ttl'] = args.unlock_ttl
        bump = bump or args.unlock_ttl < target.unlock_ttl

    old = epoch(target.password_expires_at)
    new = old
    if args.password_expires_in is not None:
        new = now + args.password_expires_in
    elif 'password_expires_at' in sent:
        new = args.password_expires_at
    if new != old:
        changes['password_expires_at'] = uploading.from_epoch(new) if new is not None else None
        bump = bump or (new is not None and (old is None or new < old))

    if args.show_name_when_locked is not None and args.show_name_when_locked != target.show_name_when_locked:
        changes['show_name_when_locked'] = args.show_name_when_locked
    if bump:
        changes['access_version'] = target.access_version + 1
    return changes, bump


def sent_fields(request):
    """Field names present in the JSON body, the query string or the form."""
    from utils.params import request_json
    body = request_json(request)
    sent = set(body) if isinstance(body, dict) else set()
    return sent | set(request.get_args(keep_blank_values=True)) | set(request.form or {})
