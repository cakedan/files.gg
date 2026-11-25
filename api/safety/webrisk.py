"""Google Web Risk Lookup API (contract milestone-4 §5.7): the one optional check. It fails
open: unconfigured, a timeout or an error gives `skipped` with an `error`, and the scan can
still pass (the +24 h rescan tries again).

    GET https://webrisk.googleapis.com/v1/uris:search?threatTypes=MALWARE
        &threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE&uri=<url>&key=<key>

One URL per request; a response with `threat` is a hit, `{}` is clean. `uris.search` only:
never `threatLists.computeDiff` from the same project (it reprices every search).

In development, WEB_RISK_STANDIN_FILE lists URLs (one per line) that count as hits, with no
network call.
"""

import re
import time

from datetime import datetime, timezone

SEARCH_URL = 'https://webrisk.googleapis.com/v1/uris:search'
THREAT_TYPES = ('MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE')
MAX_LINK_WARNINGS = 20
TIMEOUT = 10.0
URL_PATTERN = re.compile(r'https?://[^\s<>"\'\\^`{|}\x00-\x1f\x7f]+', re.IGNORECASE)
TRAILING = '.,;:!?)]}\'"'


# how long a stand-in hit lasts (the real API gives each match its own expireTime)
STANDIN_TTL = 86400


class WebRiskError(Exception):
    pass


def parse_time(value):
    """RFC 3339 ("2026-11-26T10:00:00.123456789Z") -> epoch seconds; unparseable -> now (no warning shown)."""
    if not value:
        return int(time.time())
    text = str(value).strip().replace('Z', '+00:00')
    match = re.match(r'^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}:\d{2})$', text)
    if not match:
        return int(time.time())
    parsed = datetime.fromisoformat(match.group(1) + match.group(3))
    return int(parsed.astimezone(timezone.utc).timestamp())


def fresh(matches, now=None):
    """The matches still within their expireTime: what payloads may warn about."""
    now = time.time() if now is None else now
    return [m for m in matches or () if isinstance(m, dict) and (m.get('expires_at') or 0) > now]


def payload_fields(matches, now=None):
    """(link_warnings: [url], link_warning_types: {url: [threat type]}) of the fresh matches, at most 20."""
    current = fresh(matches, now)[:MAX_LINK_WARNINGS]
    return [m['url'] for m in current], {m['url']: list(m.get('threat_types') or []) for m in current}


def extract_urls(text, limit=100):
    """http(s) URLs in order of appearance, deduplicated, at most `limit`."""
    out, seen = [], set()
    for match in URL_PATTERN.finditer(text or ''):
        url = match.group(0).rstrip(TRAILING)
        if len(url) > 2048 or url.lower() in ('http://', 'https://'):
            continue
        if url not in seen:
            seen.add(url)
            out.append(url)
            if len(out) >= limit:
                break
    return out


class WebRisk:
    def __init__(self, api_key=None, standin_file=None, http=None, timeout=TIMEOUT):
        self.api_key = api_key
        self.standin = None
        if standin_file:
            with open(standin_file, 'r', encoding='utf-8') as handle:
                self.standin = {line.strip() for line in handle if line.strip() and not line.startswith('#')}
        self.timeout = timeout
        self._http = http

    @classmethod
    def from_settings(cls, settings, http=None):
        return cls(settings.web_risk_api_key, settings.web_risk_standin_file, http=http)

    @property
    def configured(self):
        return bool(self.api_key) or self.standin is not None

    @property
    def http(self):
        if self._http is None:
            import httpx
            self._http = httpx.Client(timeout=self.timeout, follow_redirects=False)
        return self._http

    def lookup(self, url):
        """(threat types, expire time as epoch seconds) of a hit, or None when clean. Raises
        WebRiskError. A warning may be shown only until the match's `expireTime` (Google's rule)."""
        if self.standin is not None:
            return (['MALWARE'], int(time.time()) + STANDIN_TTL) if url in self.standin else None
        import httpx
        params = [('threatTypes', t) for t in THREAT_TYPES] + [('uri', url), ('key', self.api_key)]
        try:
            response = self.http.get(SEARCH_URL, params=params, timeout=self.timeout)
        except httpx.HTTPError as error:
            raise WebRiskError(type(error).__name__)
        if response.status_code != 200:
            raise WebRiskError('HTTP {}'.format(response.status_code))
        try:
            body = response.json()
        except ValueError:
            raise WebRiskError('not JSON')
        threat = body.get('threat') if isinstance(body, dict) else None
        if not threat:
            return None
        return list(threat.get('threatTypes') or ['UNKNOWN']), parse_time(threat.get('expireTime'))

    def check(self, urls):
        """The §2.8 check result: {"result": "clean" | "flag" | "skipped", ...} and the matches,
        [{url, threat_types, expires_at}], at most 20."""
        if not urls:
            return {'result': 'skipped', 'urls': 0}, []
        if not self.configured:
            return {'result': 'skipped', 'error': 'unconfigured', 'urls': len(urls)}, []
        hits = []
        try:
            for url in urls:
                found = self.lookup(url)
                if found:
                    hits.append({'url': url, 'threat_types': found[0], 'expires_at': found[1]})
        except WebRiskError as error:
            return {'result': 'skipped', 'error': str(error)[:200], 'urls': len(urls)}, []
        result = {'result': 'flag' if hits else 'clean', 'urls': len(urls)}
        if hits:
            result['hits'] = len(hits)
        return result, hits[:MAX_LINK_WARNINGS]
