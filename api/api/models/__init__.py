import peewee

from playhouse.db_url import connect


db = connect('postgres+pool://user:password9@/db?host=127.0.0.1')


class BaseModel(peewee.Model):
    class Meta:
        database = db


class User(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)

    class Meta:
        db_table = 'users'


class FileHashes(BaseModel):
    id = peewee.BigIntegerField(primary_key=True)
    blake2b = peewee.CharField(max_length=128)
    sha1 = peewee.CharField(max_length=40)
    md5 = peewee.CharField(max_length=32)
    mimetype = peewee.CharField(max_length=100)
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
    id = peewee.CharField(max_length=16)
    folder = peewee.CharField(max_length=16, null=True)
    extension = peewee.CharField(max_length=12)
    filename = peewee.CharField(max_length=100)
    timestamp = peewee.IntegerField()
    hash = peewee.ForeignKeyField(FileHashes, backref='files')
    user = peewee.ForeignKeyField(User, null=True, backref='files')

    def to_dict(self):
        path = self.id if self.folder is None else self.folder + '/' + self.id
        return {
            'id': self.id,
            'folder': self.folder,
            'extension': self.extension,
            'filename': self.filename,
            'uploaded_at': self.timestamp,
            'hash': str(self.hash_id),
            'mimetype': self.hash.mimetype,
            'size': self.hash.size,
            'height': self.hash.height,
            'width': self.hash.width,
            'duration': self.hash.duration,
            'user': self.user and self.user.to_dict(),
            'urls': {
                'main': 'https://files.gg/' + path + '.' + self.extension,
                'cdn': 'https://cdn.files.gg/files/' + path + '.' + self.extension,
            },
        }

    class Meta:
        db_table = 'files'
        indexes = (
            (('id', 'folder'), True),
        )
        primary_key = False


class Mimetypes(BaseModel):
    id = peewee.CharField(max_length=100, primary_key=True)
    required_flags = peewee.IntegerField(default=0)

    def to_dict(self):
        return {
            'mime': self.id,
            'required_flags': self.required_flags,
        }

    class Meta:
        db_table = 'mimetypes'


class MimetypeExtensions(BaseModel):
    mime = peewee.ForeignKeyField(Mimetypes, backref='extensions')
    extension = peewee.CharField(max_length=12)

    def to_dict(self):
        return {
            'mime': self.mime.id,
            'extension': self.extension,
            'required_flags': self.mime.required_flags,
        }

    class Meta:
        db_table = 'mimetype_extensions'
        primary_key = peewee.CompositeKey('mime', 'extension')


db.create_tables([
    User,
    FileHashes,
    Files,
    Mimetypes,
    MimetypeExtensions,
])
