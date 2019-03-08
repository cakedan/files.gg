import time

from collections import namedtuple

bits_datacenter = 5
bits_worker = 5
bits_sequence = 12

shift_timestamp = bits_datacenter + bits_worker + bits_sequence
shift_datacenter = bits_worker + bits_sequence
shift_worker = bits_sequence

max_datacenter = -1 ^ (-1 << bits_datacenter)
max_worker = -1 ^ (-1 << bits_worker)
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
        cls.worker_id = worker_id & max_worker

    @classmethod
    def set_datacenter_id(cls, datacenter_id):
        cls.datacenter_id = datacenter_id & max_datacenter

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


class Token:
    secret = None
    salt = None
    signer_base = itsdangerous.URLSafeSerializer
    signer = None

    @classmethod
    def generate_signer(cls):
        cls.signer = cls.signer_base(cls.secret, salt=cls.salt)

    @classmethod
    def set_secret(cls, secret, **kwargs):
        cls.secret = cls.decode(secret, **kwargs)
        cls.generate_signer()

    @classmethod
    def set_salt(cls, salt, **kwargs):
        cls.salt = cls.decode(salt, **kwargs)
        cls.generate_signer()

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

    @classmethod
    def get_signer(cls):
        if cls.signer is None:
            raise Exception('Signer has not been generated yet')
        return cls.signer

    @staticmethod
    def encode(data, string_output=False):
        if isinstance(data, str):
            data = data.encode()
        data = base64.urlsafe_b64encode(data)
        return data.decode() if string_output else data

    @staticmethod
    def decode(data, string_output=False, is_base64=False):
        if isinstance(data, str):
            data = data.encode()
        if is_base64:
            data = base64.urlsafe_b64decode(data)
        return data.decode() if string_output else data

    @classmethod
    def generate(cls, payload, **kwargs):
        signer = cls.get_signer()
        return signer.dumps(payload, **kwargs)

    @classmethod
    def deconstruct(cls, token, **kwargs):
        signer = cls.get_signer()

        if isinstance(token, str):
            token = token.encode()

        return signer.loads(token, **kwargs)


class TimestampToken(Token):
    epoch = 0
    signer_base = itsdangerous.URLSafeTimedSerializer

    @classmethod
    def generate_signer(cls):
        cls.signer = cls.signer_base(cls.secret, salt=cls.salt)
        cls.signer.get_timestamp = cls.get_timestamp

    @classmethod
    def set_epoch(cls, epoch):
        cls.epoch = int(epoch / 1000)

    @classmethod
    def get_timestamp(cls):
        return int(time.time() - cls.epoch)

    @staticmethod
    def datetime_to_unix(date):
        return int(date.timestamp())

    @classmethod
    def deconstruct(cls, token, min_timestamp=None, **kwargs):
        if min_timestamp is not None:
            kwargs['max_age'] = cls.get_timestamp() - int(min_timestamp)
        return super().deconstruct(token, **kwargs)

    @classmethod
    def validate(cls, token, min_timestamp=None, **kwargs):
        signer = cls.get_signer()

        if min_timestamp is not None:
            kwargs['max_age'] = cls.get_timestamp() - int(min_timestamp)

        signer = signer.make_signer()
        return signer.validate(token, **kwargs)
