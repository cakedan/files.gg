#!/usr/bin/env node
/**
 * Generates the viewer's dev fixtures into web/fixtures/ (served at /fixtures/ by
 * the dev server only, so none of this ships in production builds):
 *
 *   sample.pdf            8 pages, selectable Helvetica text, an outline, an internal
 *                         link and one external link (https://example.com/...)
 *   sample-protected.pdf  the same document, RC4-128 encrypted, user password "files.gg"
 *   pdf-thumb.png         a first-page-style thumbnail for album tiles
 *   photo-*.png           placeholder images at assorted aspect ratios
 *   video-poster.png      a poster frame for the (unplayable) video fixture
 *   cover-*.png           album covers for the tracklist fixture
 *   tone-*.wav            short, quiet sine tones (8 kHz, 8-bit mono)
 *   archive.zip           a tiny stored (uncompressed) zip
 *
 * Usage: node scripts/make-fixtures.mjs   (or npm run fixtures)
 * Everything is generated from code; nothing is downloaded.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
mkdirSync(OUT, { recursive: true });

const write = (name, data) => {
  writeFileSync(join(OUT, name), data);
  console.log(`${name.padEnd(24)} ${String(data.length).padStart(8)} bytes`);
};

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Diagonal two-colour gradient with a soft disc, quantised so it compresses well. */
function placeholder(width, height, from, to, disc = '#ffffff') {
  const [a, b, d] = [hex(from), hex(to), hex(disc)];
  const cx = width * 0.62;
  const cy = height * 0.42;
  const radius = Math.min(width, height) * 0.22;
  return png(width, height, (x, y) => {
    const t = Math.round(((x / width) * 0.6 + (y / height) * 0.4) * 24) / 24;
    const base = mix(a, b, t);
    const dist = Math.hypot(x - cx, y - cy);
    return dist < radius ? mix(base, d, 0.35) : base;
  });
}

write('photo-1.png', placeholder(800, 500, '#1b7945', '#3deb7e'));
write('photo-2.png', placeholder(400, 600, '#2b2d31', '#5865f2', '#faa61a'));
write('photo-3.png', placeholder(600, 600, '#f04747', '#faa61a'));
write('photo-4.png', placeholder(1000, 350, '#16301f', '#25b874', '#f2f3f5'));
write('photo-5.png', placeholder(600, 400, '#313338', '#b5bac1', '#3deb7e'));
write('video-poster.png', placeholder(640, 360, '#0b1020', '#283a6b', '#f04747'));
write('cover-1.png', placeholder(400, 400, '#25b874', '#16301f', '#f2f3f5'));
write('cover-2.png', placeholder(400, 400, '#5865f2', '#1e1f22', '#faa61a'));

// A "first page" thumbnail: white page, grey text lines.
write(
  'pdf-thumb.png',
  png(240, 310, (x, y) => {
    const inText = x > 24 && x < 216 && y > 30 && (y - 30) % 14 < 5 && y < 290;
    const title = x > 24 && x < 150 && y > 14 && y < 24;
    if (title) return [40, 40, 40];
    if (inText && !(y > 200 && x > 150)) return [170, 170, 170];
    return [255, 255, 255];
  }),
);

// ---------------------------------------------------------------------------
// WAV: quiet sine tones with a short fade, 8 kHz unsigned 8-bit mono
// ---------------------------------------------------------------------------

function tone(freq, seconds, rate = 8000, amp = 0.12) {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n);
  const fade = rate * 0.05;
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - i) / fade);
    data[i] = Math.round(128 + 127 * amp * env * Math.sin((2 * Math.PI * freq * i) / rate));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + n, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // byte rate
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(n, 40);
  return Buffer.concat([header, data]);
}

write('tone-1.wav', tone(440, 4));
write('tone-2.wav', tone(523.25, 3));
write('tone-3.wav', tone(659.25, 5));

// ---------------------------------------------------------------------------
// ZIP (store mode, one file)
// ---------------------------------------------------------------------------

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

write('archive.zip', zip([['readme.txt', 'files.gg fixture archive.\n']]));

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const PAD = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const padPassword = (pw) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

/** Standard security handler, revision 3, 128-bit RC4 (PDF 1.4). */
function makeEncryption(userPassword, ownerPassword, fileId) {
  const n = 16;
  const P = -4; // all permissions
  // Algorithm 3: O entry.
  let ownerKey = md5(padPassword(ownerPassword));
  for (let i = 0; i < 50; i++) ownerKey = md5(ownerKey);
  ownerKey = ownerKey.subarray(0, n);
  let O = rc4(ownerKey, padPassword(userPassword));
  for (let i = 1; i <= 19; i++) O = rc4(Buffer.from(ownerKey.map((b) => b ^ i)), O);
  // Algorithm 2: encryption key.
  const p = Buffer.alloc(4);
  p.writeInt32LE(P);
  let key = md5(padPassword(userPassword), O, p, fileId);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  // Algorithm 5: U entry.
  let U = rc4(key, md5(PAD, fileId));
  for (let i = 1; i <= 19; i++) U = rc4(Buffer.from(key.map((b) => b ^ i)), U);
  U = Buffer.concat([U, Buffer.alloc(16)]);
  const objectKey = (num, gen) => {
    const suffix = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
    return md5(key, suffix).subarray(0, Math.min(n + 5, 16));
  };
  return { O, U, P, objectKey };
}

const escapePdf = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

const LOREM = [
  'files.gg renders PDFs itself with pdf.js, so they open in the page instead of downloading.',
  'This text is real text, not an image: select it, copy it, or search for it with Ctrl+F.',
  'Pages render lazily as they scroll into view, and far-off pages release their canvases.',
  'Zoom with the toolbar, Ctrl or Cmd plus the mouse wheel, or a pinch on a touch screen.',
  'The thumbnail sidebar and the outline both jump straight to a page.',
  'Rotate turns every page a quarter turn. Fullscreen fills the whole screen.',
];

function buildPdf({ password } = {}) {
  const fileId = md5(Buffer.from(`files.gg-fixture-${password ?? 'open'}`));
  const enc = password ? makeEncryption(password, `${password}-owner`, fileId) : null;
  const PAGES = 8;
  const objects = []; // index = object number - 1; each is (num) => Buffer

  const str = (num, text) => {
    if (!enc) return `(${escapePdf(text)})`;
    return `<${rc4(enc.objectKey(num, 0), Buffer.from(text, 'latin1')).toString('hex')}>`;
  };
  const stream = (num, dict, body) => {
    const data = enc ? rc4(enc.objectKey(num, 0), Buffer.from(body, 'latin1')) : Buffer.from(body, 'latin1');
    return Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  };

  // Object numbers.
  const CATALOG = 1;
  const PAGES_OBJ = 2;
  const FONT = 3;
  const FONT_BOLD = 4;
  const OUTLINES = 5;
  const firstPage = 6; // page i: 6 + 2i (page), 7 + 2i (content)
  const pageObj = (i) => firstPage + i * 2;
  const contentObj = (i) => firstPage + i * 2 + 1;
  const LINK_EXT = firstPage + PAGES * 2;
  const LINK_INT = LINK_EXT + 1;
  const OUTLINE_ITEMS = LINK_INT + 1; // 4 items: Intro, Details (with child), Child, Appendix
  const ENCRYPT = OUTLINE_ITEMS + 4;

  const sizes = Array.from({ length: PAGES }, (_, i) => (i === 5 ? [792, 612] : [612, 792]));

  objects[CATALOG - 1] = () =>
    `<< /Type /Catalog /Pages ${PAGES_OBJ} 0 R /Outlines ${OUTLINES} 0 R /PageMode /UseOutlines >>`;
  objects[PAGES_OBJ - 1] = () =>
    `<< /Type /Pages /Kids [${Array.from({ length: PAGES }, (_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${PAGES} >>`;
  objects[FONT - 1] = () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[FONT_BOLD - 1] = () => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  for (let i = 0; i < PAGES; i++) {
    const [w, h] = sizes[i];
    const annots = i === 0 ? ` /Annots [${LINK_EXT} 0 R ${LINK_INT} 0 R]` : '';
    objects[pageObj(i) - 1] = () =>
      `<< /Type /Page /Parent ${PAGES_OBJ} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${FONT} 0 R /F2 ${FONT_BOLD} 0 R >> >> /Contents ${contentObj(i)} 0 R${annots} >>`;
    objects[contentObj(i) - 1] = (num) => {
      const titles = ['Introduction', 'Details', 'More details', 'Layout', 'Search', 'A landscape page', 'Appendix', 'The end'];
      const lines = [];
      lines.push('BT /F2 26 Tf 56 ' + (h - 84) + ' Td (' + escapePdf(`${i + 1}. ${titles[i]}`) + ') Tj ET');
      let y = h - 130;
      for (let k = 0; k < 14 && y > 80; k++) {
        const text = LOREM[(i + k) % LOREM.length];
        lines.push(`BT /F1 12 Tf 56 ${y} Td (${escapePdf(text)}) Tj ET`);
        y -= 22;
      }
      if (i === 0) {
        lines.push('0 0.45 0.85 rg BT /F1 13 Tf 56 120 Td (Visit example.com \\(external link\\)) Tj ET');
        lines.push('0 0.45 0.85 rg BT /F1 13 Tf 320 120 Td (Jump to the appendix) Tj ET');
      }
      lines.push(`0 0 0 rg BT /F1 10 Tf ${w / 2 - 20} 40 Td (Page ${i + 1} of ${PAGES}) Tj ET`);
      return stream(num, '', lines.join('\n'));
    };
  }

  objects[LINK_EXT - 1] = (num) =>
    `<< /Type /Annot /Subtype /Link /Rect [52 112 290 134] /Border [0 0 0] /A << /S /URI /URI ${str(num, 'https://example.com/files-gg-pdf-fixture?from=pdf')} >> >>`;
  objects[LINK_INT - 1] = () =>
    `<< /Type /Annot /Subtype /Link /Rect [316 112 470 134] /Border [0 0 0] /Dest [${pageObj(6)} 0 R /XYZ 0 792 null] >>`;

  const [intro, details, child, appendix] = [0, 1, 2, 3].map((k) => OUTLINE_ITEMS + k);
  objects[OUTLINES - 1] = () => `<< /Type /Outlines /First ${intro} 0 R /Last ${appendix} 0 R /Count 4 >>`;
  objects[intro - 1] = (num) =>
    `<< /Title ${str(num, '1. Introduction')} /Parent ${OUTLINES} 0 R /Next ${details} 0 R /Dest [${pageObj(0)} 0 R /Fit] >>`;
  objects[details - 1] = (num) =>
    `<< /Title ${str(num, '2. Details')} /Parent ${OUTLINES} 0 R /Prev ${intro} 0 R /Next ${appendix} 0 R /First ${child} 0 R /Last ${child} 0 R /Count 1 /Dest [${pageObj(1)} 0 R /Fit] >>`;
  objects[child - 1] = (num) =>
    `<< /Title ${str(num, '2.1 A landscape page')} /Parent ${details} 0 R /Dest [${pageObj(5)} 0 R /Fit] >>`;
  objects[appendix - 1] = (num) =>
    `<< /Title ${str(num, '3. Appendix')} /Parent ${OUTLINES} 0 R /Prev ${details} 0 R /Dest [${pageObj(6)} 0 R /Fit] >>`;

  if (enc) {
    objects[ENCRYPT - 1] = () =>
      `<< /Filter /Standard /V 2 /R 3 /Length 128 /O <${enc.O.toString('hex')}> /U <${enc.U.toString('hex')}> /P ${enc.P} >>`;
  }

  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((make, idx) => {
    const num = idx + 1;
    const body = make(num);
    const buf = Buffer.concat([
      Buffer.from(`${num} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(length);
    parts.push(buf);
    length += buf.length;
  });
  const xrefOffset = length;
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (const off of offsets) xref.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  const idHex = fileId.toString('hex');
  const encryptRef = enc ? ` /Encrypt ${ENCRYPT} 0 R` : '';
  xref.push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${CATALOG} 0 R${encryptRef} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  parts.push(Buffer.from(xref.join(''), 'latin1'));
  return Buffer.concat(parts);
}

write('sample.pdf', buildPdf());
write('sample-protected.pdf', buildPdf({ password: 'files.gg' }));
