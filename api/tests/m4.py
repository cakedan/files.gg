"""Helpers for the Milestone 4 tests: uploads, running scans the way the scanner does, staff,
generated fixtures (archives, Office files, PDFs, polyglots) and the stand-in images.

Nothing here is real abuse material or live malware: the stand-in images are generated
(tests/fixtures/standin/make_fixtures.py), and EICAR is the standard antivirus test string,
written at runtime."""

import io
import json
import os
import struct
import uuid
import zipfile
import zlib

import pytest

from tests.conftest import APP_DATABASE, TempDatabase, hash_of, turnstile_token
from tests.test_milestone2 import ORIGIN, anonymous, new_user  # noqa: F401  (re-exported)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'standin')
REPORT_TOKEN = turnstile_token('report')
UPLOAD_TOKEN = turnstile_token('upload')
# the standard antivirus test file (eicar.org), assembled at runtime so no file in the repo carries it
EICAR = ('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*').encode('ascii')
# matches PUA.Test.FilesggPUA-1 in tests/fixtures/clamav/db (a test-only signature)
PUA_STRING = b'FILESGG-TEST-PUA-SIGNATURE-7f3a9c'


@pytest.fixture(scope='module')
def appdb():
    temp = TempDatabase(APP_DATABASE)
    yield temp
    temp.close()


def fixture_bytes(name):
    with open(os.path.join(FIXTURES, name), 'rb') as handle:
        return handle.read()


# --- uploads and reads -------------------------------------------------------------------------------------

def send(client, headers, content, name, mimetype='application/octet-stream', status=200, anonymous_upload=False,
         ip=None, **fields):
    data = {k: (json.dumps(v) if isinstance(v, bool) else str(v)) for k, v in fields.items()}
    if anonymous_upload:
        data.setdefault('turnstile_token', UPLOAD_TOKEN)
    headers = dict(headers)
    # a network of its own per upload unless given: a CSAM match bans its uploaders' IP hashes (§3.6)
    headers.setdefault('X-Forwarded-For', ip or '10.{}.{}.{}'.format(*uuid.uuid4().bytes[:3]))
    response = client.post('/files', headers=headers, files={'file': (name, content, mimetype)}, data=data)
    assert response.status_code == status, response.text
    return response.json()


def hash_id_of(db, created):
    return int(hash_of(db, created))


def lookup(client, created):
    return client.get('/internal/files/' + created['vanity'], headers=ORIGIN)


def owner_file(client, headers, created):
    return client.get('/users/@me/files/' + created['id'], headers=headers)


def hash_row(db, hash_id):
    row = db.fetchone('SELECT scan_state, scan_reason, scan, nsfw_score, nsfw_auto, serve_inline FROM file_hashes '
                      'WHERE id = %s', (hash_id,))
    return dict(zip(('scan_state', 'scan_reason', 'scan', 'nsfw_score', 'nsfw_auto', 'serve_inline'), row))


def run_scan(db, created, **patches):
    """The `scan` job for a file's hash, as the scanner runs it. Returns the hash row."""
    from safety import scan
    hash_id = hash_id_of(db, created)
    scan.scan(hash_id)
    return hash_row(db, hash_id)


@pytest.fixture
def nsfw_score(monkeypatch):
    """The classifier mocked (§14.5): every scan reports this NSFW score for its images."""
    from safety import scan as scan_module
    original = scan_module.run_child
    state = {'score': None}

    def run_child(path, outdir, hints, settings):
        return original(path, outdir, dict(hints, nsfw=False), settings)

    def classify_nsfw(child, outdir):
        if state['score'] is None or not child.get('images'):
            return None
        return {'score': state['score'], 'classified': len(child['images']), 'model': 'mock@00000000'}
    monkeypatch.setattr(scan_module, 'run_child', run_child)
    monkeypatch.setattr(scan_module, 'classify_nsfw', classify_nsfw)

    def set_score(value):
        state['score'] = value
    return set_score


# --- staff ----------------------------------------------------------------------------------------------------

def make_staff(db, role='moderator', child_safety=False):
    user_id, headers = new_user(db)
    from tools import staff
    staff.grant(db.conn, user_id, role, child_safety, 'tests')
    return user_id, headers


def user_headers(user_id):
    from tests.conftest import sign_in
    return sign_in(user_id)


# --- images -----------------------------------------------------------------------------------------------------

def png(width=320, height=240, seed=None):
    from PIL import Image, ImageDraw
    seed = seed or uuid.uuid4().bytes
    image = Image.new('RGB', (width, height), tuple(seed[:3]))
    draw = ImageDraw.Draw(image)
    for i in range(8):
        draw.rectangle([i * width // 10, seed[i] % height, i * width // 10 + width // 12, height - 1],
                       fill=tuple(seed[3 + i:6 + i]))
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def pattern(width=400, height=300):
    """A smooth random picture (a random colour grid, upscaled): high PDQ quality, and robust to
    re-encoding, for the near-match tests."""
    import numpy as np
    from PIL import Image
    grid = np.random.default_rng(uuid.uuid4().int % (2 ** 32)).integers(0, 255, (6, 8, 3), dtype=np.uint8)
    image = Image.fromarray(grid).resize((width, height), Image.Resampling.BICUBIC)
    out = io.BytesIO()
    image.save(out, 'PNG')
    return out.getvalue()


def broken_png():
    """PNG signature and a header, then garbage: neither Pillow nor ffmpeg can decode it."""
    return b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\rIHDR' + uuid.uuid4().bytes * 20


# --- archives -----------------------------------------------------------------------------------------------

def zip_of(entries, compression=zipfile.ZIP_DEFLATED):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return out.getvalue()


def nonce():
    return uuid.uuid4().hex.encode()


ELF = b'\x7fELF\x02\x01\x01\x00' + b'\x00' * 8 + b'\x02\x00\x3e\x00\x01\x00\x00\x00' + b'\x00' * 40


def zipcrypto(entries):
    """A zip whose entries use traditional PKWARE encryption (ZipCrypto), written by hand
    (zipfile can't encrypt): the header's flag bit 0 is what scanners look at."""
    def crc_update(crc, byte):
        return zlib.crc32(bytes([byte]), crc ^ 0xffffffff) ^ 0xffffffff

    def encrypt(data, password=b'pw'):
        keys = [0x12345678, 0x23456789, 0x34567890]

        def update(byte):
            keys[0] = crc_update(keys[0], byte)
            keys[1] = (keys[1] + (keys[0] & 0xff)) & 0xffffffff
            keys[1] = (keys[1] * 134775813 + 1) & 0xffffffff
            keys[2] = crc_update(keys[2], keys[1] >> 24)
        for byte in password:
            update(byte)
        out = bytearray()
        for byte in data:
            temp = (keys[2] | 2) & 0xffff
            out.append(byte ^ (((temp * (temp ^ 1)) >> 8) & 0xff))
            update(byte)
        return bytes(out)
    out = io.BytesIO()
    central = []
    for name, data in entries:
        crc = zlib.crc32(data)
        header = os.urandom(11) + bytes([(crc >> 24) & 0xff])
        body = encrypt(header + data)
        offset = out.tell()
        name_bytes = name.encode()
        out.write(struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 1, 0, 0, 0, crc, len(body), len(data),
                              len(name_bytes), 0) + name_bytes + body)
        central.append(struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 1, 0, 0, 0, crc, len(body), len(data),
                                   len(name_bytes), 0, 0, 0, 0, 0, offset) + name_bytes)
    start = out.tell()
    for record in central:
        out.write(record)
    size = out.tell() - start
    out.write(struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(central), len(central), size, start, 0))
    return out.getvalue()


def zip_aes(entries):
    """A WinZip AES zip (method 99 with the AE-x extra field, flag bit 0 set); the payload is
    random bytes, since only the headers matter to the checks."""
    out = io.BytesIO()
    central = []
    for name, data in entries:
        body = os.urandom(len(data) + 28)
        extra = struct.pack('<HHH2sBH', 0x9901, 7, 2, b'AE', 3, 8)
        offset = out.tell()
        name_bytes = name.encode()
        out.write(struct.pack('<IHHHHHIIIHH', 0x04034b50, 51, 1, 99, 0, 0, 0, len(body), len(data), len(name_bytes),
                              len(extra)) + name_bytes + extra + body)
        central.append(struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 51, 51, 1, 99, 0, 0, 0, len(body), len(data),
                                   len(name_bytes), len(extra), 0, 0, 0, 0, offset) + name_bytes + extra)
    start = out.tell()
    for record in central:
        out.write(record)
    size = out.tell() - start
    out.write(struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(central), len(central), size, start, 0))
    return out.getvalue()


def zip_declaring(total_bytes, entries=8):
    """A small zip whose headers declare `total_bytes` unpacked (§14.5's ratio bomb): each entry
    is stored, and its declared uncompressed size is patched in both headers."""
    data = zip_of([('part{}.bin'.format(i), b'x' * 16) for i in range(entries)], zipfile.ZIP_STORED)
    each = total_bytes // entries
    assert each < 0xFFFFFFFF
    buffer = bytearray(data)
    pos = 0
    while True:
        pos = buffer.find(b'PK\x03\x04', pos)
        if pos < 0:
            break
        struct.pack_into('<I', buffer, pos + 22, each)
        pos += 4
    pos = 0
    while True:
        pos = buffer.find(b'PK\x01\x02', pos)
        if pos < 0:
            break
        struct.pack_into('<I', buffer, pos + 24, each)
        pos += 4
    return bytes(buffer)


def rar5_header_encrypted():
    """The start of a RAR5 archive with an archive encryption header (type 4) right after the
    signature: what header encryption looks like to a lister."""
    body = bytes([4]) + bytes([0]) + bytes([0]) + bytes([0]) + os.urandom(16) + os.urandom(12)
    size = bytes([len(body)])
    crc = struct.pack('<I', zlib.crc32(size + body))
    return b'Rar!\x1a\x07\x01\x00' + crc + size + body + os.urandom(64)


# --- Office -------------------------------------------------------------------------------------------------

CONTENT_TYPES = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/'
                 'content-types"><Default Extension="xml" ContentType="application/xml"/>{}</Types>')


def docx(extra=(), rels=None):
    entries = [('[Content_Types].xml', CONTENT_TYPES.format('')),
               ('word/document.xml', '<w:document><w:body><w:p>{}</w:p></w:body></w:document>'.format(
                   uuid.uuid4().hex))]
    if rels is not None:
        entries.append(('word/_rels/settings.xml.rels', rels))
    return zip_of(entries + list(extra))


def docx_with_vba():
    return docx(extra=[('word/vbaProject.bin', b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + os.urandom(512))])


def docx_remote_template():
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/'
            '2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/attachedTemplate" Target="https://example.test/evil.dotm" TargetMode="External"/>'
            '</Relationships>')
    return docx(rels=rels)


def xlsx_with_xlm():
    entries = [('[Content_Types].xml', CONTENT_TYPES.format(
        '<Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/>')),
               ('xl/workbook.xml', '<workbook/>'),
               ('xl/macrosheets/sheet1.xml', '<xm:macrosheet>{}</xm:macrosheet>'.format(uuid.uuid4().hex))]
    return zip_of(entries)


# --- PDFs ----------------------------------------------------------------------------------------------------

def pdf(objects_extra='', catalog_extra='', text='Hello'):
    """A minimal one-page PDF with an optional extra in its catalog and extra objects."""
    marker = uuid.uuid4().hex
    stream = 'BT /F1 12 Tf 72 720 Td ({} {}) Tj ET'.format(text, marker)
    objects = [
        '<< /Type /Catalog /Pages 2 0 R {} >>'.format(catalog_extra),
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> '
        '>> >>',
        '<< /Length {} >>\nstream\n{}\nendstream'.format(len(stream), stream),
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ] + ([objects_extra] if objects_extra else [])
    out = io.BytesIO()
    out.write(b'%PDF-1.7\n')
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write('{} 0 obj\n{}\nendobj\n'.format(index, body).encode('latin-1'))
    xref = out.tell()
    out.write('xref\n0 {}\n0000000000 65535 f \n'.format(len(objects) + 1).encode())
    for offset in offsets:
        out.write('{:010d} 00000 n \n'.format(offset).encode())
    out.write('trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n'.format(len(objects) + 1, xref).encode())
    return out.getvalue()


def pdf_open_at_fit():
    """What LibreOffice exports: an /OpenAction that only opens the first page at "fit" (a destination, no action)."""
    return pdf(catalog_extra='/OpenAction [3 0 R /Fit]')


def pdf_javascript():
    return pdf(objects_extra="<< /S /JavaScript /JS (app.alert('x')) >>", catalog_extra='/OpenAction 6 0 R')


def pdf_launch():
    return pdf(objects_extra='<< /S /Launch /F (cmd.exe) >>', catalog_extra='/OpenAction 6 0 R')


def pdf_escaped_javascript_in_object_stream():
    """/J#61vaScript inside a compressed object stream: only qpdf's expansion (and the name
    normalisation) show it."""
    inner = "<< /S /J#61vaScript /J#53 (app.alert(1)) >>"
    header = '6 0 '
    data = (header + inner).encode('latin-1')
    compressed = zlib.compress(data)
    objstm = '<< /Type /ObjStm /N 1 /First {} /Filter /FlateDecode /Length {} >>\nstream\n'.format(
        len(header), len(compressed)).encode('latin-1') + compressed + b'\nendstream'
    # an object stream needs an xref stream: the file is built by hand around it
    return build_objstm_pdf(objstm)


def build_objstm_pdf(objstm):
    marker = uuid.uuid4().hex
    stream = 'BT /F1 12 Tf 72 720 Td (Hello {}) Tj ET'.format(marker)
    plain = [
        b'<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
        '<< /Length {} >>\nstream\n{}\nendstream'.format(len(stream), stream).encode('latin-1'),
    ]
    out = io.BytesIO()
    out.write(b'%PDF-1.7\n')
    offsets = {}
    for index, body in enumerate(plain, start=1):
        offsets[index] = out.tell()
        out.write('{} 0 obj\n'.format(index).encode() + body + b'\nendobj\n')
    offsets[5] = out.tell()
    out.write(b'5 0 obj\n' + objstm + b'\nendobj\n')
    xref_offset = out.tell()
    rows = [b'\x00\x00\x00\x00\xff\xff']
    for number in range(1, 6):
        rows.append(b'\x01' + struct.pack('>I', offsets[number]) + b'\x00')
    rows.append(b'\x02' + struct.pack('>I', 5) + b'\x00')  # object 6: in object stream 5, index 0
    rows.append(b'\x01' + struct.pack('>I', xref_offset) + b'\x00')  # object 7: this xref stream
    data = b''.join(rows)
    out.write('7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 1] /Root 1 0 R /Length {} >>\nstream\n'.format(
        len(data)).encode() + data + b'\nendstream\nendobj\n')
    out.write('startxref\n{}\n%%EOF\n'.format(xref_offset).encode())
    return out.getvalue()


def pdf_embedded_exe():
    exe = b'MZ' + b'\x90' * 58 + struct.pack('<I', 0x80) + b'\x00' * 64 + b'PE\x00\x00' + os.urandom(64)
    embedded = '<< /Type /EmbeddedFile /Length {} >>\nstream\n'.format(len(exe))
    objects_extra = embedded + exe.decode('latin-1') + '\nendstream'
    names = '/Names << /EmbeddedFiles << /Names [(setup.exe) << /Type /Filespec /F (setup.exe) /UF (setup.exe) ' \
            '/EF << /F 6 0 R >> >>] >> >>'
    return pdf(objects_extra=objects_extra, catalog_extra=names)


def gif_html():
    """A GIF that is also an HTML document (the polyglot the CDN's headers neutralise)."""
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', (4, 4), tuple(uuid.uuid4().bytes[:3])).save(out, 'GIF')
    return out.getvalue() + b'<html><script>alert(1)</script></html>'
