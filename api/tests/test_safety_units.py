"""Milestone 4 units and test vectors (contract §14): staff grant signatures, abuse IP hashes,
effective states, the NSFW flag, scan outcomes, the matchers (PhotoDNA against a mocked HTTP
layer only), ClamAV replies, Web Risk, PDQ helpers, sealed IPs and configuration refusals."""

import base64
import json

import httpx
import pytest

from tests.conftest import EVIDENCE_PRIVATE_KEY

SECRET = 'test-cdn-signing-secret'


# --- §14.1 staff grant signatures ----------------------------------------------------------------------

STAFF_VECTORS = [
    ('/files/abc123.png', 'staff:555555555555555555:1234567890123456789', 'xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk'),
    ('/previews/thumb/abc123.webp', 'staff:555555555555555555:1234567890123456789',
     'iFEB3jhXpXydlpjhc4oefiKwO4n2afK7iXj3MJ4mIVY'),
    ('/files/abc123.png', 'staff:555555555555555556:1234567890123456789', 'yw_60Ca7UMA3Y07HsKVPtC9j-1TwPAo3rx7Ne4r2Epw'),
]


@pytest.mark.parametrize('path, grant, sig', STAFF_VECTORS)
def test_staff_grant_vectors(path, grant, sig):
    from utils.cdn_signing import signature, staff_grant
    assert signature(path, 1795603600, grant, SECRET) == sig
    assert staff_grant(*map(int, grant.split(':')[1:])) == grant


def test_staff_grant_acceptance():
    from utils.cdn_signing import verify_staff
    now = 1795603600 - 300
    assert verify_staff('/files/abc123.png', 555555555555555555, 1234567890123456789, 1795603600,
                        STAFF_VECTORS[0][2], now=now, secret=SECRET)
    assert verify_staff('/previews/thumb/abc123.webp', 555555555555555555, 1234567890123456789, 1795603600,
                        STAFF_VECTORS[1][2], now=now, secret=SECRET)
    # the grant built from staff= doesn't match the one it was signed for
    assert not verify_staff('/files/abc123.png', 555555555555555555, 1234567890123456789, 1795603600,
                            STAFF_VECTORS[2][2], now=now, secret=SECRET)
    # expires more than 600 s away
    assert not verify_staff('/files/abc123.png', 555555555555555555, 1234567890123456789, 1795603600,
                            STAFF_VECTORS[0][2], now=1795602900, secret=SECRET)
    # expired
    assert not verify_staff('/files/abc123.png', 555555555555555555, 1234567890123456789, 1795603600,
                            STAFF_VECTORS[0][2], now=1795603600, secret=SECRET)


def test_signed_staff_urls_live_ten_minutes_at_most():
    from urllib.parse import parse_qs, urlsplit
    from utils.cdn_signing import configure, sign_staff, verify_staff
    configure(SECRET)
    url = sign_staff('https://cdn.files.gg/files/abc123.png', 7, 9, ttl=3600, now=1795600000)
    query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    assert query['staff'] == '7' and int(query['expires']) == 1795600600
    assert verify_staff(urlsplit(url).path, 7, 9, query['expires'], query['sig'], now=1795600001)


# --- §14.2 abuse IP hashes ----------------------------------------------------------------------------------

@pytest.mark.parametrize('ip, normalized, expected', [
    ('203.0.113.7', '203.0.113.7', 'a066857f2c5094fa4d5bd59bf031051e48131a610ccec3498859cfb8b5116f6a'),
    ('::ffff:203.0.113.7', '203.0.113.7', 'a066857f2c5094fa4d5bd59bf031051e48131a610ccec3498859cfb8b5116f6a'),
    ('2001:db8::1', '2001:db8::/64', '99bb79de0d1a09f4cf06d6f990b73af2636a74ffd22e8b6db9540b74964fda64'),
    ('2001:0DB8:0000:0000:abcd::9', '2001:db8::/64', '99bb79de0d1a09f4cf06d6f990b73af2636a74ffd22e8b6db9540b74964fda64'),
])
def test_abuse_ip_hash_vectors(ip, normalized, expected):
    from safety.ip import abuse_ip_hash, normalize
    assert normalize(ip) == normalized
    assert abuse_ip_hash(ip, 'test-abuse-hash-secret').hex() == expected


def test_sealed_ips_open_only_with_the_offline_key():
    from nacl.public import SealedBox
    from safety.ip import seal_ip
    public = base64.b64encode(bytes(EVIDENCE_PRIVATE_KEY.public_key)).decode()
    sealed = seal_ip('203.0.113.7', public)
    assert b'203.0.113.7' not in sealed
    assert SealedBox(EVIDENCE_PRIVATE_KEY).decrypt(sealed) == b'203.0.113.7'


# --- §14.3 and §14.4: states and NSFW --------------------------------------------------------------------------

@pytest.mark.parametrize('scan_state, moderation, owner, lookup', [
    ('pending', 'visible', 'pending', 'pending'),
    ('passed', 'hidden', 'hidden', 'hidden'),
    ('flagged', 'visible', 'flagged', 'ok'),
    ('held', 'visible', 'hidden', 'hidden'),
    ('blocked', 'removed', 'blocked', 'blocked'),
    ('passed', 'visible', 'ok', 'ok'),
    ('passed', 'removed', 'removed', 'removed'),
])
def test_effective_state_table(scan_state, moderation, owner, lookup):
    from safety import states
    assert states.owner_state(scan_state, moderation) == owner
    assert states.lookup_state(scan_state, moderation) == lookup


def test_public_and_owner_reasons():
    from safety import states
    assert states.public_reason('hidden', 'spam') == 'review'
    assert states.public_reason('removed', 'copyright') == 'copyright'
    assert states.public_reason('removed', 'phishing') == 'malware'
    assert states.public_reason('removed', 'harassment') == 'terms'
    # anything CSAM-related is only ever `review` (hidden) or FILE_BLOCKED (blocked) to the owner
    assert states.owner_reason('blocked', 'csam_match', None) == 'FILE_BLOCKED'
    assert states.owner_reason('hidden', None, 'csam') == 'review'
    assert states.owner_reason('hidden', 'pdq_near_match', None, scan_state='held') == 'review'
    assert states.owner_reason('hidden', None, 'spam', moderation_auto=True) == 'review'
    assert states.owner_reason('hidden', None, 'spam') == 'spam'
    assert states.owner_reason('flagged', 'web_risk', None) == 'web_risk'


@pytest.mark.parametrize('auto, marked, override, source_kind, nsfw, source, locked', [
    (False, False, None, None, False, None, False),
    (False, True, None, None, True, 'uploader', False),
    (True, False, None, None, True, 'auto', True),
    (True, True, None, None, True, 'uploader', True),
    (True, False, 'safe', 'moderator', False, 'moderator', True),
    (False, False, 'nsfw', 'reports', True, 'reports', True),
])
def test_nsfw_table(auto, marked, override, source_kind, nsfw, source, locked):
    from safety import states
    assert states.file_nsfw(override, source_kind, marked, auto) == (nsfw, source)
    assert states.nsfw_locked(override, auto) is locked


def test_the_score_is_the_maximum_over_frames():
    from media import nsfw
    import numpy as np
    probabilities = [0.15, 0.92, 0.01]
    logits = [np.log([p, 1 - p]) for p in probabilities]
    scores = [float(nsfw.softmax(l)[0]) for l in logits]
    assert max(scores) == pytest.approx(0.92) and max(scores) >= 0.85


def test_preprocessing_follows_the_json():
    from PIL import Image
    from media import nsfw
    config = nsfw.load_config()
    assert config['input_size'] == [3, 384, 384] and config['nsfw_index'] == 0 and config['labels'][0] == 'NSFW'
    array = nsfw.preprocess(Image.new('RGB', (800, 200), (255, 255, 255)), config)
    assert array.shape == (1, 3, 384, 384) and array.dtype.name == 'float32' and array.flags['C_CONTIGUOUS']
    assert float(array.max()) == pytest.approx(1.0)  # (1 - 0.5) / 0.5


# --- scan outcomes (§2.3) ---------------------------------------------------------------------------------

def test_the_strongest_outcome_wins_then_the_first_code():
    from safety.scan import outcome
    def f(*codes):
        return [{'check': 'x', 'code': c} for c in codes]
    assert outcome([]) == ('passed', None)
    assert outcome(f('web_risk', 'pdf_javascript')) == ('flagged', 'pdf_javascript')
    assert outcome(f('web_risk', 'pdq_near_match')) == ('held', 'pdq_near_match')
    assert outcome(f('archive_bomb', 'malware', 'pdq_near_match')) == ('blocked', 'malware')
    assert outcome(f('blocked_type', 'csam_match')) == ('blocked', 'csam_match')
    assert outcome(f('unwanted_software', 'polyglot_archive')) == ('flagged', 'unwanted_software')


def test_distinct_reporters():
    from safety.reports import distinct_reporters
    a, b = b'\x01' * 32, b'\x02' * 32
    assert distinct_reporters([(1, None, a), (2, None, b)]) == 2
    assert distinct_reporters([(1, None, a), (2, None, a)]) == 1  # same network
    assert distinct_reporters([(1, None, a), (1, None, b)]) == 1  # same account
    assert distinct_reporters([(None, 5, a), (None, 6, b)]) == 2  # different fingerprints
    assert distinct_reporters([(None, None, a), (None, None, b)]) == 1  # anonymous without fingerprints
    assert distinct_reporters([(None, 5, None), (1, None, None)]) == 2


# --- the matchers (§3.1-§3.3) ------------------------------------------------------------------------------

def image(frame=0, pdq=None, quality=None):
    from safety.matchers import MatchImage
    return MatchImage(frame=frame, source='image', jpeg=b'\xff\xd8' + bytes([frame]) * 64, width=10, height=10,
                      pdq=pdq, pdq_quality=quality)


def photodna(handler):
    from safety.matchers.photodna import PhotoDNAMatcher, RateLimiter
    http = httpx.Client(transport=httpx.MockTransport(handler))
    return PhotoDNAMatcher('test-key', 'https://photodna.test/photodna/v1.0/Match', http=http,
                           limiter=RateLimiter(0))


def test_photodna_request_and_mapping():
    seen = []

    def handler(request):
        seen.append(request)
        frame = request.content[2]
        if frame == 0:
            return httpx.Response(200, json={'Status': {'Code': 3000}, 'IsMatch': False, 'TrackingId': 'T0'})
        return httpx.Response(200, json={'Status': {'Code': 3000}, 'IsMatch': True, 'TrackingId': 'T1',
                                         'MatchDetails': {'MatchFlags': [{'Source': 'NCMEC', 'Violations': ['A1']},
                                                                         {'Source': 'IWF', 'Violations': []}]}})
    outcome = photodna(handler).match([image(1), image(0)])
    assert outcome.matcher == 'photodna' and outcome.vendor_refs == ['T0', 'T1'] and outcome.unmatchable == []
    assert [(h.frame, h.list_id, h.vendor_ref) for h in outcome.hits] == [(1, 'NCMEC,IWF', 'T1')]
    request = seen[0]
    assert request.method == 'POST' and request.url.params['enhance'] == 'true'
    assert request.headers['Ocp-Apim-Subscription-Key'] == 'test-key'
    assert request.headers['Content-Type'] == 'image/jpeg' and request.content == image(0).jpeg


def test_photodna_invalid_images_are_unmatchable():
    def handler(request):
        return httpx.Response(400, json={'Status': {'Code': 3004, 'Description': 'Image too small'},
                                         'TrackingId': 'T9'})
    outcome = photodna(handler).match([image(0)])
    assert outcome.hits == [] and outcome.unmatchable == [0] and outcome.vendor_refs == ['T9']


@pytest.mark.parametrize('response', [
    lambda r: httpx.Response(429, json={}),
    lambda r: httpx.Response(503, text='busy'),
    lambda r: httpx.Response(200, json={'Status': {'Code': 3999}}),
    lambda r: httpx.Response(200, text='not json'),
    lambda r: (_ for _ in ()).throw(httpx.ConnectTimeout('slow')),
])
def test_photodna_failures_are_retries(response):
    from safety.matchers import MatcherUnavailable
    with pytest.raises(MatcherUnavailable):
        photodna(response).match([image(0)])


def test_photodna_rate_limiter_spaces_calls():
    from safety.matchers.photodna import RateLimiter
    clock = {'now': 100.0}
    slept = []

    def sleep(seconds):
        slept.append(seconds)
        clock['now'] += seconds
    limiter = RateLimiter(5, clock=lambda: clock['now'], sleep=sleep)
    for _ in range(3):
        limiter.wait()
    assert slept == [pytest.approx(0.2), pytest.approx(0.2)]


def test_standin_list_and_modes(tmp_path):
    from safety.matchers import MatcherUnavailable
    from safety.matchers.standin import StandinMatcher, read_list
    near = 'f' * 64
    listed = tmp_path / 'list.txt'
    listed.write_text('# comment\nblake2b:abc\npdq:{}\n'.format('0' * 64))
    matcher = StandinMatcher(read_list(str(listed)))
    assert [h.frame for h in matcher.match([image(0), image(1)], blake2b='abc').hits] == [0, 1]
    one_bit = '0' * 63 + '1'
    hits = matcher.match([image(0, one_bit, 90), image(1, near, 90), image(2, one_bit, 10)]).hits
    assert [h.frame for h in hits] == [0]  # within 31, and quality >= 50 only
    assert hits[0].vendor_ref.startswith('standin-0-') and len(hits[0].vendor_ref) == len('standin-0-') + 8
    with pytest.raises(MatcherUnavailable):
        StandinMatcher([], mode='unavailable').match([image(0)])


def test_the_standin_refuses_without_dev_tools(monkeypatch):
    from safety.matchers import get_matcher
    from safety.settings import ConfigError
    monkeypatch.delenv('FILESGG_DEV_TOOLS')
    with pytest.raises(ConfigError, match='FILESGG_DEV_TOOLS'):
        get_matcher()
    monkeypatch.setenv('CSAM_MATCHER', 'photodna')
    with pytest.raises(ConfigError, match='PHOTODNA_SUBSCRIPTION_KEY'):
        get_matcher()
    monkeypatch.setenv('PHOTODNA_SUBSCRIPTION_KEY', 'k')
    assert get_matcher().name == 'photodna'
    monkeypatch.delenv('CSAM_MATCHER')
    with pytest.raises(ConfigError, match='CSAM_MATCHER'):
        get_matcher()


def test_the_api_refuses_to_boot_without_its_safety_settings(monkeypatch):
    from safety.settings import ConfigError, check_api, check_scanner
    check_api()
    check_scanner()
    monkeypatch.setenv('EVIDENCE_PUBLIC_KEY', 'not-a-key')
    with pytest.raises(ConfigError, match='EVIDENCE_PUBLIC_KEY'):
        check_api()
    monkeypatch.delenv('ABUSE_HASH_SECRET')
    with pytest.raises(ConfigError, match='ABUSE_HASH_SECRET'):
        check_api()


def test_only_the_scanner_needs_the_photodna_key(monkeypatch):
    """The API validates the matcher's name only and never holds PHOTODNA_SUBSCRIPTION_KEY
    (docker-compose.yml gives it to the scanner and rescanner alone); they refuse to start without it."""
    from safety.settings import ConfigError, check_api, check_scanner
    monkeypatch.setenv('CSAM_MATCHER', 'photodna')
    monkeypatch.delenv('PHOTODNA_SUBSCRIPTION_KEY', raising=False)
    check_api()
    with pytest.raises(ConfigError, match='PHOTODNA_SUBSCRIPTION_KEY'):
        check_scanner()
    monkeypatch.setenv('PHOTODNA_SUBSCRIPTION_KEY', 'k')
    check_api()
    check_scanner()
    # the name is still checked by both
    monkeypatch.setenv('CSAM_MATCHER', 'nope')
    for check in (check_api, check_scanner):
        with pytest.raises(ConfigError, match='CSAM_MATCHER'):
            check()
    monkeypatch.setenv('CSAM_MATCHER', 'standin')
    monkeypatch.delenv('FILESGG_DEV_TOOLS', raising=False)
    for check in (check_api, check_scanner):
        with pytest.raises(ConfigError, match='FILESGG_DEV_TOOLS'):
            check()


# --- ClamAV, Web Risk and PDQ ----------------------------------------------------------------------------

def test_clamd_replies():
    from safety.clamav import ClamAVUnavailable, classify, parse_reply
    assert parse_reply('stream: OK') is None
    assert parse_reply('stream: Win.Test.EICAR_HDB-1 FOUND') == 'Win.Test.EICAR_HDB-1'
    for reply in ('INSTREAM size limit exceeded. ERROR', '', 'stream: ERROR'):
        with pytest.raises(ClamAVUnavailable):
            parse_reply(reply)
    assert classify('PUA.Win.Packer.Upx-1', ('PUA.', 'Heuristics.')) == 'unwanted_software'
    assert classify('Heuristics.Encrypted.Zip', ('PUA.', 'Heuristics.')) == 'unwanted_software'
    assert classify('Win.Trojan.Agent-1', ('PUA.', 'Heuristics.')) == 'malware'


@pytest.mark.parametrize('signature, code', [
    # clamd's limits (AlertExceedsMax yes): a partial scan, the warning only, never unwanted software
    ('Heuristics.Limits.Exceeded.MaxRecursion', 'archive_partially_scanned'),
    ('Heuristics.Limits.Exceeded.MaxFiles', 'archive_partially_scanned'),
    ('Heuristics.Limits.Exceeded.MaxFileSize', 'archive_partially_scanned'),
    ('Heuristics.Limits.Exceeded.MaxScanSize', 'archive_partially_scanned'),
    ('Heuristics.Limits.Exceeded.MaxScanTime', 'archive_partially_scanned'),
    ('Heuristics.Limits.Exceeded', 'archive_partially_scanned'),
    ('Heuristics.Encrypted.Zip', 'unwanted_software'),
    ('Heuristics.Broken.Executable', 'unwanted_software'),
    ('PUA.Win.Packer.Upx-1', 'unwanted_software'),
    ('Win.Trojan.Agent-1', 'malware'),
    ('Filesgg.Test.EICAR-1.UNOFFICIAL', 'malware'),
])
def test_clamav_classification(signature, code):
    from safety.clamav import classify
    assert classify(signature, ('PUA.', 'Heuristics.')) == code
    # the limits stay a warning even when the flag-only prefixes are narrowed
    if code == 'archive_partially_scanned':
        assert classify(signature, ()) == code


def test_clamav_limits_are_a_warning_not_a_finding(monkeypatch):
    from safety import scan
    from safety.settings import safety_settings

    class Fake:
        def __init__(self, signature):
            self.signature = signature

        def version(self):
            return {'engine': '1.5.5', 'db': 'daily 1'}

        def scan_file(self, path):
            return self.signature

    settings = safety_settings()
    for signature, finding, warning in [
            ('Heuristics.Limits.Exceeded.MaxFiles', None, 'archive_partially_scanned'),
            ('PUA.Win.Packer.Upx-1', 'unwanted_software', 'unwanted_software'),
            ('Win.Trojan.Agent-1', 'malware', None)]:
        monkeypatch.setattr(scan, 'get_clamav', lambda: Fake(signature))
        findings, warnings = [], []
        result = scan.clamav_check('/nonexistent', 10, 'archive', settings, findings, warnings)
        assert [f['code'] for f in findings] == ([finding] if finding else [])
        assert warnings == ([warning] if warning else [])
        assert result['signature'] == signature
        if finding is None:
            assert result['result'] == 'clean' and result['partial'] is True
        else:
            assert result['result'] == 'detected'


def test_clamd_scans_eicar_by_stream(tmp_path):
    from safety.clamav import ClamAV
    from safety.settings import safety_settings
    from tests.m4 import EICAR
    clamav = ClamAV.from_settings(safety_settings())
    path = tmp_path / 'eicar'
    path.write_bytes(EICAR)
    assert clamav.scan_file(str(path)).startswith('Filesgg.Test.EICAR-1')
    path.write_bytes(b'nothing to see')
    assert clamav.scan_file(str(path)) is None
    assert clamav.version()['engine'].startswith('1.5')


def test_web_risk_lookup_and_expiry():
    from safety.webrisk import WebRisk, extract_urls, payload_fields
    seen = []

    def handler(request):
        seen.append(request)
        if request.url.params['uri'] == 'https://bad.test/':
            return httpx.Response(200, json={'threat': {'threatTypes': ['SOCIAL_ENGINEERING'],
                                                        'expireTime': '2099-01-01T00:00:00.5Z'}})
        return httpx.Response(200, json={})
    risk = WebRisk(api_key='key', http=httpx.Client(transport=httpx.MockTransport(handler)))
    result, hits = risk.check(['https://ok.test/', 'https://bad.test/'])
    assert result == {'result': 'flag', 'urls': 2, 'hits': 1}
    assert hits == [{'url': 'https://bad.test/', 'threat_types': ['SOCIAL_ENGINEERING'], 'expires_at': 4070908800}]
    params = seen[0].url.params
    assert params.get_list('threatTypes') == ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE']
    assert params['key'] == 'key' and seen[0].url.path == '/v1/uris:search'
    assert payload_fields(hits + [{'url': 'https://old.test/', 'threat_types': [], 'expires_at': 1}]) == (
        ['https://bad.test/'], {'https://bad.test/': ['SOCIAL_ENGINEERING']})
    # errors fail open
    failing = WebRisk(api_key='key', http=httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(500))))
    assert failing.check(['https://x.test/'])[0] == {'result': 'skipped', 'error': 'HTTP 500', 'urls': 1}
    assert extract_urls('a https://a.test/x. b http://b.test/(y) https://a.test/x', 10) == [
        'https://a.test/x', 'http://b.test/(y']


def test_pdq_helpers():
    from safety.pdq import distance, from_bits, to_bits
    value = 'cb30799c399ec732266c5f0ac6c3b528a0f1cad71c0c82d7c7931a5f4b1ee0f5'
    assert from_bits(to_bits(value)) == value and len(to_bits(value)) == 256
    assert distance(value, value) == 0 and distance('0' * 64, '0' * 63 + '3') == 2


def test_pdq_needs_contiguous_input():
    """§3.4: the child hashes a C-contiguous uint8 RGB copy (pdqhash 0.2.8 can return wrong hashes
    for non-contiguous views), so a transposed view hashes as its own contiguous copy does."""
    import numpy as np
    from PIL import Image
    from media.scanning import pdq_of
    rng = np.random.default_rng(7)
    array = rng.integers(0, 255, (300, 200, 3), dtype=np.uint8)
    image = Image.fromarray(array)
    view = array.transpose(1, 0, 2)
    assert not view.flags['C_CONTIGUOUS']
    assert pdq_of(Image.fromarray(view)) == pdq_of(Image.fromarray(np.ascontiguousarray(view)))
    assert pdq_of(image) == pdq_of(Image.fromarray(array.copy()))


def test_settings_defaults():
    from safety.settings import safety_settings
    settings = safety_settings()
    assert settings.nsfw_threshold == 0.85 and settings.pdq_match_distance == 31
    assert settings.report_thresholds == {'violence': 2, 'malware': 2, 'adult_unmarked': 2, 'harassment': 3,
                                          'spam': 3}
    assert (settings.scan_wall, settings.scan_cpu, settings.scan_address_space) == (120, 90, 2147483648)
    assert settings.clamav_flag_only_prefixes == ('PUA.', 'Heuristics.') and settings.staff_url_ttl == 600
    assert json.dumps(settings.report_thresholds)
