"""Discord OAuth2 (contract milestone-6 §5): the code exchange (a confidential client with PKCE), the current
user, and revoking the access token right after it was read. No Discord token is ever stored.

Every call goes to `DISCORD_API_BASE` (default https://discord.com/api). Tests set `TRANSPORT` to an
`httpx.MockTransport`, so the suite never reaches Discord.
"""

import logging

from urllib.parse import urlencode

import httpx

from utils import errors
from utils.account_settings import account_settings

log = logging.getLogger(__name__)

AUTHORIZE_URL = 'https://discord.com/oauth2/authorize'
SCOPES = 'identify email'
API_VERSION = 'v10'
TIMEOUT = 10.0
REVOKE_TIMEOUT = 3.0
# tests: an httpx transport that stands in for Discord
TRANSPORT = None


def authorize_url(state, challenge, purpose, settings=None):
    settings = settings or account_settings()
    params = [('response_type', 'code'), ('client_id', settings.discord_client_id), ('scope', SCOPES),
              ('redirect_uri', settings.discord_redirect_uri), ('state', state), ('code_challenge', challenge),
              ('code_challenge_method', 'S256'), ('prompt', 'consent' if purpose == 'link' else 'none')]
    return AUTHORIZE_URL + '?' + urlencode(params)


def _client(timeout):
    return httpx.AsyncClient(timeout=timeout, transport=TRANSPORT)


def _auth(settings):
    return httpx.BasicAuth(settings.discord_client_id, settings.discord_client_secret)


def _raise_for(response):
    """A 400 is the code's fault (DISCORD_CODE_INVALID); everything else Discord's (DISCORD_UNAVAILABLE)."""
    if response.status_code == 400:
        raise errors.discord_code_invalid()
    retry_after = None
    if response.status_code == 429:
        try:
            retry_after = max(1, int(float(response.headers.get('retry-after') or response.json().get('retry_after'))))
        except Exception:
            retry_after = None
    log.warning('discord answered %s', response.status_code)
    raise errors.discord_unavailable(retry_after)


async def exchange(code, verifier, settings=None):
    """The access token for an authorization code."""
    settings = settings or account_settings()
    try:
        async with _client(TIMEOUT) as client:
            response = await client.post(settings.discord_api_base + '/oauth2/token', auth=_auth(settings), data={
                'grant_type': 'authorization_code', 'code': code, 'redirect_uri': settings.discord_redirect_uri,
                'code_verifier': verifier,
            })
    except httpx.HTTPError:
        log.warning('discord token exchange failed')
        raise errors.discord_unavailable()
    if response.status_code != 200:
        _raise_for(response)
    try:
        token = response.json()['access_token']
    except Exception:
        raise errors.discord_unavailable()
    if not isinstance(token, str) or not token:
        raise errors.discord_unavailable()
    return token


async def current_user(token, settings=None):
    settings = settings or account_settings()
    try:
        async with _client(TIMEOUT) as client:
            response = await client.get('{}/{}/users/@me'.format(settings.discord_api_base, API_VERSION),
                                        headers={'Authorization': 'Bearer ' + token})
    except httpx.HTTPError:
        raise errors.discord_unavailable()
    if response.status_code != 200:
        _raise_for(response)
    try:
        me = response.json()
        discord_id = str(int(me['id']))
    except Exception:
        raise errors.discord_unavailable()
    return {
        'id': discord_id,
        'username': str(me.get('username') or '')[:64],
        'global_name': (str(me['global_name'])[:64] if me.get('global_name') else None),
        'avatar': (str(me['avatar'])[:64] if me.get('avatar') else None),
        'email': (str(me['email'])[:254] if me.get('email') else None),
        'verified': me.get('verified') is True,
    }


async def revoke(token, settings=None):
    """Best effort, 3 s: an unrevoked token simply expires after `expires_in`."""
    settings = settings or account_settings()
    try:
        async with _client(REVOKE_TIMEOUT) as client:
            await client.post(settings.discord_api_base + '/oauth2/token/revoke', auth=_auth(settings),
                              data={'token': token, 'token_type_hint': 'access_token'})
    except Exception:
        log.info('discord token revoke failed (it expires by itself)')
