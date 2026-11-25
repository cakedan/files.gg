"""No executables (utils/filetypes.py): refused by name, by declared type and by content,
on single and chunked uploads."""

import struct
import types

import pytest

from tests.test_milestone2 import appdb, new_user, put, seeded, small_chunks, start  # noqa: F401  (fixtures)
from utils import filetypes


def pe(size=4096):
    """A minimal Windows PE header: "MZ", the PE offset at 0x3C, then "PE\\0\\0"."""
    head = bytearray(b'MZ' + b'\x90' * (0x3C - 2) + struct.pack('<I', 0x80))
    head += b'\x00' * (0x80 - len(head)) + b'PE\x00\x00' + b'\x4c\x01'
    return bytes(head + b'\xcc' * (size - len(head)))


ELF = b'\x7fELF\x02\x01\x01' + b'\x00' * 2041
MACH_O = b'\xcf\xfa\xed\xfe' + b'\x07\x00\x00\x01' + b'\x00' * 2040
JAVA_CLASS = b'\xca\xfe\xba\xbe\x00\x00\x00\x41' + b'\x00' * 100
LNK = bytes.fromhex('4c0000000114020000000000c000000000000046') + b'\x00' * 60


def send(client, headers, content, name, mimetype, status):
    response = client.post('/files', headers=headers, files={'file': (name, content, mimetype)})
    assert response.status_code == status, response.text
    return response.json()


# --- the sniffer and the lists -----------------------------------------------------------------------

@pytest.mark.parametrize('content, kind', [
    (pe(), 'windows-pe'),
    (ELF, 'elf'),
    (MACH_O, 'mach-o'),
    (JAVA_CLASS, 'mach-o-universal-or-java-class'),
    (LNK, 'windows-shortcut'),
])
def test_sniffs_executables(content, kind):
    assert filetypes.sniff_executable(content) == kind
    assert filetypes.sniff_executable(bytearray(content)) == kind


@pytest.mark.parametrize('content', [
    b'MZ was here, and this is just a text file that happens to start with MZ.\n' * 3,
    b'MZ' + b'\x00' * 0x3A + struct.pack('<I', 0x80) + b'\x00' * 0x40 + b'NOPE',  # MZ, no PE header
    b'MZ' + b'\x00' * 0x3A + struct.pack('<I', 0xFFFFFFF0),  # offset far past the data
    b'MZ',
    b'\x89PNG\r\n\x1a\n' + b'\x00' * 64,
    b'',
])
def test_leaves_other_files_alone(content):
    assert filetypes.sniff_executable(content) is None


def test_blocked_names_and_types():
    for name in ('setup.exe', 'SETUP.EXE', 'tool.dll', 'run.bat', 'x.ps1', 'app.apk', 'a.jar', 'disk.iso',
                 'macro.docm', 'link.lnk', 'installer.msi', 'thing.scr', 'page.hta'):
        assert filetypes.blocked_name(name), name
    for name in ('photo.png', 'notes.txt', 'app.js', 'script.py', 'archive.zip', 'README', 'report.pdf'):
        assert not filetypes.blocked_name(name), name
    assert filetypes.blocked_name('anything', 'exe')  # an explicit extension
    assert filetypes.blocked_mimetype('application/x-msdownload')
    assert filetypes.blocked_mimetype('Application/X-MSDownload; charset=binary')
    assert not filetypes.blocked_mimetype('application/octet-stream')


def test_the_seed_contains_nothing_blocked(seeded):
    extensions = {row[0] for row in seeded.fetchall('SELECT extension FROM mimetype_extensions')}
    mimetypes = {row[0] for row in seeded.fetchall('SELECT id FROM mimetypes')}
    assert not extensions & filetypes.BLOCKED_EXTENSIONS
    assert not mimetypes & filetypes.BLOCKED_MIMETYPES


# --- single uploads (POST /files) ----------------------------------------------------------------------

@pytest.mark.parametrize('content, name, mimetype', [
    (b'harmless bytes', 'setup.exe', 'application/octet-stream'),   # the name alone
    (b'harmless bytes', 'SETUP.EXE', 'application/octet-stream'),
    (b'harmless bytes', 'photo.png', 'application/x-msdownload'),   # the declared type alone
    (pe(), 'photo.png', 'image/png'),                                # the content alone
    (pe(), 'tool.bin', 'application/octet-stream'),
    (ELF, 'notes.txt', 'text/plain'),
    (MACH_O, 'data.bin', 'application/octet-stream'),
    (JAVA_CLASS, 'x.bin', 'application/octet-stream'),
])
def test_single_upload_refuses_executables(client, seeded, content, name, mimetype):
    user_id, headers = new_user(seeded)
    body = send(client, headers, content, name, mimetype, 400)
    assert body['code'] == 'FILE_TYPE_NOT_ALLOWED'
    assert body['message'] == "This type of file can't be uploaded"
    assert seeded.fetchone('SELECT count(*) FROM files WHERE user_id = %s', (user_id,)) == (0,)


def test_single_upload_still_takes_ordinary_files(client, seeded):
    _, headers = new_user(seeded)
    created = send(client, headers, b'MZ was here.\n' * 10, 'mz.txt', 'text/plain', 200)
    assert created['filename'] == 'mz.txt'
    created = send(client, headers, b'console.log(1)\n', 'app.js', 'text/javascript', 200)
    assert created['extension'] == 'js'


# --- chunked uploads (POST /uploads) --------------------------------------------------------------------

def test_chunked_upload_refuses_a_blocked_name_up_front(client, seeded):
    _, headers = new_user(seeded)
    body = start(client, headers, 1024, status=400, filename='setup.exe')
    assert body['code'] == 'FILE_TYPE_NOT_ALLOWED'
    body = start(client, headers, 1024, status=400, filename='x.bin', mimetype='application/x-msdownload')
    assert body['code'] == 'FILE_TYPE_NOT_ALLOWED'


def test_chunked_upload_fails_at_the_first_chunk(client, seeded, small_chunks):
    _, headers = new_user(seeded)
    data = pe(small_chunks + 100)
    session = start(client, headers, len(data), filename='tool.bin')
    upload_id = session['upload_id']
    response = put(client, headers, upload_id, 0, data[:small_chunks])
    assert (response.status_code, response.json()['code']) == (400, 'FILE_TYPE_NOT_ALLOWED')
    state = client.get('/uploads/' + upload_id, headers=headers).json()
    assert (state['status'], state.get('error')) == ('failed', 'FILE_TYPE_NOT_ALLOWED')
    # the session is dead: no more chunks
    assert put(client, headers, upload_id, 1, data[small_chunks:]).status_code == 404


def test_finalize_refuses_executables_too(client, seeded, small_chunks, monkeypatch):
    """Even if the first-chunk check were skipped (an older server, a bug), finalize sniffs
    the assembled file before any File row exists."""
    import views.uploads
    from jobs.finalize import finalize
    monkeypatch.setattr(views.uploads, 'filetypes', types.SimpleNamespace(sniff_executable=lambda data: None))
    user_id, headers = new_user(seeded)
    data = ELF + b'\x00' * 1000
    session = start(client, headers, len(data), filename='data.bin')
    upload_id = session['upload_id']
    assert put(client, headers, upload_id, 0, data).status_code == 204
    assert client.post('/uploads/{}/complete'.format(upload_id), headers=headers).status_code == 202
    assert finalize(int(upload_id)) is None
    state = client.get('/uploads/' + upload_id, headers=headers).json()
    assert (state['status'], state.get('error')) == ('failed', 'FILE_TYPE_NOT_ALLOWED')
    assert seeded.fetchone('SELECT count(*) FROM files WHERE user_id = %s', (user_id,)) == (0,)
