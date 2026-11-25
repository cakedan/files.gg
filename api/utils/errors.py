"""Every API error: `{code: "UPPER_SNAKE", message, status, ...details}` (contract
milestone-3 §0). Messages are sentence case."""

from utils.responses import ApiError


def coded(code, status, message, **details):
    return ApiError(message, status, code=code, metadata=details or None)


def field_error(code, field, message, status=400):
    """A form error: the code, plus `errors: {field: message}` for the form to show."""
    return coded(code, status, message, errors={field: message})


# --- requests and accounts ---------------------------------------------------------------

def invalid_parameters(errors):
    return coded('INVALID_PARAMETERS', 400, 'Some fields are invalid', errors=errors)


def unauthorized(message='Sign in to do that'):
    return coded('UNAUTHORIZED', 401, message)


def unknown_user():
    return coded('UNKNOWN_USER', 404, 'Unknown user')


def invalid_credentials():
    return coded('INVALID_CREDENTIALS', 400, 'Wrong email or password')


def username_taken():
    return field_error('USERNAME_TAKEN', 'username', 'That username is taken')


def email_taken():
    return field_error('EMAIL_TAKEN', 'email', 'That email is already in use')


def invalid_email():
    return field_error('INVALID_EMAIL', 'email', "That email address can't receive mail")


def unknown_email():
    return field_error('UNKNOWN_EMAIL', 'email', 'No account uses that email')


def invalid_token(message='Invalid or expired link'):
    return field_error('INVALID_TOKEN', 'token', message)


def same_password():
    return field_error('SAME_PASSWORD', 'password', "That's your current password")


def password_required():
    return field_error('PASSWORD_REQUIRED', 'password', 'A password is required for password visibility')


def forbidden(message="You can't do that"):
    return coded('FORBIDDEN', 403, message)


# --- files and uploads ---------------------------------------------------------------------

def invalid_mimetype():
    return coded('INVALID_MIMETYPE', 400, 'Invalid mimetype')


def unknown_type():
    return coded('UNKNOWN_TYPE', 404, 'Unknown type')


def unknown_mimetype():
    return coded('UNKNOWN_MIMETYPE', 404, 'Unknown mimetype')


def invalid_vanity(minimum, maximum):
    return coded('INVALID_VANITY', 400, 'Vanity must be {} to {} characters long'.format(minimum, maximum),
                 min=minimum, max=maximum)


def file_required():
    return coded('FILE_REQUIRED', 400, 'A file must be uploaded')


def invalid_upload_type():
    return coded('INVALID_UPLOAD_TYPE', 400, 'Invalid upload type')


def captcha_invalid():
    return coded('CAPTCHA_INVALID', 403, 'Human verification failed')


def too_many_attempts(retry_after):
    return coded('TOO_MANY_ATTEMPTS', 429, 'Too many attempts. Try again later', retry_after=retry_after)


def wrong_password():
    return coded('WRONG_PASSWORD', 401, 'Wrong password')


def password_expired():
    return coded('PASSWORD_EXPIRED', 410, "This link's password has expired")


def unlock_expired():
    return coded('UNLOCK_EXPIRED', 401, 'Access expired. Unlock it again')


def unknown_file():
    return coded('UNKNOWN_FILE', 404, 'Unknown file')


def unknown_album():
    return coded('UNKNOWN_ALBUM', 404, 'Unknown album')


def unknown_upload():
    return coded('UNKNOWN_UPLOAD', 404, 'Unknown upload')


def upload_incomplete(missing):
    return coded('UPLOAD_INCOMPLETE', 409, 'Some chunks are missing', missing=missing)


def chunk_size_mismatch(expected):
    return coded('CHUNK_SIZE_MISMATCH', 400, 'Chunk has the wrong size', expected=expected)


def reserved_vanity():
    return coded('RESERVED_VANITY', 400, 'That vanity is reserved')


# --- albums (contract milestone-3 §6) ----------------------------------------------------------

def invalid_album():
    return coded('INVALID_ALBUM', 400, 'Unknown album, or not one of yours')


def invalid_album_files(file_ids):
    return coded('INVALID_ALBUM_FILES', 400, 'Only your own files can be in your albums',
                 file_ids=[str(x) for x in file_ids])


def album_full(limit):
    return coded('ALBUM_FULL', 400, 'This album is full', limit=limit)


def album_limit_reached(limit):
    return coded('ALBUM_LIMIT_REACHED', 400, 'You have reached the album limit', limit=limit)


def anonymous_album_not_allowed():
    return coded('ANONYMOUS_ALBUM_NOT_ALLOWED', 403, 'Sign in to make or edit albums')
