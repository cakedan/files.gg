"""Row types for the tables. A file's JSON shape is in utils/payloads.py (one shape for
every endpoint); users and mimetypes keep their small `to_dict()`."""

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
    # manual storage limit bump (PLAN.md "Limits"); None = the default
    storage_limit_override: Optional[int]

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
    # Milestone 3: the probe output, and pending -> probed -> done (or failed / skipped)
    media: Optional[dict] = None
    processing_state: str = 'pending'
    probed_at: Optional[datetime] = None
    # also the version of the previews (?v=)
    derived_at: Optional[datetime] = None
    # file_hash_assets rows, when loaded (queries.attach_assets)
    assets: List['FileHashAsset'] = virtual(factory=list)


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
    size: Optional[int] = None
    expires_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    visibility: str = 'link'
    password_hash: Optional[str] = None
    access_version: int = 0
    unlock_ttl: int = 3600
    password_expires_at: Optional[datetime] = None
    show_name_when_locked: bool = False
    uploader_ip_hash: Optional[bytes] = None
    hash: Optional[FileHash] = virtual()
    user: Optional[User] = virtual()
    # [(album id, vanity, title)] for the owner's view, when loaded
    albums: Optional[list] = virtual()

    @property
    def suffix(self):
        """'.<extension>', or '' without one (the URL is then just the vanity)."""
        return '.' + self.extension if self.extension else ''

    @property
    def full_filename(self):
        """The name plus the extension: what downloads and the ZIP use."""
        return self.filename + self.suffix


def epoch(value):
    """Epoch seconds of a timestamptz value, or None."""
    return int(value.timestamp()) if value is not None else None


@dataclass
class UploadSession:
    TABLE = 'upload_sessions'

    id: int
    owner_user_id: Optional[int]
    owner_fingerprint: Optional[int]
    owner_ip_hash: Optional[bytes]
    filename: str
    name: str
    extension: Optional[str]
    mimetype_id: str
    size: int
    chunk_size: int
    chunk_count: int
    expires_in: Optional[int]
    visibility: str
    password_hash: Optional[str]
    unlock_ttl: int
    password_expires_at: Optional[datetime]
    storage_key: str
    b2_upload_id: Optional[str]
    status: str
    error: Optional[str]
    file_id: Optional[int]
    created_at: datetime
    expires_at: datetime
    # Milestone 3: `album=<vanity>` on POST /uploads; the file joins it when finalized
    album_id: Optional[int] = None

    def chunk_length(self, index):
        """The exact size chunk `index` must have."""
        if index == self.chunk_count - 1:
            return self.size - self.chunk_size * (self.chunk_count - 1)
        return self.chunk_size


@dataclass
class UploadPart:
    TABLE = 'upload_parts'

    session_id: int
    index: int
    etag: str
    size: int
    received_at: datetime


@dataclass
class FileViewDay:
    TABLE = 'file_view_days'

    file_id: int
    day: object
    views: int
    unique_views: int


@dataclass
class FileHashAsset:
    TABLE = 'file_hash_assets'

    hash_id: int
    # a preview kind (media.PREVIEW_KINDS): thumb, thumb-2x, display, poster, cover, ...
    kind: str
    storage_key: str
    content_type: str
    size: int
    width: Optional[int]
    height: Optional[int]
    created_at: datetime


@dataclass
class Album:
    TABLE = 'albums'

    id: int
    vanity: str
    owner_user_id: Optional[int]
    owner_fingerprint: Optional[int]
    title: Optional[str]
    description: Optional[str]
    cover_file_id: Optional[int]
    layout: str
    nsfw: bool
    expires_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime
    deleted_at: Optional[datetime]
    moderation_state: str
    visibility: str
    password_hash: Optional[str]
    access_version: int
    unlock_ttl: int
    password_expires_at: Optional[datetime]
    show_name_when_locked: bool
    collage_key: Optional[str]
    collage_version: Optional[int]
    empty_since: Optional[datetime]


@dataclass
class AlbumFile:
    TABLE = 'album_files'

    album_id: int
    file_id: int
    position: int
    caption: Optional[str]
    added_at: datetime


# Row types and the table columns they deliberately leave out (legacy columns
# that only exist until pending/0004_drop_legacy.sql).
ROW_TYPES = (User, MimetypeExtension, Mimetype, FileHash, File, FileViewDay, UploadSession, UploadPart, FileHashAsset,
             Album, AlbumFile)
LEGACY_COLUMNS = {'users': ('last_email_reset', 'last_password_reset')}
