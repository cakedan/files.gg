import time

from collections import namedtuple

bits_datacenter = 5
bits_worker = 5
bits_sequence = 12

shift_timestamp = bits_datacenter + bits_worker + bits_sequence
shift_datacenter = bits_worker + bits_sequence
shift_worker = bits_sequence

max_sequence = -1 ^ (-1 << bits_sequence)


class Snowflake:
    epoch = 0
    worker_id = 0
    datacenter_id = 0
    sequence = 0

    @classmethod
    def set_epoch(cls, epoch):
        cls.epoch = epoch

    @classmethod
    def set_worker_id(cls, worker_id):
        cls.worker_id = worker_id

    @classmethod
    def set_datacenter_id(cls, datacenter_id):
        cls.datacenter_id = datacenter_id

    @classmethod
    def get_timestamp(cls):
        return int(time.time() * 1000) - cls.epoch

    @classmethod
    def get_next_sequence(cls):
        if cls.sequence < max_sequence:
            cls.sequence = cls.sequence + 1
        else:
            cls.sequence = 0
        return cls.sequence

    @classmethod
    def generate(cls):
        timestamp = cls.get_timestamp()
        datacenter_id = cls.datacenter_id
        worker_id = cls.worker_id
        sequence = cls.get_next_sequence()
        return int(
            (timestamp << shift_timestamp) |
            (datacenter_id << shift_datacenter) |
            (worker_id << shift_worker) |
            sequence
        )


import base64
import itsdangerous


SignedToken = namedtuple('SignedToken', [
    'uid',
    'timestamp',
    'secret',
    'salt',
    'token',
])

UnsignedToken = namedtuple('UnsignedToken', [
    'uid',
    'timestamp',
    'safe',
])


class Token:
    epoch = 0
    secret = None
    salt = None

    @classmethod
    def set_epoch(cls, epoch):
        cls.epoch = int(epoch / 1000)

    @classmethod
    def set_secret(cls, secret, **kwargs):
        cls.secret = cls.decode(secret, **kwargs)

    @classmethod
    def set_salt(cls, salt, **kwargs):
        cls.salt = cls.decode(salt, **kwargs)

    @classmethod
    def get_timestamp(cls):
        return int(time.time() - cls.epoch)

    @classmethod
    def get_secret(cls, secret=None, secret_is_b64=False, **kwargs):
        if secret is None:
            secret = cls.secret or b''
        else:
            secret = cls.decode(secret, is_base64=secret_is_b64)
        return secret

    @classmethod
    def get_salt(cls, salt=None, salt_is_b64=False, **kwargs):
        if salt is not None:
            salt = cls.decode(salt, is_base64=salt_is_b64)
        elif cls.salt is not None:
            salt = cls.salt
        return salt

    @staticmethod
    def decode(data, string_output=False, is_base64=False):
        if isinstance(data, str):
            data = data.encode()
        if is_base64:
            data = base64.urlsafe_b64decode(data)
        return data.decode() if string_output else data

    @staticmethod
    def encode(data, string_output=False):
        if isinstance(data, str):
            data = data.encode()
        data = base64.urlsafe_b64encode(data)
        return data.decode() if string_output else data

    @staticmethod
    def datetime_to_unix(date):
        return int(date.timestamp())

    @classmethod
    def generate(cls, uid, **kwargs):
        secret = cls.get_secret(**kwargs)
        salt = cls.get_salt(**kwargs)

        signer = itsdangerous.URLSafeSerializer(secret, salt=salt)
        token = signer.dumps(uid)

        return SignedToken(
            uid=uid,
            timestamp=None,
            secret=cls.encode(secret, True),
            salt=cls.encode(salt, True),
            token=token,
        )

    @classmethod
    def generate_time(cls, uid, **kwargs):
        secret = cls.get_secret(**kwargs)
        salt = cls.get_salt(**kwargs)

        signer = itsdangerous.TimestampSigner(secret, salt=salt)
        signer.get_timestamp = cls.get_timestamp

        token = signer.sign(cls.encode(str(uid), True))
        payload, timestamp = signer.unsign(token, return_timestamp=True)

        return SignedToken(
            uid=uid,
            timestamp=cls.datetime_to_unix(timestamp),
            secret=cls.encode(secret, True),
            salt=cls.encode(salt, True),
            token=token.decode(),
        )

    @classmethod
    def deconstruct(cls, token, uid_is_int=True, **kwargs):
        secret = cls.get_secret(**kwargs)
        salt = cls.get_salt(**kwargs)

        signer = itsdangerous.URLSafeSerializer(secret, salt=salt)

        if isinstance(token, str):
            token = token.encode()

        try:
            payload = cls.decode(signer.loads(token), is_base64=True)
            safe = True
        except:
            payload = ''
            safe = False

        uid = payload
        if uid_is_int:
            uid = int(uid)
        return UnsignedToken(
            uid=uid,
            timestamp=None,
            safe=safe,
        )

    @classmethod
    def deconstruct_time(cls, token, uid_is_int=True, **kwargs):
        secret = cls.get_secret(**kwargs)
        salt = cls.get_salt(**kwargs)

        signer = itsdangerous.TimestampSigner(secret, salt=salt)
        signer.get_timestamp = cls.get_timestamp

        try:
            payload, timestamp = signer.unsign(token.encode(), return_timestamp=True)
            safe = True
        except itsdangerous.BadTimeSignature as error:
            if not error.date_signed:
                raise error
            payload = error.payload
            timestamp = signer.timestamp_to_datetime(error.date_signed)
            safe = False

        uid = cls.decode(payload, is_base64=True)
        if uid_is_int:
            uid = int(uid)
        return UnsignedToken(
            uid=uid,
            timestamp=cls.datetime_to_unix(timestamp),
            safe=safe,
        )
