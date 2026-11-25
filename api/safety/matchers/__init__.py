"""The vendor-neutral CSAM hash-matching interface (contract milestone-4 §3.1).

A matcher is called from the scan job process, never from the sandboxed child, and receives
only images: no filenames, user ids or anything else. `CSAM_MATCHER` picks the
implementation (`photodna` or `standin`); another vendor (Thorn Safer, StopNCII, TCAP) is
another implementation, and several can run in sequence later (any hit is a match).
"""

import functools

from dataclasses import dataclass, field
from typing import List, Optional, Protocol, Sequence

from utils import metrics


@dataclass(frozen=True)
class MatchImage:
    frame: int                 # the scan's frame number (file_hash_pdq.frame)
    source: str                # image | frame | cover | pdf_page | archive_entry
    jpeg: bytes                # fit 1024x1024, JPEG q90, made by the sandboxed child
    width: int
    height: int
    # the image's PDQ (64 hex) and quality, when the child computed one (the stand-in matches on it)
    pdq: Optional[str] = None
    pdq_quality: Optional[int] = None


@dataclass(frozen=True)
class MatchHit:
    frame: int
    list_id: Optional[str]     # the vendor's list or source name, if it gives one
    vendor_ref: Optional[str]  # the vendor's tracking id for this request


@dataclass(frozen=True)
class MatchOutcome:
    matcher: str               # 'photodna' | 'standin'
    hits: List[MatchHit] = field(default_factory=list)          # empty = no match
    unmatchable: List[int] = field(default_factory=list)        # frames the vendor refused as input
    vendor_refs: List[str] = field(default_factory=list)        # every tracking id, for the evidence record


class MatcherUnavailable(Exception):
    """Network errors, 5xx, 429, timeouts: retry; the hash stays pending."""


class HashMatcher(Protocol):
    name: str

    def match(self, images: Sequence[MatchImage], blake2b: Optional[str] = None) -> MatchOutcome: ...


def counted(match):
    """A matcher's `match`, counted in `filesgg_csam_matcher_calls_total` (milestone-7 §4.2): `match`, `no_match`,
    or `error` when it raised (uploads fail closed: the hash stays pending)."""
    @functools.wraps(match)
    def wrapper(self, images, blake2b=None):
        try:
            outcome = match(self, images, blake2b)
        except Exception:
            metrics.incr('filesgg_csam_matcher_calls_total', {'matcher': self.name, 'outcome': 'error'})
            raise
        metrics.incr('filesgg_csam_matcher_calls_total',
                     {'matcher': self.name, 'outcome': 'match' if outcome.hits else 'no_match'})
        return outcome
    return wrapper


def get_matcher(settings=None):
    """The configured matcher. Refuses `standin` without FILESGG_DEV_TOOLS=1 (§3.1)."""
    from safety.settings import check_matcher, safety_settings
    settings = check_matcher(settings or safety_settings())
    if settings.csam_matcher == 'photodna':
        from safety.matchers.photodna import PhotoDNAMatcher
        return PhotoDNAMatcher.from_settings(settings)
    from safety.matchers.standin import StandinMatcher
    return StandinMatcher.from_settings(settings)
