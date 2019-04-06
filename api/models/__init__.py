import peewee
import os

from playhouse.db_url import connect
from peewee_extra_fields import IPNetworkField

db_url = os.getenv('DATABASE_URL')
if db_url is None:
    raise Exception('Database URL Required')
db = connect(db_url)


class BaseModel(peewee.Model):
    class Meta:
        database = db


class User(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)
    email = peewee.CharField(max_length=128)
    bot = peewee.BooleanField(default=False)
    username = peewee.CharField(max_length=32)
    discriminator = peewee.IntegerField()
    password = peewee.CharField(max_length=128, null=True)
    flags = peewee.IntegerField(default=0)
    verified = peewee.BooleanField(default=False)
    last_email_reset = peewee.TimestampField()
    last_password_reset = peewee.TimestampField()

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

    class Meta:
        db_table = 'users'
        indexes = (
            (('email',), True),
            (('username',), False),
            (('username', 'discriminator'), True),
        )


class MimetypeType(BaseModel):
    id = peewee.CharField(max_length=11, primary_key=True)

    class Meta:
        db_table = 'mimetype_types'


class Mimetype(BaseModel):
    id = peewee.CharField(max_length=100, primary_key=True)
    flags = peewee.IntegerField(default=0)
    type = peewee.ForeignKeyField(MimetypeType, field='id', backref='mimetypes', null=True)

    def to_dict(self):
        return {
            'mimetype': self.id,
            'type': self.type_id,
            'flags': self.flags,
            'extensions': [x.to_dict() for x in self.extensions],
        }

    class Meta:
        db_table = 'mimetypes'


class MimetypeExtension(BaseModel):
    mimetype = peewee.ForeignKeyField(Mimetype, field='id', backref='extensions')
    extension = peewee.CharField(max_length=12)
    priority = peewee.IntegerField(default=0)

    def to_dict(self):
        return {
            'extension': self.extension,
            'priority': self.priority,
        }

    class Meta:
        db_table = 'mimetype_extensions'
        primary_key = peewee.CompositeKey('mimetype', 'extension')


class FileHash(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)
    blake2b = peewee.CharField(max_length=128)
    sha1 = peewee.CharField(max_length=40)
    md5 = peewee.CharField(max_length=32)
    size = peewee.BigIntegerField()
    height = peewee.IntegerField(null=True)
    width = peewee.IntegerField(null=True)
    duration = peewee.IntegerField(null=True)

    class Meta:
        db_table = 'file_hashes'
        indexes = (
            (('blake2b', 'sha1', 'md5'), True),
        )


class File(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)
    vanity = peewee.CharField(max_length=128, index=True, unique=True)
    mimetype = peewee.ForeignKeyField(Mimetype, field='id', backref='files')
    extension = peewee.CharField(max_length=12, null=True)
    filename = peewee.CharField(max_length=128)
    hash = peewee.ForeignKeyField(FileHash, backref='files')
    user = peewee.ForeignKeyField(User, null=True, backref='files')
    fingerprint = peewee.BigIntegerField(null=True, index=True)
    view_count = peewee.BigIntegerField(default=0)

    def to_dict(self):
        return {
            'id': str(self.id),
            'vanity': self.vanity,
            'mimetype': self.mimetype_id,
            'extension': self.extension or 'unknown',
            'filename': self.filename,
            'hash': str(self.hash_id),
            'size': self.hash.size,
            'height': self.hash.height,
            'width': self.hash.width,
            'duration': self.hash.duration,
            'user': self.user and self.user.to_dict(),
            'urls': {
                'main': 'https://files.gg/' + self.vanity + '.' + self.extension,
                'cdn': 'https://cdn.files.gg/files/' + self.vanity + '.' + self.extension,
            },
            'views': self.view_count,
        }

    class Meta:
        db_table = 'files'


class FileView(BaseModel):
    file = peewee.ForeignKeyField(File, field='id', backref='views')
    ip = IPNetworkField(index=True)
    timestamp = peewee.TimestampField()

    class Meta:
        db_table = 'file_views'
        indexes = (
            (('file', 'ip'), False),
        )


class FileAuditLog(BaseModel):
    file = peewee.ForeignKeyField(File, field='id', backref='logs')

    class Meta:
        db_table = 'file_auditlogs'


db.create_tables([
    User,
    FileHash,
    File,
    FileView,
    MimetypeType,
    Mimetype,
    MimetypeExtension,
])
