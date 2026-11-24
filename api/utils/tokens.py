import itsdangerous
import time


_secret_key = None


def set_secret_key(secret_key):
    """Set once per process by create_app() (was Flask's app.secret_key)."""
    global _secret_key
    _secret_key = secret_key


def get_secret_key():
    if not _secret_key:
        raise RuntimeError('Token secret key is not set')
    return _secret_key


class Token:
    salt = 'token'
    serializer = itsdangerous.URLSafeSerializer
    serializer_signer_kwargs = {'key_derivation': 'hmac'}

    @classmethod
    def generate_serializer(cls):
        return cls.serializer(
            get_secret_key(),
            salt=cls.salt,
            signer_kwargs=cls.serializer_signer_kwargs,
        )

    @classmethod
    def generate(cls, payload, **kwargs):
        serializer = cls.generate_serializer()
        return serializer.dumps(payload, **kwargs)

    @classmethod
    def deconstruct(cls, token, **kwargs):
        serializer = cls.generate_serializer()
        if isinstance(token, str):
            token = token.encode()
        return serializer.loads(token, **kwargs)


class TimestampToken(Token):
    epoch = 0
    serializer = itsdangerous.URLSafeTimedSerializer

    @classmethod
    def generate_serializer(cls):
        serializer = super().generate_serializer()
        serializer.get_timestamp = cls.get_timestamp
        return serializer

    @classmethod
    def get_timestamp(cls):
        return int(time.time() - cls.epoch)

    @classmethod
    def deconstruct(cls, token, min_timestamp=None, **kwargs):
        if min_timestamp is not None:
            kwargs['max_age'] = cls.get_timestamp() - int(min_timestamp)
        return super().deconstruct(token, **kwargs)

    @classmethod
    def validate(cls, token, min_timestamp=None, **kwargs):
        serializer = cls.generate_serializer()
        if min_timestamp is not None:
            kwargs['max_age'] = cls.get_timestamp() - int(min_timestamp)
        signer = serializer.make_signer()
        return signer.validate(token, **kwargs)



class FingerprintToken(Token):
    salt = 'fingerprint'


class EmailForgotToken(TimestampToken):
    salt = 'email-forgot'


class EmailVerifyToken(TimestampToken):
    salt = 'email-verify'


class UserToken(TimestampToken):
    salt = 'user'
