"""Cloudflare Turnstile (contract §8), replacing reCAPTCHA.

Every token is checked with siteverify: `success`, the expected `action`
(upload, unlock, login, register, forgot) and the `hostname` it was issued for.
Cloudflare's documented testing secrets (developers.cloudflare.com/turnstile/
troubleshooting/testing/) answer with hostname "example.com" and no action, so
for those two checks are skipped; production secrets are always checked fully.
"""

import logging

from utils.http import get_client

log = logging.getLogger(__name__)

SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

# Cloudflare's testing secret keys: always passes / always fails / "token already spent"
TEST_SECRET_PASS = '1x0000000000000000000000000000000AA'
TEST_SECRET_FAIL = '2x0000000000000000000000000000000AA'
TEST_SECRET_SPENT = '3x0000000000000000000000000000000AA'
TEST_SECRETS = frozenset((TEST_SECRET_PASS, TEST_SECRET_FAIL, TEST_SECRET_SPENT))
# The token Cloudflare's testing site keys produce (the testing secrets accept only it)
TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

MAX_TOKEN_LENGTH = 2048


class Turnstile:
    secret = None
    hostnames = frozenset(('files.gg',))
    # an httpx.AsyncClient to use instead of the shared one (tests mock siteverify)
    http = None

    @classmethod
    def configure(cls, secret, hostnames=None):
        cls.secret = secret or None
        if hostnames:
            cls.hostnames = frozenset(hostnames)

    @classmethod
    async def verify(cls, token, action, remoteip=None):
        """True only for a valid token for this action. Fails closed."""
        if not cls.secret or not isinstance(token, str) or not token or len(token) > MAX_TOKEN_LENGTH:
            return False
        data = {'secret': cls.secret, 'response': token}
        if remoteip:
            data['remoteip'] = remoteip
        try:
            response = await (cls.http or get_client()).post(SITEVERIFY_URL, data=data)
            result = response.json() if response.status_code == 200 else {}
        except Exception:
            log.exception('turnstile siteverify failed')
            return False
        if result.get('success') is not True:
            return False
        if cls.secret in TEST_SECRETS:
            return True
        return result.get('action') == action and result.get('hostname') in cls.hostnames
