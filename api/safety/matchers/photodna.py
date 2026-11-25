"""The PhotoDNA Cloud Service adapter (contract milestone-4 §3.2).

CORROBORATED, NOT CONFIRMED. Microsoft's API reference for PhotoDNA isn't public: it's in the
API Management developer portal (developer.microsoftmoderator.com), open only to onboarded
subscribers. Everything below (the URL, the header, the query parameter, the request and the
response fields, status code 3000, which statuses mean "invalid image") follows independent
client code that calls the live service, not a Microsoft document. Confirm every field, limit
and status code in the portal before relying on this, record the confirmed version in the
contract, and adjust this file and its tests (tests/test_safety_matchers.py) to match.

- Request: `POST <PHOTODNA_MATCH_URL>?enhance=true`, `Content-Type: image/jpeg`, the image
  bytes as the body, `Ocp-Apim-Subscription-Key: <PHOTODNA_SUBSCRIPTION_KEY>`. One request
  per image, rate-limited client-side to PHOTODNA_MAX_RPS per scanner process.
- Response: JSON with `Status.Code` (3000 = success), `IsMatch`, `MatchDetails.MatchFlags[]`
  (`Source`, `Violations[]`) and `TrackingId`.
- Mapping: success + IsMatch -> a hit (`vendor_ref` = TrackingId, `list_id` = the `Source`
  values joined with ","); success + not IsMatch -> no hit; an "invalid image" status ->
  unmatchable; any other status, a timeout, a 429 or a 5xx -> MatcherUnavailable (retry).
- Images are sent to Microsoft (the Privacy policy must say so). Microsoft says the service
  doesn't store them.
"""

import threading
import time

from safety.matchers import MatchHit, MatcherUnavailable, MatchOutcome

HEADER = 'Ocp-Apim-Subscription-Key'
SUCCESS = 3000
# Statuses independent clients treat as "the image can't be used" (too small, unreadable,
# unsupported). Unconfirmed: check them against the portal.
INVALID_IMAGE_STATUSES = frozenset((3002, 3004, 3005, 3006, 3007, 3008))
# what independent clients send; what `enhance` does isn't public (§3.2): use Microsoft's recommendation
ENHANCE = 'true'


class RateLimiter:
    """At most `rate` calls a second in this process (a simple spacing limiter)."""

    def __init__(self, rate, clock=time.monotonic, sleep=time.sleep):
        self.interval = 1.0 / rate if rate and rate > 0 else 0.0
        self.clock = clock
        self.sleep = sleep
        self.next = 0.0
        self.lock = threading.Lock()

    def wait(self):
        if not self.interval:
            return
        with self.lock:
            now = self.clock()
            if now < self.next:
                self.sleep(self.next - now)
                now = self.next
            self.next = now + self.interval


class PhotoDNAMatcher:
    name = 'photodna'

    def __init__(self, key, url, timeout=10.0, max_rps=5.0, http=None, limiter=None):
        if not key:
            raise ValueError('PHOTODNA_SUBSCRIPTION_KEY is required')
        self.key = key
        self.url = url
        self.timeout = timeout
        self.limiter = limiter or RateLimiter(max_rps)
        self._http = http

    @classmethod
    def from_settings(cls, settings, http=None):
        return cls(settings.photodna_subscription_key, settings.photodna_match_url, settings.photodna_timeout,
                   settings.photodna_max_rps, http=http)

    @property
    def http(self):
        if self._http is None:
            import httpx
            self._http = httpx.Client(timeout=self.timeout, follow_redirects=False)
        return self._http

    def match(self, images, blake2b=None):
        hits, unmatchable, refs = [], [], []
        for image in sorted(images, key=lambda i: i.frame):
            body = self._call(image)
            status = (body.get('Status') or {}).get('Code')
            ref = body.get('TrackingId')
            if ref:
                refs.append(str(ref))
            if status == SUCCESS:
                if body.get('IsMatch') is True:
                    flags = ((body.get('MatchDetails') or {}).get('MatchFlags') or [])
                    sources = [str(flag.get('Source')) for flag in flags if flag.get('Source')]
                    hits.append(MatchHit(frame=image.frame, list_id=','.join(sources) or None,
                                         vendor_ref=str(ref) if ref else None))
                elif body.get('IsMatch') is not False:
                    raise MatcherUnavailable('PhotoDNA answered without IsMatch')
            elif status in INVALID_IMAGE_STATUSES:
                unmatchable.append(image.frame)
            else:
                raise MatcherUnavailable('PhotoDNA status {!r}'.format(status))
        return MatchOutcome(matcher=self.name, hits=hits, unmatchable=unmatchable, vendor_refs=refs)

    def _call(self, image):
        import httpx
        self.limiter.wait()
        try:
            response = self.http.post(self.url, params={'enhance': ENHANCE}, content=image.jpeg,
                                      headers={HEADER: self.key, 'Content-Type': 'image/jpeg'},
                                      timeout=self.timeout)
        except httpx.HTTPError as error:
            raise MatcherUnavailable('PhotoDNA request failed: {}'.format(type(error).__name__))
        if response.status_code == 429 or response.status_code >= 500:
            raise MatcherUnavailable('PhotoDNA HTTP {}'.format(response.status_code))
        try:
            body = response.json()
        except ValueError:
            raise MatcherUnavailable('PhotoDNA HTTP {} without JSON'.format(response.status_code))
        if not isinstance(body, dict):
            raise MatcherUnavailable('PhotoDNA answered {}'.format(type(body).__name__))
        if response.status_code != 200 and (body.get('Status') or {}).get('Code') not in INVALID_IMAGE_STATUSES:
            raise MatcherUnavailable('PhotoDNA HTTP {}'.format(response.status_code))
        return body
