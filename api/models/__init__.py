import peewee
import os

from playhouse.db_url import connect


db_url = os.getenv('DATABASE_URL')
if db_url is None:
    raise Exception('Database URL Required')
db = connect(db_url)


class BaseModel(peewee.Model):
    class Meta:
        database = db


class User(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)

    class Meta:
        db_table = 'users'


class Mimetypes(BaseModel):
    id = peewee.CharField(max_length=100, primary_key=True)
    flags = peewee.IntegerField(default=0)

    def to_dict(self):
        return {
            'mimetype': self.id,
            'flags': self.flags,
            'extensions': [x.to_dict() for x in self.extensions],
        }

    class Meta:
        db_table = 'mimetypes'


class MimetypeExtensions(BaseModel):
    mimetype = peewee.ForeignKeyField(Mimetypes, field='id', backref='extensions')
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


class FileHashes(BaseModel):
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


class Files(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)
    vanity = peewee.CharField(max_length=128, index=True, unique=True)
    mimetype = peewee.ForeignKeyField(Mimetypes, field='id', backref='files')
    extension = peewee.CharField(max_length=12, null=True)
    filename = peewee.CharField(max_length=128)
    hash = peewee.ForeignKeyField(FileHashes, backref='files')
    user = peewee.ForeignKeyField(User, null=True, backref='files')

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
            'views': 0,
            'urls': {
                'main': 'https://files.gg/' + self.vanity + '.' + self.extension,
                'cdn': 'https://cdn.files.gg/files/' + self.vanity + '.' + self.extension,
            },
        }

    class Meta:
        db_table = 'files'

db.create_tables([
    User,
    FileHashes,
    Files,
    Mimetypes,
    MimetypeExtensions,
])
