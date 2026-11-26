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


def file_type_not_allowed():
    """Executables and malware-style files (utils/filetypes.py), by name, type or content."""
    return coded('FILE_TYPE_NOT_ALLOWED', 400, "This type of file can't be uploaded")


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


def rate_limited(retry_after):
    """The global and route limits (milestone-5 §18.1, §18.2); app.py adds `Retry-After`."""
    return coded('RATE_LIMITED', 429, "You're doing that too fast", retry_after=retry_after)


def rate_limit_unavailable():
    """A fail-closed limit with Redis down (milestone-5 §18.1)."""
    return coded('RATE_LIMIT_UNAVAILABLE', 503, 'Try again in a moment')


def wrong_password():
    return coded('WRONG_PASSWORD', 401, 'Wrong password')


def password_expired():
    return coded('PASSWORD_EXPIRED', 410, "This link's password has expired")


def unlock_expired():
    return coded('UNLOCK_EXPIRED', 401, 'Access expired. Unlock it again')


def unlock_required():
    """milestone-6 §19.8: opening a view-limited password file needs its unlock first."""
    return coded('UNLOCK_REQUIRED', 401, 'Unlock this file first')


def view_limit_too_low(views_used):
    """milestone-6 §19.8: a new view limit must be greater than the views already used."""
    message = 'The view limit must be more than the {} {} already used'.format(
        views_used, 'view' if views_used == 1 else 'views')
    return coded('VIEW_LIMIT_TOO_LOW', 400, message, views_used=views_used, errors={'view_limit': message})


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


def too_many_uploads(limit):
    """POST /uploads when the caller already has `limit` open chunked uploads."""
    return coded('TOO_MANY_UPLOADS', 429, 'Too many uploads in progress. Finish or cancel one first', limit=limit)


def reserved_vanity():
    return coded('RESERVED_VANITY', 400, 'That vanity is reserved')


def vanity_exhausted():
    """Every random vanity tried was taken (a vanity pattern with too few combinations left)."""
    return coded('VANITY_EXHAUSTED', 409, 'No free vanity was found for that pattern. Use a longer one')


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


# --- trust & safety (contract milestone-4 §12) ------------------------------------------------------

def nsfw_requires_account():
    return coded('NSFW_REQUIRES_ACCOUNT', 403, 'Sign in to upload sensitive media')


def adult_content_unavailable():
    """Milestone-7 §11.3: adult content can't be uploaded or marked from this country (ADULT_BLOCKED_COUNTRIES)."""
    return coded('ADULT_CONTENT_UNAVAILABLE', 451, "Adult content isn't available in your region")


def encrypted_archive_requires_account():
    return coded('ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT', 403, 'Sign in to upload encrypted archives')


def encrypted_pdf_requires_account():
    return coded('ENCRYPTED_PDF_REQUIRES_ACCOUNT', 403, 'Sign in to upload password-protected PDFs')


def file_blocked():
    return coded('FILE_BLOCKED', 403, "This file can't be uploaded")


def malware_detected():
    return coded('MALWARE_DETECTED', 400, "This file looks like malware, so it wasn't uploaded")


def upload_rejection(code):
    """The error a known-content refusal gives (§2.5), by code."""
    return {
        'FILE_BLOCKED': file_blocked,
        'MALWARE_DETECTED': malware_detected,
        'FILE_TYPE_NOT_ALLOWED': file_type_not_allowed,
        'NSFW_REQUIRES_ACCOUNT': nsfw_requires_account,
        'ADULT_CONTENT_UNAVAILABLE': adult_content_unavailable,
        'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT': encrypted_archive_requires_account,
        'ENCRYPTED_PDF_REQUIRES_ACCOUNT': encrypted_pdf_requires_account,
    }[code]()


def upload_rejected(reason):
    return coded('UPLOAD_REJECTED', 410, "This upload wasn't accepted", reason=reason)


def file_pending(retry_after=5):
    return coded('FILE_PENDING', 409, "This file is still being checked", retry_after=retry_after)


def file_removed(reason):
    return coded('FILE_REMOVED', 410, 'This file is unavailable', reason=reason)


def album_removed(reason):
    return coded('ALBUM_REMOVED', 410, 'This album is unavailable', reason=reason)


def nsfw_locked():
    return coded('NSFW_LOCKED', 409, "This file's sensitive mark can't be removed")


def cannot_report_yourself():
    return coded('CANNOT_REPORT_YOURSELF', 400, "You can't report your own content")


def invalid_report_target(message='That link or target can\'t be reported'):
    return coded('INVALID_REPORT_TARGET', 400, message)


def details_required():
    message = 'Add some details'
    return coded('DETAILS_REQUIRED', 400, message, errors={'details': message})


def dmca_fields_required(errors_by_field):
    return coded('DMCA_FIELDS_REQUIRED', 400, 'Some required fields are missing', errors=errors_by_field)


def max_reports(retry_after):
    return coded('MAX_REPORTS', 429, 'Too many reports. Try again later', retry_after=retry_after)


def max_messages(retry_after):
    return coded('MAX_MESSAGES', 429, 'Too many messages. Try again later', retry_after=retry_after)


def unknown_report():
    return coded('UNKNOWN_REPORT', 404, 'Unknown report')


def report_closed():
    return coded('REPORT_CLOSED', 409, 'This report is closed')


def reopen_not_allowed():
    return coded('REOPEN_NOT_ALLOWED', 409, "This report can't be reopened")


def unknown_warning():
    return coded('UNKNOWN_WARNING', 404, 'Unknown notice')


def appeal_not_allowed():
    return coded('APPEAL_NOT_ALLOWED', 409, "This can't be appealed")


def account_suspended(until=None):
    return coded('ACCOUNT_SUSPENDED', 403, 'Your account has been suspended', until=until)


def uploads_restricted(until=None):
    return coded('UPLOADS_RESTRICTED', 403, 'Uploads are restricted on your account', until=until)


def banned():
    return coded('BANNED', 403, "Uploads from this device or network aren't allowed")


def unknown_case():
    return coded('UNKNOWN_CASE', 404, 'Unknown case')


def case_claimed(assignee_id):
    return coded('CASE_CLAIMED', 409, 'Someone else has claimed this case',
                 assignee_id=str(assignee_id) if assignee_id is not None else None)


def same_moderator():
    return coded('SAME_MODERATOR', 409, 'Another staff member has to decide this appeal')


def invalid_action(message="That action doesn't apply here"):
    return coded('INVALID_ACTION', 400, message)


def not_found():
    """Exactly what an unknown route answers (every /admin/* endpoint for non-staff, §9.1)."""
    from utils.responses import ApiError
    return ApiError(status=404)


# --- accounts (contract milestone-6 §14) -------------------------------------------------------------------------

def csrf():
    return coded('CSRF', 403, "This request didn't come from files.gg")


def request_too_large(limit):
    return coded('REQUEST_TOO_LARGE', 413, 'Request too large', limit=limit)


def username_invalid(reason, message):
    return coded('USERNAME_INVALID', 400, message, reason=reason, errors={'username': message})


def username_cooldown(available_at):
    return coded('USERNAME_COOLDOWN', 409, 'You can change your username again later', available_at=available_at)


def display_name_invalid(reason):
    message = 'Use 1 to 32 characters' if reason == 'length' else "That display name isn't allowed"
    return coded('DISPLAY_NAME_INVALID', 400, message, reason=reason, errors={'display_name': message})


PASSWORD_MESSAGES = {
    'too_short': 'Use at least 8 characters',
    'matches_username': "Your password can't be your username",
    'matches_email': "Your password can't be your email",
}


def invalid_password(reason, field='password'):
    message = PASSWORD_MESSAGES[reason]
    return coded('INVALID_PASSWORD', 400, message, reason=reason, errors={field: message})


def email_not_verified():
    return coded('EMAIL_NOT_VERIFIED', 403, 'Verify your email first')


def nothing_to_verify():
    return coded('NOTHING_TO_VERIFY', 409, 'Your email is already verified')


def reauth_required(methods):
    return coded('REAUTH_REQUIRED', 403, 'Confirm it\'s you to continue', methods=methods)


def invalid_oauth_state():
    return coded('INVALID_OAUTH_STATE', 400, 'This sign-in link expired. Try again')


def discord_code_invalid():
    return coded('DISCORD_CODE_INVALID', 400, 'Discord sign-in failed. Try again')


def discord_unavailable(retry_after=None):
    if retry_after is not None:
        return coded('DISCORD_UNAVAILABLE', 503, "Discord isn't available right now. Try again later",
                     retry_after=retry_after)
    return coded('DISCORD_UNAVAILABLE', 503, "Discord isn't available right now. Try again later")


def invalid_signup_token():
    return coded('INVALID_SIGNUP_TOKEN', 400, 'This sign-up expired. Sign in with Discord again')


def discord_email_in_use():
    return coded('DISCORD_EMAIL_IN_USE', 409, 'An account already uses this email. Sign in with your password, '
                                              'then link Discord in Settings.')


def identity_in_use():
    return coded('IDENTITY_IN_USE', 409, 'That Discord account is linked to another files.gg account')


def identity_already_linked():
    return coded('IDENTITY_ALREADY_LINKED', 409, 'Another Discord account is already linked')


def identity_mismatch():
    return coded('IDENTITY_MISMATCH', 403, "That isn't the Discord account linked to files.gg")


def unknown_identity():
    return coded('UNKNOWN_IDENTITY', 404, 'No Discord account is linked')


def last_login_method():
    return coded('LAST_LOGIN_METHOD', 409, 'Add a password and verify your email first, so you can still sign in')


def unknown_session():
    return coded('UNKNOWN_SESSION', 404, 'Unknown session')


def upload_key_required():
    return coded('UPLOAD_KEY_REQUIRED', 401, 'Create a free account to upload with ShareX')


def upload_key_invalid():
    return coded('UPLOAD_KEY_INVALID', 401, "That upload key isn't valid")


def upload_key_not_allowed():
    return coded('UPLOAD_KEY_NOT_ALLOWED', 403, 'Upload keys can only upload files')


def upload_key_scope(scope):
    return coded('UPLOAD_KEY_SCOPE', 403, "This upload key can't do that", scope=scope)


def upload_key_limit(limit):
    return coded('UPLOAD_KEY_LIMIT', 400, 'You have reached the upload key limit', limit=limit)


def unknown_upload_key():
    return coded('UNKNOWN_UPLOAD_KEY', 404, 'Unknown upload key')


def too_many_key_uploads(limit, retry_after):
    return coded('TOO_MANY_UPLOADS', 429, 'Too many uploads with this key. Try again later', limit=limit,
                 retry_after=retry_after)


def account_pending_deletion(scheduled_for):
    return coded('ACCOUNT_PENDING_DELETION', 403, 'Your account is scheduled for deletion',
                 scheduled_for=scheduled_for)


def account_delete_not_allowed(reason):
    message = "Staff accounts can't be deleted" if reason == 'staff' else 'Your account is already scheduled for deletion'
    return coded('ACCOUNT_DELETE_NOT_ALLOWED', 409, message, reason=reason)


def export_limit(retry_after):
    return coded('EXPORT_LIMIT', 429, 'You can request one export a day', retry_after=retry_after)


def export_not_ready():
    return coded('EXPORT_NOT_READY', 409, "This export isn't ready yet")


def unknown_export():
    return coded('UNKNOWN_EXPORT', 404, 'Unknown export')


def premium_required():
    return coded('PREMIUM_REQUIRED', 403, 'This needs premium')


def entitlement_exists():
    return coded('ENTITLEMENT_EXISTS', 409, 'This account already has premium. Change its expiry instead')


def unknown_entitlement():
    return coded('UNKNOWN_ENTITLEMENT', 404, 'Unknown entitlement')


def invalid_hostname(reason):
    messages = {
        'syntax': "That isn't a valid hostname",
        'wildcard': "Wildcard domains aren't supported",
        'ip': 'Use a domain name, not an IP address',
        'apex': 'Use a subdomain, such as i.example.com',
        'public_suffix': 'Use a subdomain of a domain you own',
        'reserved': "That domain can't be used",
    }
    return coded('INVALID_HOSTNAME', 400, messages[reason], reason=reason, errors={'hostname': messages[reason]})


def domain_taken():
    return coded('DOMAIN_TAKEN', 409, 'That domain is already connected to files.gg')


def domain_limit_reached(limit):
    return coded('DOMAIN_LIMIT_REACHED', 400, 'You have reached the domain limit', limit=limit)


def domain_requirements(reason, available_at=None):
    if reason == 'email_not_verified':
        return coded('DOMAIN_REQUIREMENTS', 403, 'Verify your email to add domains', reason=reason)
    return coded('DOMAIN_REQUIREMENTS', 403, 'Your account is too new to add domains', reason=reason,
                 available_at=available_at)


def unknown_domain():
    return coded('UNKNOWN_DOMAIN', 404, 'Unknown domain')


def domain_not_active():
    return coded('DOMAIN_NOT_ACTIVE', 409, "This domain isn't active")


def domain_not_failed():
    return coded('DOMAIN_NOT_FAILED', 409, 'Only a failed domain can be retried')


def domain_disabled():
    return coded('DOMAIN_DISABLED', 409, 'This domain was disabled by files.gg staff')


def domain_check_rate_limited(retry_after):
    return coded('DOMAIN_CHECK_RATE_LIMITED', 429, 'You can check a domain once a minute', retry_after=retry_after)


def domain_only_not_available():
    return coded('DOMAIN_ONLY_NOT_AVAILABLE', 409, 'Connect a working domain first')


def domains_unavailable():
    return coded('DOMAINS_UNAVAILABLE', 503, "Custom domains aren't available right now. Try again later")


# --- conversions (contract milestone-5 §12) ----------------------------------------------------------------------

def unsupported_conversion(kind, target):
    return coded('UNSUPPORTED_CONVERSION', 400, "This file can't be converted to that format", kind=kind,
                 target=target)


def invalid_option(option, reason):
    return coded('INVALID_OPTION', 400, "That option isn't valid for this conversion", option=option, reason=reason)


def target_size_too_small(minimum_mb):
    return coded('TARGET_SIZE_TOO_SMALL', 400, 'That size is too small for this video', minimum_mb=minimum_mb)


def conversion_too_large(limit, value, unit, sign_in=False):
    details = {'limit': limit, 'value': value, 'unit': unit}
    if sign_in:
        details['sign_in'] = True
    return coded('CONVERSION_TOO_LARGE', 413, 'This file is too big to convert', **details)


def conversion_limit_reached(limit, retry_after, sign_in=False):
    """`limit`: count, cpu (today's) or concurrent (at once)."""
    message = 'Too many conversions at once' if limit == 'concurrent' else \
        "You've reached your conversion limit for today"
    details = {'limit': limit, 'retry_after': retry_after}
    if sign_in:
        details['sign_in'] = True
    return coded('CONVERSION_LIMIT_REACHED', 429, message, **details)


def conversion_requires_account(batch=False):
    return coded('CONVERSION_REQUIRES_ACCOUNT', 403,
                 'Sign in to convert in bulk' if batch else 'Sign in to convert documents', sign_in=True)


def source_unavailable():
    return coded('SOURCE_UNAVAILABLE', 404, "That file isn't available")


def view_limited_source():
    return coded('VIEW_LIMITED_SOURCE', 403, 'Files with a view limit can only be converted by their owner')


def unknown_conversion():
    return coded('UNKNOWN_CONVERSION', 404, 'Unknown conversion')


# the conversion object's own errors (§12): saved as `conversions.error`, never an HTTP error of POST /conversions

def converter_busy():
    return coded('CONVERTER_BUSY', 503, 'Busy right now. Try again, or sign in to skip the queue', sign_in=True)


def conversion_timeout(**metadata):
    return coded('CONVERSION_TIMEOUT', 500, 'The conversion took too long', **metadata)


CONVERSION_FAILURE_REASONS = ('unreadable_source', 'bad_output', 'empty_output', 'too_many_pages', 'target_size_missed',
                              'internal')


def conversion_failed(reason):
    if reason not in CONVERSION_FAILURE_REASONS:
        reason = 'internal'
    return coded('CONVERSION_FAILED', 500, 'The conversion failed', reason=reason)


def conversion_error(error):
    """An ApiError as `conversions.error`: `{ code, message, metadata }` (§2.1)."""
    metadata = {k: v for k, v in error.data.items() if k not in ('code', 'message', 'status')}
    return {'code': error.code, 'message': error.message, 'metadata': metadata}
