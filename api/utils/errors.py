from utils.responses import ApiError


class InvalidMimetype(ApiError):
    code = 140001
    message = 'Invalid Mimetype'


class UnknownFile(ApiError):
    code = 140401
    message = 'Unknown File'
    status = 404


# --- Milestone 2 endpoints: string codes (contract §7) ----------------------------------

def coded(code, status, message, **details):
    return ApiError(message, status, code=code, metadata=details or None)


def captcha_invalid():
    return coded('CAPTCHA_INVALID', 403, 'Human verification failed')


def too_many_attempts(retry_after):
    return coded('TOO_MANY_ATTEMPTS', 429, 'Too many attempts, try again later', retry_after=retry_after)


def wrong_password():
    return coded('WRONG_PASSWORD', 401, 'Wrong password')


def password_expired():
    return coded('PASSWORD_EXPIRED', 410, "This link's password has expired")


def unlock_expired():
    return coded('UNLOCK_EXPIRED', 401, 'Access expired; unlock again')


def unknown_file():
    return coded('UNKNOWN_FILE', 404, 'Unknown File')


def unknown_album():
    return coded('UNKNOWN_ALBUM', 404, 'Unknown Album')


def unknown_upload():
    return coded('UNKNOWN_UPLOAD', 404, 'Unknown Upload')


def upload_incomplete(missing):
    return coded('UPLOAD_INCOMPLETE', 409, 'Some chunks are missing', missing=missing)


def chunk_size_mismatch(expected):
    return coded('CHUNK_SIZE_MISMATCH', 400, 'Chunk has the wrong size', expected=expected)


def reserved_vanity():
    return coded('RESERVED_VANITY', 400, 'That vanity is reserved')
