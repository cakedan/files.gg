"""The effective file state, public reasons and the NSFW flag (contract milestone-4 §2.4, §4.4,
§6.2): pure functions, shared by every payload and lookup. SQL twins are at the bottom."""

# §8.1 rules and the text notices show
RULES = {
    'csam': None,
    'ncii': 'Intimate images shared without consent',
    'violence': 'Violence, terrorism or credible threats',
    'malware': 'Malware or harmful software',
    'phishing': 'Phishing or scams',
    'adult_unmarked': "Adult content that wasn't marked as sensitive",
    'copyright': 'Copyright infringement',
    'harassment': 'Harassment',
    'private_info': "Sharing someone's private information",
    'spam': 'Spam',
    'other': 'Breaking the Terms of Service',
}
PUBLIC_REASONS = ('review', 'terms', 'copyright', 'malware')
CSAM_REASONS = frozenset(('csam_match',))
UPLOAD_REJECTIONS = ('FILE_BLOCKED', 'MALWARE_DETECTED', 'FILE_TYPE_NOT_ALLOWED', 'NSFW_REQUIRES_ACCOUNT',
                     'ENCRYPTED_ARCHIVE_REQUIRES_ACCOUNT', 'ENCRYPTED_PDF_REQUIRES_ACCOUNT')


def owner_state(scan_state, moderation_state):
    """§2.4's table, first match wins: blocked, removed, hidden, hidden (held), pending, flagged, ok."""
    if scan_state == 'blocked':
        return 'blocked'
    if moderation_state == 'removed':
        return 'removed'
    if moderation_state == 'hidden' or scan_state == 'held':
        return 'hidden'
    if scan_state == 'pending':
        return 'pending'
    if scan_state == 'flagged':
        return 'flagged'
    return 'ok'


def lookup_state(scan_state, moderation_state):
    """The Worker's reduced form: flagged counts as ok."""
    state = owner_state(scan_state, moderation_state)
    return 'ok' if state == 'flagged' else state


def shown(scan_state, moderation_state):
    return lookup_state(scan_state, moderation_state) == 'ok'


def public_reason(state, rule):
    """The reason visitors see on a removed page: `review` (hidden or held), `copyright`,
    `malware` (rules malware and phishing), otherwise `terms`."""
    if state == 'hidden':
        return 'review'
    if state != 'removed':
        return None
    if rule == 'copyright':
        return 'copyright'
    if rule in ('malware', 'phishing'):
        return 'malware'
    return 'terms'


def owner_reason(state, scan_reason, moderation_rule, moderation_auto=False, scan_state=None):
    """§6.2: the rule for hidden and removed (`review` for held or automatic hides), the scan
    reason for flagged and blocked. Anything CSAM-related is only ever `review` or `FILE_BLOCKED`."""
    if state == 'blocked':
        return 'FILE_BLOCKED' if scan_reason in CSAM_REASONS or scan_reason == 'hash_list' else scan_reason
    if state == 'hidden':
        if scan_state == 'held' and moderation_rule is None or moderation_auto or moderation_rule == 'csam':
            return 'review'
        return moderation_rule or 'review'
    if state == 'removed':
        return 'review' if moderation_rule == 'csam' else moderation_rule
    if state == 'flagged':
        return scan_reason
    return None


def file_nsfw(nsfw_override, nsfw_override_source, nsfw_marked, nsfw_auto):
    """(nsfw, nsfw_source) per §4.4."""
    if nsfw_override is not None:
        return nsfw_override == 'nsfw', nsfw_override_source
    if nsfw_marked:
        return True, 'uploader'
    if nsfw_auto:
        return True, 'auto'
    return False, None


def nsfw_locked(nsfw_override, nsfw_auto):
    """The uploader can't unmark (§4.5, §14.4): set by staff or reports, or by the classifier."""
    return nsfw_override is not None or bool(nsfw_auto)


# --- SQL (aliases: f = files, h = file_hashes) ----------------------------------------------------------

# the file is `ok` or `flagged`: shown in albums, ZIPs and public payloads
SHOWN_SQL = "(h.scan_state IN ('passed', 'flagged') AND f.moderation_state = 'visible')"
SHOWN_SQL_SUB = ("(f.moderation_state = 'visible' AND EXISTS (SELECT 1 FROM file_hashes hs WHERE hs.id = f.hash_id "
                 "AND hs.scan_state IN ('passed', 'flagged')))")
# not yet shown only because the scan hasn't finished
PENDING_SQL_SUB = ("(f.moderation_state = 'visible' AND EXISTS (SELECT 1 FROM file_hashes hs WHERE hs.id = f.hash_id "
                   "AND hs.scan_state = 'pending'))")
NSFW_SQL = ("(f.nsfw_override = 'nsfw' OR (f.nsfw_override IS NULL AND (f.nsfw_marked OR EXISTS "
            "(SELECT 1 FROM file_hashes hn WHERE hn.id = f.hash_id AND hn.nsfw_auto))))")
