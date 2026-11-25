"""The office service (contract milestone-5 §3.2, §9, §15 "Office"): LibreOffice in its own container with no
network (docker-compose.test.yml's `office`, the real image and settings), fed through the shared spool; and the
daemon's own rules (api/office/daemon.py, standard library only, so it's imported here too)."""

import importlib.util
import os
import subprocess
import time
import xml.etree.ElementTree as ElementTree

import pytest

from media import office
from tests import m5convert
from tests.m5convert import fixture, pdf_pages

DAEMON_PATH = os.path.join(m5convert.API_DIR, 'office', 'daemon.py')


def load_daemon():
    spec = importlib.util.spec_from_file_location('office_daemon', DAEMON_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pdf_text(path):
    return subprocess.run(['pdftotext', path, '-'], check=True, capture_output=True).stdout.decode()


# --- the container ------------------------------------------------------------------------------------------------------

def test_office_container_has_no_network():
    """Written by the office container before its daemon started (docker-compose.test.yml): the only interface that
    is up is the loopback (the kernel's fallback tunnel devices exist in every network namespace, down), there's no
    route anywhere, and connecting out fails."""
    with open(os.path.join(office.SPOOL_DIR, 'network.txt')) as handle:
        lines = dict(line.split('=', 1) for line in handle.read().split())
    assert lines['up'] == 'lo'
    assert lines['routes'] == '0'
    assert lines['connect'] != 'ok'


@pytest.mark.parametrize('name,extension,pages,text', [
    ('document.docx', 'docx', 1, 'files.gg converter test document'),
    ('slides.pptx', 'pptx', 3, 'Slide 2'),
    # WEBSERVICE() never fetches: Calc shows Err:540, "external content disabled" (and there's no network anyway)
    ('webservice.xlsx', 'xlsx', 1, 'Err:540'),
    # the linked picture can't be fetched; the document still converts
    ('remote-image.docx', 'docx', 1, 'A remote image follows.'),
])
def test_documents_convert(tmp_path, name, extension, pages, text):
    out = str(tmp_path / 'out.pdf')
    assert office.convert(fixture(name), extension, out) == pages
    assert pdf_pages(out) == pages
    assert text in pdf_text(out)
    # the converter always deletes its spool directories
    for directory in ('new', 'queue', 'work', 'done'):
        assert [n for n in os.listdir(os.path.join(office.SPOOL_DIR, directory)) if len(n) == 32] == []


def test_too_many_pages(tmp_path):
    with pytest.raises(office.OfficeError) as error:
        office.convert(fixture('slides.pptx'), 'pptx', str(tmp_path / 'out.pdf'), max_pages=2)
    assert error.value.reason == 'too_many_pages'
    assert not (tmp_path / 'out.pdf').exists()


def long_document(path, paragraphs=40000):
    """A docx LibreOffice needs well over a second to lay out."""
    from tests.fixtures.convert import make_fixtures
    body = ''.join('<w:p><w:r><w:t>Paragraph {} of a long document.</w:t></w:r></w:p>'.format(n)
                   for n in range(paragraphs))
    make_fixtures.write_zip(str(path), [
        ('[Content_Types].xml', make_fixtures.content_types([('/word/document.xml', make_fixtures.DOCX_TYPE)])),
        ('_rels/.rels', make_fixtures.ROOT_RELS.format('word/document.xml')),
        ('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{}">'
                              '<w:body>{}</w:body></w:document>'.format(make_fixtures.W, body)),
    ])
    return str(path)


def test_timeout_kills_soffice_and_the_daemon_goes_on(tmp_path):
    """A 1 s limit on a long document: its process group is killed; the next job still converts."""
    with pytest.raises(office.OfficeError) as error:
        office.convert(long_document(tmp_path / 'long.docx'), 'docx', str(tmp_path / 'slow.pdf'), timeout=1)
    assert error.value.reason == 'timeout'
    assert office.convert(fixture('document.docx'), 'docx', str(tmp_path / 'next.pdf')) == 1


def test_unreadable_document(tmp_path):
    broken = tmp_path / 'broken.docx'
    broken.write_bytes(b'PK\x03\x04 not a document at all')
    with pytest.raises(office.OfficeError) as error:
        office.convert(str(broken), 'docx', str(tmp_path / 'out.pdf'))
    assert error.value.reason == 'failed'


def test_no_daemon(tmp_path, monkeypatch):
    """Nobody takes the job: `unavailable` after timeout + 15 s (shortened here), and the job is gone."""
    spool = tmp_path / 'spool'
    for name in ('new', 'queue', 'work', 'done'):
        (spool / name).mkdir(parents=True)
    monkeypatch.setattr(office, 'GRACE', 0)
    with pytest.raises(office.OfficeError) as error:
        office.convert(fixture('document.docx'), 'docx', str(tmp_path / 'out.pdf'), timeout=1, spool=str(spool))
    assert error.value.reason == 'unavailable'
    assert os.listdir(spool / 'queue') == []


# --- the daemon's rules ---------------------------------------------------------------------------------------------------

def test_settings_are_valid_xml():
    root = ElementTree.parse(os.path.join(m5convert.API_DIR, 'office', 'registrymodifications.xcu')).getroot()
    paths = {(item.get('{http://openoffice.org/2001/registry}path'),
              item.find('prop').get('{http://openoffice.org/2001/registry}name')) for item in root}
    assert ('/org.openoffice.Office.Common/Security/Scripting', 'DisableMacrosExecution') in paths
    assert ('/org.openoffice.Office.Calc/Formula/Load', 'OOXMLRecalcMode') in paths
    assert ('/org.openoffice.Office.Writer/Content/Update', 'Link') in paths


FAKE_SOFFICE = '''#!/bin/sh
# a stand-in for soffice that starts a helper and never finishes, as a stuck LibreOffice would
sh -c 'sleep 300; true' "$0" &
sleep 300
'''


def test_daemon_timeout_kills_the_whole_group(tmp_path, monkeypatch):
    from tests.test_converter import processes_with
    daemon = load_daemon()
    fake = tmp_path / 'fake-soffice'
    fake.write_text(FAKE_SOFFICE)
    fake.chmod(0o755)
    monkeypatch.setattr(daemon, 'SOFFICE', str(fake))
    started = time.monotonic()
    profile = tmp_path / 'profile'
    assert daemon.soffice(str(tmp_path / 'input.docx'), str(tmp_path), str(profile), 1) == 'timeout'
    assert time.monotonic() - started < 10
    deadline = time.monotonic() + 5
    while processes_with(str(fake)) and time.monotonic() < deadline:
        time.sleep(0.1)
    assert processes_with(str(fake)) == []


def test_daemon_refuses_bad_requests(tmp_path):
    daemon = load_daemon()
    job = tmp_path / 'job'
    job.mkdir()
    assert daemon.convert(str(job)) == {'ok': False, 'reason': 'failed'}
    (job / 'request.json').write_text('{"filter": "pdf", "timeout": 10, "max_pages": 5}')
    (job / 'input.exe').write_bytes(b'MZ')
    assert daemon.read_request(str(job)) is None
    os.unlink(job / 'input.exe')
    (job / 'input.docx').write_bytes(b'PK')
    assert daemon.read_request(str(job))[1:] == ('docx', 10, 5)
    (job / 'request.json').write_text('{"filter": "html", "timeout": 10, "max_pages": 5}')
    assert daemon.read_request(str(job)) is None
    (job / 'request.json').write_text('{"filter": "pdf", "timeout": 100000, "max_pages": 5}')
    assert daemon.read_request(str(job))[2] == daemon.MAX_TIMEOUT


def test_spool_cleanup(tmp_path):
    daemon = load_daemon()
    spool = str(tmp_path)
    daemon.ensure_spool(spool)
    old = tmp_path / 'done' / ('a' * 32)
    old.mkdir()
    (old / 'output.pdf').write_bytes(b'%PDF')
    fresh = tmp_path / 'queue' / ('b' * 32)
    fresh.mkdir()
    stale_file = tmp_path / 'work' / 'stray'
    stale_file.write_bytes(b'x')
    past = time.time() - 11 * 60
    os.utime(old, (past, past))
    os.utime(stale_file, (past, past))
    assert daemon.clean(spool) == 2
    assert not old.exists() and not stale_file.exists() and fresh.exists()


def test_page_count():
    daemon = load_daemon()
    assert daemon.count_pages(fixture('three-pages.pdf')) == 3


def test_claim_takes_each_job_once(tmp_path):
    daemon = load_daemon()
    spool = str(tmp_path)
    daemon.ensure_spool(spool)
    (tmp_path / 'queue' / ('c' * 32)).mkdir()
    (tmp_path / 'queue' / 'not-a-job').mkdir()
    first = daemon.claim(spool)
    assert first == os.path.join(spool, 'work', 'c' * 32)
    assert daemon.claim(spool) is None


# --- through the converter: document -> pdf and previews (§3.2, §9.1) ------------------------------------------------

@pytest.fixture(scope='module')
def appdb():
    from tests.conftest import APP_DATABASE, TempDatabase
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def test_document_conversion(client, appdb):
    from jobs import convert as convert_jobs
    from tests.m3 import new_user
    user_id, headers = new_user(appdb)
    file_id, hash_id = m5convert.upload(client, headers, 'webservice.xlsx')
    conversion_id = m5convert.insert_conversion(appdb, 'document', 'pdf', {}, file_id=file_id, hash_id=hash_id,
                                                user_id=user_id, name='webservice')
    convert_jobs.run(conversion_id)
    row = m5convert.conversion(appdb, conversion_id)
    assert row['status'] == 'succeeded', row['error']
    assert m5convert.output_bytes(appdb, conversion_id).startswith(b'%PDF')


def test_document_preview(client, appdb):
    from jobs import convert as convert_jobs
    from tests.conftest import s3_object
    from tests.m3 import new_user
    user_id, headers = new_user(appdb)
    _, hash_id = m5convert.upload(client, headers, 'slides.pptx')
    appdb.execute("UPDATE file_hashes SET preview_state = 'queued' WHERE id = %s", (hash_id,))
    assert convert_jobs.preview(hash_id) == 'done'
    assert appdb.fetchone('SELECT preview_state FROM file_hashes WHERE id = %s', (hash_id,))[0] == 'done'
    assets = {row[0]: row[1:] for row in appdb.fetchall(
        'SELECT kind, storage_key, content_type, pages FROM file_hash_assets WHERE hash_id = %s', (hash_id,))}
    assert assets['document'][1:] == ('application/pdf', 3)
    assert s3_object(assets['document'][0]).startswith(b'%PDF')
    assert {'thumb', 'thumb-2x'} <= set(assets)
    # a second run finds nothing to do
    assert convert_jobs.preview(hash_id) is None


def test_preview_skips_encrypted_and_large(client, appdb, monkeypatch):
    import zipfile
    from jobs import convert as convert_jobs
    from tests.m3 import new_user, send
    from tests.conftest import hash_of
    user_id, headers = new_user(appdb)
    path = os.path.join('/tmp', 'encrypted-{}.odt'.format(user_id))
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
        archive.writestr('META-INF/manifest.xml', '<manifest:encryption-data/>')
    with open(path, 'rb') as handle:
        created = send(client, headers, handle.read(), 'secret.odt', 'application/vnd.oasis.opendocument.text')
    hash_id = int(hash_of(appdb, created))
    appdb.execute("UPDATE file_hashes SET preview_state = 'queued' WHERE id = %s", (hash_id,))
    assert convert_jobs.preview(hash_id) == 'skipped'
    _, big = m5convert.upload(client, headers, 'document.docx')
    appdb.execute("UPDATE file_hashes SET preview_state = 'queued' WHERE id = %s", (big,))
    monkeypatch.setattr(convert_jobs, 'PREVIEW_MAX_INPUT', 10)
    assert convert_jobs.preview(big) == 'skipped'
