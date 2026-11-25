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
    """A row of `users` (contract milestone-6 §1.1), plus `premium` from `user_entitlements`
    (§9.1), which the user loaders (utils/accounts.py) select with it."""
    TABLE = 'users'

    id: int
    email: Optional[str]
    username: str
    # manual storage limit (PLAN.md "Limits"); wins over the plan and premium defaults
    storage_limit_override: Optional[int]
    display_name: Optional[str] = None
    email_verified: bool = False
    pending_email: Optional[str] = None
    password_hash: Optional[str] = None
    needs_username: bool = False
    username_changed_at: Optional[datetime] = None
    show_name_on_albums: bool = False
    domain_only: bool = False
    domain_only_paused_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    deletion_requested_at: Optional[datetime] = None
    deletion_scheduled_for: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    # milestone-5 §21: what key uploads and conversions get when they don't say (utils/upload_defaults.py)
    upload_defaults: Optional[dict] = None
    premium: bool = virtual(False)
    premium_expires_at: Optional[datetime] = virtual()

    @property
    def state(self):
        if self.deleted_at is not None:
            return 'deleted'
        if self.deletion_requested_at is not None:
            return 'pending_deletion'
        return 'active'

    def public_dict(self):
        """The public user object (§2.1): album owner lines, report targets shown to staff."""
        return {'id': str(self.id), 'username': self.username, 'display_name': self.display_name}


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
    # the probe output (width, height, duration, ...), and pending -> probed -> done (or
    # failed / skipped)
    media: Optional[dict] = None
    processing_state: str = 'pending'
    probed_at: Optional[datetime] = None
    # also the version of the previews (?v=)
    derived_at: Optional[datetime] = None
    # Milestone 4 (contract §1, §2): the scan, per content
    scan_state: str = 'pending'
    scan_reason: Optional[str] = None
    scan: Optional[dict] = None
    scanned_at: Optional[datetime] = None
    next_rescan_at: Optional[datetime] = None
    nsfw_score: Optional[float] = None
    nsfw_auto: bool = False
    serve_inline: bool = True
    # migration 0004: scan jobs the sweeper found failed; held for staff (still pending) at the limit
    scan_failures: int = 0
    scan_stuck_at: Optional[datetime] = None
    # Milestone 5 (§9.1): the document preview, none -> queued -> done / failed / skipped
    preview_state: str = 'none'
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
    guest_id: Optional[int]
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
    # Milestone 4 (contract §1): moderation, NSFW marks, rejections and abuse IP hashes
    moderation_state: str = 'visible'
    moderation_rule: Optional[str] = None
    moderated_at: Optional[datetime] = None
    moderation_auto: bool = False
    nsfw_marked: bool = False
    nsfw_override: Optional[str] = None
    nsfw_override_source: Optional[str] = None
    deleted_reason: Optional[str] = None
    uploader_abuse_ip_hash: Optional[bytes] = None
    uploader_ip_sealed: Optional[bytes] = None
    nsfw_unmarked_at: Optional[datetime] = None
    # Milestone 6 (§1.3): the upload key that uploaded it
    upload_key_id: Optional[int] = None
    # Milestone 6 §19: unique viewers allowed (None = no limit), what happens at the limit, and how many were used
    view_limit: Optional[int] = None
    view_limit_action: str = 'expire'
    views_used: int = 0
    # Milestone 5 (§2.3): provenance of a conversion output
    derived_from_file_id: Optional[int] = None
    conversion_id: Optional[int] = None
    hash: Optional[FileHash] = virtual()
    user: Optional[User] = virtual()
    # [(album id, vanity, title)] for the owner's view, when loaded
    albums: Optional[list] = virtual()
    # Milestone 4, for owner payloads (queries.attach_safety): {"notice_id", "nsfw_review"}
    safety_extra: Optional[dict] = virtual()

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
    owner_guest_id: Optional[int]
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
    # Milestone 4: copied to the file at finalize
    nsfw_marked: bool = False
    owner_abuse_ip_hash: Optional[bytes] = None
    owner_ip_sealed: Optional[bytes] = None
    # Milestone 6 (§7.5): every later call must come from this key (or the owner's session)
    upload_key_id: Optional[int] = None
    # Milestone 6 §19: copied to the file at finalize
    view_limit: Optional[int] = None
    view_limit_action: str = 'expire'

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
    # Milestone 5 (§9.2): the document preview's page count (only for `document`)
    pages: Optional[int] = None


@dataclass
class Album:
    TABLE = 'albums'

    id: int
    vanity: str
    owner_user_id: Optional[int]
    owner_guest_id: Optional[int]
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
    # Milestone 4: `nsfw` is the explicit mark, by `owner` or `moderator`
    nsfw_source: Optional[str] = None
    moderation_rule: Optional[str] = None
    moderated_at: Optional[datetime] = None
    moderation_auto: bool = False
    link_warnings: list = field(default_factory=list)
    deleted_reason: Optional[str] = None


@dataclass
class AlbumFile:
    TABLE = 'album_files'

    album_id: int
    file_id: int
    position: int
    caption: Optional[str]
    added_at: datetime


# Every row type; each names all of its table's columns, in table order (tests/test_migrations.py).
ROW_TYPES = (User, MimetypeExtension, Mimetype, FileHash, File, FileViewDay, UploadSession, UploadPart, FileHashAsset,
             Album, AlbumFile)
