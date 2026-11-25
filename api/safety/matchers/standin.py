"""The stand-in matcher (contract milestone-4 §3.3): for tests and local development only,
until PhotoDNA access is approved. It never uses real material: its list holds the hashes of
benign generated images (tests/fixtures/standin/, made by make_fixtures.py).

`STANDIN_MATCH_FILE`, one entry per line, `#` comments allowed:
- `blake2b:<hex>`: matches when the scanned blob's blake2b is this value (all its images are
  hits, frame 0 first);
- `pdq:<64 hex>`: matches an image whose PDQ is within distance 31 (PDQ_MATCH_DISTANCE) of it.

`STANDIN_MODE`: `list` (default), or `unavailable` (every call raises MatcherUnavailable),
to test failing closed. Refuses to exist without FILESGG_DEV_TOOLS=1 (§3.1).
"""

import hashlib

from safety.matchers import MatchHit, MatcherUnavailable, MatchOutcome
from safety.pdq import MIN_QUALITY, distance

LIST_ID = 'STANDIN'


class StandinMatcher:
    name = 'standin'

    def __init__(self, entries, mode='list', max_distance=31):
        self.blake2b = {value for kind, value in entries if kind == 'blake2b'}
        self.pdq = [value for kind, value in entries if kind == 'pdq']
        self.mode = mode
        self.max_distance = max_distance

    @classmethod
    def from_settings(cls, settings):
        if not settings.dev_tools:
            raise RuntimeError('the stand-in matcher needs FILESGG_DEV_TOOLS=1')
        return cls(read_list(settings.standin_match_file), settings.standin_mode, settings.pdq_match_distance)

    def match(self, images, blake2b=None):
        if self.mode == 'unavailable':
            raise MatcherUnavailable('STANDIN_MODE=unavailable')
        hits, refs = [], []
        whole = blake2b is not None and blake2b.lower() in self.blake2b
        for image in sorted(images, key=lambda i: i.frame):
            ref = 'standin-{}-{}'.format(image.frame, hashlib.sha256(image.jpeg).hexdigest()[:8])
            refs.append(ref)
            near = (image.pdq is not None and (image.pdq_quality or 0) >= MIN_QUALITY
                    and any(distance(image.pdq, entry) <= self.max_distance for entry in self.pdq))
            if whole or near:
                hits.append(MatchHit(frame=image.frame, list_id=LIST_ID, vendor_ref=ref))
        if whole and not images:
            hits.append(MatchHit(frame=0, list_id=LIST_ID, vendor_ref='standin-0-blob'))
            refs.append('standin-0-blob')
        return MatchOutcome(matcher=self.name, hits=hits, unmatchable=[], vendor_refs=refs)


def read_list(path):
    entries = []
    with open(path, 'r', encoding='utf-8') as handle:
        for line in handle:
            line = line.split('#', 1)[0].strip()
            if not line:
                continue
            kind, _, value = line.partition(':')
            kind, value = kind.strip().lower(), value.strip().lower()
            if kind == 'blake2b' and value:
                entries.append(('blake2b', value))
            elif kind == 'pdq' and len(value) == 64:
                entries.append(('pdq', value))
            else:
                raise ValueError('bad stand-in list entry: {!r}'.format(line))
    return entries
