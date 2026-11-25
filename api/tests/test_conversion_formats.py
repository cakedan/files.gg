"""Milestone 5 (docs/redesign/contracts/milestone-5.md §1, §6, §10.1): the format matrix as data, option
normalising and recipe hashes, and GET /conversions/formats."""

import pytest

from media import formats
from utils.responses import ApiError


def code_of(call, *args):
    with pytest.raises(ApiError) as raised:
        call(*args)
    return raised.value.code, {k: v for k, v in raised.value.data.items() if k not in ('code', 'message', 'status')}


# --- §6: recipes -----------------------------------------------------------------------------------------------------

def test_recipe_vectors():
    # the contract's test vectors: defaults are part of the recipe, and trims are rounded to milliseconds
    assert formats.normalise('image', 'jpg', {}) == formats.normalise('image', 'jpg', {'quality': 85}) == {
        'background': '#ffffff', 'quality': 85, 'strip_metadata': True}
    assert formats.recipe_hash('image', 'jpg', formats.normalise('image', 'jpg', {})) == \
        formats.recipe_hash('image', 'jpg', formats.normalise('image', 'jpg', {'quality': 85}))
    assert formats.normalise('audio', 'mp3', {'trim_start': 1.00049}, duration=10)['trim_start'] == 1.0
    assert formats.canonical(formats.recipe('audio', 'mp3', formats.normalise(
        'audio', 'mp3', {'trim_start': 1.00049}, duration=10))) == (
        '{"kind":"audio","options":{"bitrate":192,"keep_tags":true,"normalize":false,"trim_start":1.0},'
        '"target":"mp3","v":%d}' % formats.CONVERTER_VERSION)
    # enums and colours are lowercased, "none" values dropped, the version is part of the hash
    assert formats.normalise('image', 'jpg', {'background': '#AABBCC', 'max_width': None})['background'] == '#aabbcc'
    assert 'max_width' not in formats.normalise('image', 'jpg', {'max_width': None})
    assert formats.recipe_hash('image', 'png', {}) != formats.recipe_hash('image', 'webp', {})
    assert len(formats.recipe_hash('image', 'png', {})) == 32
    # same pages, one recipe
    assert formats.normalise('pdf', 'png', {'pages': '7, 1-3,2'})['pages'] == '1-3,7'
    # the margin is ignored for `fit`
    assert formats.normalise('images', 'pdf', {'margin_mm': 10}) == {'page_size': 'fit'}
    assert formats.normalise('images', 'pdf', {'margin_mm': 10, 'page_size': 'A4'}) == {'margin_mm': 10,
                                                                                        'page_size': 'a4'}


@pytest.mark.parametrize('kind, target, options, duration, expected', [
    ('image', 'jpg', {'colour': 1}, None, {'option': 'colour', 'reason': 'unknown'}),
    ('image', 'png', {'quality': 80}, None, {'option': 'quality', 'reason': 'not_applicable'}),
    ('image', 'jpg', {'quality': 101}, None, {'option': 'quality', 'reason': 'range'}),
    ('image', 'jpg', {'quality': '80'}, None, {'option': 'quality', 'reason': 'type'}),
    ('image', 'jpg', {'quality': True}, None, {'option': 'quality', 'reason': 'type'}),
    ('image', 'jpg', {'background': 'red'}, None, {'option': 'background', 'reason': 'type'}),
    ('image', 'png', {'strip_metadata': 'yes'}, None, {'option': 'strip_metadata', 'reason': 'type'}),
    ('video', 'mp4', {'max_height': 360}, 10, {'option': 'max_height', 'reason': 'value'}),
    ('video', 'mp4', {'trim_start': 5, 'trim_end': 4}, 10, {'option': 'trim_end', 'reason': 'before_start'}),
    ('animated', 'mp4', {'trim_start': 1}, None, {'option': 'trim_start', 'reason': 'no_duration'}),
    ('video', 'gif', {'mute': True}, 10, {'option': 'mute', 'reason': 'not_applicable'}),
    ('video', 'mp4', {'target_size': 'nitro'}, 10, {'option': 'target_size', 'reason': 'type'}),
    ('pdf', 'png', {'pages': '3-1'}, None, {'option': 'pages', 'reason': 'range'}),
    ('pdf', 'png', {'pages': 'all'}, None, {'option': 'pages', 'reason': 'type'}),
    ('audio', 'wav', {'bitrate': 128}, 10, {'option': 'bitrate', 'reason': 'not_applicable'}),
    ('image', 'png', 'quality=1', None, {'option': 'options', 'reason': 'type'}),
])
def test_invalid_options(kind, target, options, duration, expected):
    assert code_of(formats.normalise, kind, target, options, duration) == ('INVALID_OPTION', expected)


def test_trims_are_clamped_and_target_size_checked():
    assert formats.normalise('video', 'mp4', {'trim_start': 0, 'trim_end': 99}, duration=12.5) == {
        'mute': False, 'trim_end': 12.5}
    formats.check_target_size({'target_size': 'discord'}, 60)
    code, extra = code_of(formats.check_target_size, {'target_size': 1}, 600)
    assert code == 'TARGET_SIZE_TOO_SMALL' and extra['minimum_mb'] > 1
    # 100 kbps of video plus 128 of audio for 600 s: 228,000 × 600 / 8 / 0.97 = 17.6 MB (decimal), rounded up
    assert extra['minimum_mb'] == 18
    assert formats.target_video_kbps(10, 60, 128) > 1000


def test_targets_and_kinds():
    assert formats.resolve_target('video', None) == 'mp4'
    assert formats.resolve_target('document', '') == 'pdf'
    assert formats.resolve_target('image', 'same', 'image/jpeg') == 'jpg'
    assert formats.resolve_target('image', 'PNG') == 'png'
    assert code_of(formats.resolve_target, 'audio', 'mp4') == ('UNSUPPORTED_CONVERSION', {'kind': 'audio',
                                                                                         'target': 'mp4'})
    assert code_of(formats.resolve_target, None, 'png')[0] == 'UNSUPPORTED_CONVERSION'
    assert formats.source_kind('image/png', None, 'pending') == 'image'
    assert formats.source_kind('image/svg+xml', None, 'skipped') == 'image'
    assert formats.source_kind('image/gif', {'framecount': 1}, 'done') == 'image'
    assert formats.source_kind('image/gif', {'framecount': 12}, 'done') == 'animated'
    assert formats.source_kind('video/mp4', {'width': 640, 'duration': 2}, 'done') == 'video'
    assert formats.source_kind('video/mp4', {'duration': 2}, 'done') == 'audio'
    assert formats.source_kind('audio/mpeg', {'duration': 2}, 'done') == 'audio'
    assert formats.source_kind('application/pdf', None, 'pending') == 'pdf'
    assert formats.source_kind('application/msword', None, 'skipped') == 'document'
    assert formats.source_kind('text/plain', None, 'done') is None
    # a failed probe has no targets
    assert formats.source_kind('image/png', None, 'failed') is None
    with pytest.raises(formats.ProbePending):
        formats.source_kind('video/mp4', None, 'pending')
    assert formats.page_numbers('1-3,7', 5) == [1, 2, 3]
    assert formats.page_numbers(None, 3) == [1, 2, 3]


def test_formats_document(client):
    response = client.get('/conversions/formats')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'public, max-age=300'
    body = response.json()
    assert body['version'] == formats.CONVERTER_VERSION
    kinds = body['kinds']
    assert set(kinds) == {'image', 'animated', 'video', 'audio', 'document', 'pdf', 'images'}
    # §1.2 row by row
    assert [t['target'] for t in kinds['image']['targets']] == ['png', 'jpg', 'webp', 'avif', 'gif', 'ico']
    assert [t['target'] for t in kinds['animated']['targets']] == ['mp4', 'webm', 'webp', 'gif']
    assert [t['target'] for t in kinds['video']['targets']] == ['mp4', 'webm', 'gif', 'mp3', 'm4a', 'ogg', 'wav']
    assert [t['target'] for t in kinds['audio']['targets']] == ['mp3', 'm4a', 'ogg', 'flac', 'wav']
    assert [t['target'] for t in kinds['pdf']['targets']] == ['png', 'jpg']
    assert {k: v['default'] for k, v in kinds.items()} == {
        'image': 'png', 'animated': 'mp4', 'video': 'mp4', 'audio': 'mp3', 'document': 'pdf', 'pdf': 'png',
        'images': 'pdf'}
    by_target = {t['target']: t for t in kinds['image']['targets']}
    quality = next(o for o in by_target['jpg']['options'] if o['name'] == 'quality')
    assert quality == {'name': 'quality', 'type': 'int', 'label': 'Quality', 'default': 85, 'min': 1, 'max': 100}
    assert 'quality' not in [o['name'] for o in by_target['png']['options']]
    strip = next(o for o in by_target['png']['options'] if o['name'] == 'strip_metadata')
    assert strip['default'] is True
    mp4 = next(t for t in kinds['video']['targets'] if t['target'] == 'mp4')
    assert {o['name']: o['type'] for o in mp4['options']} == {
        'max_height': 'enum', 'trim_start': 'number', 'trim_end': 'number', 'mute': 'bool', 'target_size': 'size'}
    assert next(o for o in mp4['options'] if o['name'] == 'max_height')['values'] == [1080, 720, 480]
    size = next(o for o in mp4['options'] if o['name'] == 'target_size')
    assert (size['min'], size['max'], size['presets'], size['default']) == (1, 500, {'discord': 10}, None)
    gif = next(t for t in kinds['video']['targets'] if t['target'] == 'gif')
    assert {o['name']: o['default'] for o in gif['options'] if o['name'] in ('fps', 'width')} == {'fps': 12,
                                                                                                   'width': 480}
    assert kinds['document']['targets'][0]['anonymous'] is False
    assert kinds['document']['targets'][0]['options'] == []
    assert all(t['anonymous'] for t in kinds['video']['targets'])
    types = {o['type'] for k in kinds.values() for t in k['targets'] for o in t['options']}
    assert types == {'int', 'number', 'bool', 'enum', 'color', 'pages', 'size'}
    assert [p['id'] for p in body['presets']] == ['play_everywhere', 'discord', 'extract_audio', 'gif_to_mp4',
                                                  'remove_location']
    assert body['presets'][4]['target'] == 'same'


def test_the_tier_height_cap_is_part_of_a_video_recipe():
    """§7.1: anonymous video output is capped at 720p. The cap is in the recipe, so the cache never serves a capped
    output to a caller who'd get it uncapped (or the other way round); kinds the cap doesn't touch share entries."""
    options = formats.normalise('video', 'mp4', {})
    assert formats.recipe_hash('video', 'mp4', options, 720) != formats.recipe_hash('video', 'mp4', options, None)
    assert formats.recipe_hash('video', 'mp4', options, 720) == formats.recipe_hash('video', 'mp4', options, 720)
    assert formats.recipe('video', 'mp4', options, 720)['cap'] == {'max_height': 720}
    image = formats.normalise('image', 'png', {})
    assert formats.recipe_hash('image', 'png', image, 720) == formats.recipe_hash('image', 'png', image, None)
    assert 'cap' not in formats.recipe('image', 'png', image, 720)
