"""Cloudflare for SaaS custom hostnames (contract milestone-6 §10.5). Synchronous: the domain checks run in
`python -m worker` and, from the API, in a thread (safety/run.py).

    POST   /zones/{zone_id}/custom_hostnames          create
    GET    /zones/{zone_id}/custom_hostnames/{id}     read
    PATCH  /zones/{zone_id}/custom_hostnames/{id}     re-check (the same `ssl` object)
    DELETE /zones/{zone_id}/custom_hostnames/{id}     delete (404 counts as done)

The base is CLOUDFLARE_API_BASE (default https://api.cloudflare.com/client/v4), with the API token in the
`Authorization` header and a 10 s timeout. Tests set `TRANSPORT` to an `httpx.MockTransport`.
"""

import logging

import httpx

from utils.account_settings import account_settings

log = logging.getLogger(__name__)

TIMEOUT = 10.0
SSL = {'method': 'http', 'type': 'dv', 'settings': {'min_tls_version': '1.2', 'http2': 'on', 'tls_1_3': 'on'}}
# tests: an httpx transport that stands in for Cloudflare
TRANSPORT = None


class CloudflareError(Exception):
    """Cloudflare refused, failed or didn't answer in time."""


def _client(settings):
    return httpx.Client(timeout=TIMEOUT, transport=TRANSPORT, headers={
        'Authorization': 'Bearer {}'.format(settings.cloudflare_api_token), 'Content-Type': 'application/json'})


def _url(settings, hostname_id=None):
    url = '{}/zones/{}/custom_hostnames'.format(settings.cloudflare_api_base, settings.cloudflare_zone_id)
    return url + '/' + hostname_id if hostname_id else url


def _result(response):
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 300 or not body.get('success', False):
        log.warning('cloudflare answered %s: %s', response.status_code,
                    [e.get('code') for e in body.get('errors') or [] if isinstance(e, dict)])
        raise CloudflareError(response.status_code)
    return body.get('result') or {}


def summary(result):
    """(id, hostname status, ssl status) of a custom hostname result."""
    ssl = result.get('ssl') if isinstance(result.get('ssl'), dict) else {}
    return result.get('id'), result.get('status'), ssl.get('status')


def _call(method, settings, hostname_id=None, json=None):
    if not settings.domains_enabled:
        raise CloudflareError('not configured')
    try:
        with _client(settings) as client:
            return client.request(method, _url(settings, hostname_id), json=json)
    except httpx.HTTPError as error:
        log.warning('cloudflare request failed: %s', type(error).__name__)
        raise CloudflareError('network')


def create(hostname, settings=None):
    settings = settings or account_settings()
    return summary(_result(_call('POST', settings, json={'hostname': hostname, 'ssl': SSL})))


def get(hostname_id, settings=None):
    settings = settings or account_settings()
    return summary(_result(_call('GET', settings, hostname_id)))


def recheck(hostname_id, settings=None):
    """Re-sending the same SSL settings makes Cloudflare re-check a pending hostname."""
    settings = settings or account_settings()
    return summary(_result(_call('PATCH', settings, hostname_id, json={'ssl': SSL})))


def delete(hostname_id, settings=None):
    """True when the hostname is gone (a 404 counts)."""
    settings = settings or account_settings()
    response = _call('DELETE', settings, hostname_id)
    if response.status_code == 404:
        return True
    _result(response)
    return True
