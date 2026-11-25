"""Regenerates the stand-in matcher's fixtures (contract milestone-4 §3.3). Benign, generated
images only; never real material.

    python -m tests.fixtures.standin.make_fixtures            (in the worker or test image)
    python -m tests.fixtures.standin.make_fixtures --images-only

- match.png: 512x512, "FILESGG STANDIN MATCH" on a magenta and black checkerboard;
- match-small.jpg: match.png scaled to 50%, as a JPEG (matches through PDQ, not blake2b);
- clean.png: plain grey (never matches);
- match-list.txt: `blake2b:<match.png>` and `pdq:<match.png's PDQ>` (needs pdqhash, which
  only the Linux worker and test images have).
"""

import hashlib
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 512
CELL = 64
MAGENTA = (255, 0, 255)
BLACK = (0, 0, 0)
GREY = (128, 128, 128)
TEXT = ('FILESGG', 'STANDIN', 'MATCH')


def match_image():
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new('RGB', (SIZE, SIZE), BLACK)
    draw = ImageDraw.Draw(image)
    for y in range(0, SIZE, CELL):
        for x in range(0, SIZE, CELL):
            if (x // CELL + y // CELL) % 2 == 0:
                draw.rectangle([x, y, x + CELL - 1, y + CELL - 1], fill=MAGENTA)
    font = ImageFont.load_default(size=56)
    for index, line in enumerate(TEXT):
        left, top, right, bottom = draw.textbbox((0, 0), line, font=font)
        x = (SIZE - (right - left)) // 2 - left
        y = 110 + index * 110 - top
        draw.rectangle([x - 12, y + top - 10, x + (right - left) + 12, y + bottom + 10], fill=(255, 255, 255))
        draw.text((x, y), line, font=font, fill=BLACK)
    return image


def encode(image, fmt, **options):
    out = io.BytesIO()
    image.save(out, fmt, **options)
    return out.getvalue()


def images():
    """{filename: bytes} of the three fixtures."""
    from PIL import Image
    match = match_image()
    small = match.resize((SIZE // 2, SIZE // 2), Image.Resampling.LANCZOS)
    return {
        'match.png': encode(match, 'PNG', optimize=False),
        'match-small.jpg': encode(small, 'JPEG', quality=90),
        'clean.png': encode(Image.new('RGB', (SIZE, SIZE), GREY), 'PNG', optimize=False),
    }


def pdq_of(data):
    import numpy as np
    import pdqhash
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        array = np.ascontiguousarray(np.asarray(image.convert('RGB'), dtype=np.uint8))
    vector, quality = pdqhash.compute(array)
    bits = ''.join('1' if bit else '0' for bit in vector)
    return '{:064x}'.format(int(bits, 2)), int(quality)


def write(images_only=False):
    written = images()
    for name, data in written.items():
        with open(os.path.join(HERE, name), 'wb') as handle:
            handle.write(data)
    if images_only:
        return written
    blake2b = hashlib.blake2b(written['match.png']).hexdigest()
    pdq, quality = pdq_of(written['match.png'])
    with open(os.path.join(HERE, 'match-list.txt'), 'w') as handle:
        handle.write('# The stand-in matcher\'s list (contract milestone-4 §3.3), made by make_fixtures.py from\n'
                     '# generated images only. match.png matches by blake2b; match-small.jpg (match.png at 50%)\n'
                     '# matches through PDQ (match.png\'s PDQ, quality {}).\n'.format(quality))
        handle.write('blake2b:{}\n'.format(blake2b))
        handle.write('pdq:{}\n'.format(pdq))
    return written


if __name__ == '__main__':
    write(images_only='--images-only' in sys.argv[1:])
