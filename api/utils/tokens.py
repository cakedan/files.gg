import itsdangerous


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


class GuestToken(Token):
    """An anonymous uploader's guest id (`Authorization: Guest`, milestone-5 §20). The only itsdangerous token
    left: user sessions are opaque `fgs_` tokens in a cookie and email links are random tokens (milestone-6 §0)."""
    salt = 'guest'
