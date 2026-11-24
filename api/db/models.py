"""Row types for the baseline tables, and their API JSON shapes.

`to_dict()` output must stay byte-identical to the Flask/Peewee version
(tests/fixtures/golden/flask_responses.json): the frontend and ShareX depend
on it, including key order.
"""

from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import List, Optional


def columns(cls, alias=None):
    """Comma-separated column list for a row dataclass, in field order."""
    prefix = '{}.'.format(alias) if alias else ''
    return ', '.join('{}"{}"'.format(prefix, f.name) for f in fields(cls) if not f.metadata.get('virtual'))


def from_row(cls, row, offset=0):
    """Build `cls` from a tuple row that selected `columns(cls)` at `offset`."""
    names = [f.name for f in fields(cls) if not f.metadata.get('virtual')]
    return cls(**dict(zip(names, row[offset:offset + len(names)])))


def width(cls):
    return len([f for f in fields(cls) if not f.metadata.get('virtual')])


def virtual(default=None, factory=None):
    if factory is not None:
        return field(default_factory=factory, metadata={'virtual': True})
    return field(default=default, metadata={'virtual': True})


@dataclass
class User:
    TABLE = 'users'

    id: int
    email: str
    bot: bool
    username: str
    discriminator: int
    password: Optional[str]
    flags: int
    verified: bool
    # timestamptz since 0003; the legacy unix-seconds columns (last_email_reset,
    # last_password_reset) are only written, for old servers, until 0004 drops them
    last_email_reset_at: Optional[datetime]
    last_password_reset_at: Optional[datetime]

    def to_dict(self, me=False):
        data = {
            'id': str(self.id),
            'username': self.username,
            'discriminator': '{:04d}'.format(self.discriminator),
            'flags': self.flags,
        }
        if self.bot:
            data['bot'] = self.bot
        if me:
            data.update({
                'email': self.email,
                'verified': self.verified,
            })
        return data


@dataclass
class MimetypeExtension:
    TABLE = 'mimetype_extensions'

    mimetype_id: str
    extension: str
    priority: int

    def to_dict(self):
        return {
            'extension': self.extension,
            'priority': self.priority,
        }


@dataclass
class Mimetype:
    TABLE = 'mimetypes'

    id: str
    flags: int
    type_id: Optional[str]
    extensions: List[MimetypeExtension] = virtual(factory=list)

    def to_dict(self):
        return {
            'mimetype': self.id,
            'type': self.type_id,
            'flags': self.flags,
            'extensions': [x.to_dict() for x in self.extensions],
        }


@dataclass
class FileHash:
    TABLE = 'file_hashes'

    id: int
    blake2b: str
    sha1: str
    md5: str
    size: int
    height: Optional[int]
    width: Optional[int]
    duration: Optional[int]


@dataclass
class File:
    TABLE = 'files'

    id: int
    vanity: str
    mimetype_id: str
    extension: Optional[str]
    filename: str
    hash_id: int
    user_id: Optional[int]
    fingerprint: Optional[int]
    view_count: int
    hash: Optional[FileHash] = virtual()
    user: Optional[User] = virtual()

    def to_dict(self):
        extension = self.extension or 'unknown'
        # no extension: the URL is just the vanity, with no trailing dot
        suffix = '.' + self.extension if self.extension else ''
        return {
            'id': str(self.id),
            'vanity': self.vanity,
            'mimetype': self.mimetype_id,
            'extension': extension,
            'name': self.filename,
            'filename': '{}.{}'.format(self.filename, extension),
            'hash': str(self.hash_id),
            'size': self.hash.size,
            'height': self.hash.height,
            'width': self.hash.width,
            'duration': self.hash.duration,
            'user': self.user and self.user.to_dict(),
            'urls': {
                'main': 'https://files.gg/' + self.vanity + suffix,
                'cdn': 'https://cdn.files.gg/files/' + self.vanity + suffix,
            },
            'views': self.view_count,
        }


@dataclass
class FileViewDay:
    TABLE = 'file_view_days'

    file_id: int
    day: object
    views: int
    unique_views: int


# Row types and the table columns they deliberately leave out (legacy columns
# that only exist until pending/0004_drop_legacy.sql).
ROW_TYPES = (User, MimetypeExtension, Mimetype, FileHash, File, FileViewDay)
LEGACY_COLUMNS = {'users': ('last_email_reset', 'last_password_reset')}
