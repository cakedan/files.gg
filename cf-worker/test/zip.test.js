// The streaming ZIP writer (worker/utils/zip.js), checked against real unzip implementations:
// JSZip (with CRC-32 checking on) and, when the system has one, Info-ZIP's `unzip -t`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';

import JSZip from 'jszip';

import {
  createZipStream,
  crc32,
  dosDateTime,
  uniqueNames,
  zipSize,
} from '../worker/utils/zip.js';


const encoder = new TextEncoder();

function pattern(length, seed = 1) {
  const bytes = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

// A stream that hands out `bytes` in chunks of the given sizes (cycled), so CRC-32 and the
// copy loop see boundaries at odd offsets, including inside an 8-byte slice.
function chunked(bytes, sizes = [1, 7, 13, 4096, 3, 65536, 9]) {
  let offset = 0;
  let turn = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = sizes[turn++ % sizes.length];
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function collect(stream) {
  const chunks = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Central directory records, parsed straight from the bytes (to check the flags and method).
function centralRecords(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const records = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLength = zip.readUInt16LE(at + 28);
    records.push({
      versionNeeded: zip.readUInt16LE(at + 6),
      flags: zip.readUInt16LE(at + 8),
      method: zip.readUInt16LE(at + 10),
      crc: zip.readUInt32LE(at + 16),
      compressed: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      offset: zip.readUInt32LE(at + 42),
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return { records, eocd };
}

const big = pattern(200 * 1024 + 5, 7);
const ENTRIES = () => [
  { name: 'multi-chunk.bin', size: big.length, open: () => chunked(big) },
  { name: 'empty.txt', size: 0, open: () => new Uint8Array(0) },
  { name: 'café 日本 🎉.txt', size: 12, open: () => encoder.encode('hello, world') },
  { name: 'one-chunk.bin', open: async () => chunked(pattern(4096, 3), [4096]) },
];
const CONTENTS = [big, new Uint8Array(0), encoder.encode('hello, world'), pattern(4096, 3)];


describe('crc32', () => {
  it('matches zlib for every length around the 8-byte slices', () => {
    const data = pattern(1000, 11);
    for (let length = 0; length <= 70; length++) {
      assert.equal(crc32(data.subarray(0, length)), zlibCrc32(data.subarray(0, length)), String(length));
    }
    assert.equal(crc32(data), zlibCrc32(data));
    assert.equal(crc32(encoder.encode('123456789')), 0xCBF43926);
  });

  it('chains across chunk boundaries like zlib', () => {
    const data = pattern(100003, 5);
    for (const cuts of [[1], [3, 8, 9], [7, 7, 7, 7], [4096, 1, 65535]]) {
      let crc = 0;
      let offset = 0;
      let turn = 0;
      while (offset < data.length) {
        const size = cuts[turn++ % cuts.length];
        crc = crc32(data.subarray(offset, offset + size), crc);
        offset += size;
      }
      assert.equal(crc, zlibCrc32(data), cuts.join(','));
    }
  });
});


describe('uniqueNames', () => {
  it('numbers duplicates as "name (2).ext", case-insensitively, never reusing a taken name', () => {
    assert.deepEqual(
      uniqueNames(['a.png', 'a.png', 'A.PNG', 'a (2).png', 'noext', 'noext', '.hidden', '.hidden', 'x.tar.gz', 'x.tar.gz']),
      ['a.png', 'a (2).png', 'A (3).PNG', 'a (2) (2).png', 'noext', 'noext (2)', '.hidden', '.hidden (2)', 'x.tar.gz', 'x.tar (2).gz'],
    );
  });
});


describe('dosDateTime', () => {
  it('packs the date and time (2-second resolution) and clamps before 1980', () => {
    assert.deepEqual(dosDateTime(new Date(Date.UTC(2026, 10, 25, 13, 45, 31))), {
      time: (13 << 11) | (45 << 5) | 15,
      date: ((2026 - 1980) << 9) | (11 << 5) | 25,
    });
    assert.equal(dosDateTime(new Date(Date.UTC(1970, 0, 1))).date >> 9, 0);
  });
});


describe('createZipStream', () => {
  it('writes an archive real unzippers accept, with correct CRCs, names and contents', async () => {
    const date = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
    const zip = await collect(createZipStream(ENTRIES(), { date }));

    const archive = await JSZip.loadAsync(zip, { checkCRC32: true });
    const names = Object.keys(archive.files);
    assert.deepEqual(names, ENTRIES().map((entry) => entry.name));
    for (const [index, name] of names.entries()) {
      const content = await archive.file(name).async('uint8array');
      assert.deepEqual(Buffer.from(content), Buffer.from(CONTENTS[index]), name);
      // JSZip keeps the CRC signed, and none for an empty entry (0 by definition).
      assert.equal((archive.files[name]._data.crc32 ?? 0) >>> 0, zlibCrc32(CONTENTS[index]), name);
    }
  });

  it('store mode, bit 3 data descriptors, bit 11 UTF-8 names, zero CRC/sizes in local headers', async () => {
    const date = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
    const zip = await collect(createZipStream(ENTRIES(), { date }));
    const { records } = centralRecords(zip);
    const stamp = dosDateTime(date);
    assert.equal(records.length, 4);
    for (const [index, record] of records.entries()) {
      assert.equal(record.method, 0);
      assert.equal(record.flags, 0x0808);
      assert.equal(record.versionNeeded, 20);
      assert.equal(record.crc, zlibCrc32(CONTENTS[index]));
      assert.equal(record.size, CONTENTS[index].length);
      assert.equal(record.compressed, CONTENTS[index].length);

      const local = record.offset;
      assert.equal(zip.readUInt32LE(local), 0x04034b50);
      assert.equal(zip.readUInt16LE(local + 6), 0x0808);
      assert.equal(zip.readUInt16LE(local + 8), 0, 'stored');
      assert.equal(zip.readUInt16LE(local + 10), stamp.time);
      assert.equal(zip.readUInt16LE(local + 12), stamp.date);
      assert.equal(zip.readUInt32LE(local + 14), 0, 'local CRC is zero');
      assert.equal(zip.readUInt32LE(local + 18), 0, 'local compressed size is zero');
      assert.equal(zip.readUInt32LE(local + 22), 0, 'local size is zero');
      const nameLength = zip.readUInt16LE(local + 26);
      assert.equal(zip.subarray(local + 30, local + 30 + nameLength).toString('utf8'), record.name);
      const descriptor = local + 30 + nameLength + record.size;
      assert.equal(zip.readUInt32LE(descriptor), 0x08074b50);
      assert.equal(zip.readUInt32LE(descriptor + 4), record.crc);
      assert.equal(zip.readUInt32LE(descriptor + 8), record.size);
      assert.equal(zip.readUInt32LE(descriptor + 12), record.size);
    }
    assert.equal(records[2].name, 'café 日本 🎉.txt');
  });

  it('zipSize predicts the exact length', async () => {
    const zip = await collect(createZipStream(ENTRIES()));
    assert.equal(zipSize(ENTRIES().map((entry, index) => ({ name: entry.name, size: CONTENTS[index].length }))), zip.length);
    assert.equal(zipSize([{ name: 'a', size: undefined }]), null);
    assert.equal(zipSize([]), 22);
  });

  it('an empty list is a valid empty archive', async () => {
    const zip = await collect(createZipStream([]));
    assert.equal(zip.length, 22);
    assert.deepEqual(Object.keys((await JSZip.loadAsync(zip)).files), []);
  });

  it('passes Info-ZIP `unzip -t` when the system has it', async (t) => {
    const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      t.skip('no unzip on this system');
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'filesgg-zip-test-'));
    try {
      const path = join(dir, 'album.zip');
      writeFileSync(path, await collect(createZipStream(ENTRIES())));
      const result = spawnSync('unzip', ['-t', path], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /No errors detected/);
      assert.match(result.stdout, /multi-chunk\.bin\s+OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens entries lazily, one at a time, as the reader gets to them', async () => {
    const opened = [];
    const entries = ['a', 'b', 'c'].map((name) => ({ name, open: () => { opened.push(name); return encoder.encode(name); } }));
    const reader = createZipStream(entries).getReader();
    assert.deepEqual(opened, []);
    await reader.read(); // a's local header
    assert.deepEqual(opened, ['a']);
    await reader.read(); // a's bytes
    await reader.read(); // a's descriptor
    assert.deepEqual(opened, ['a']);
    await reader.read(); // b's header
    assert.deepEqual(opened, ['a', 'b']);
    await reader.cancel();
  });

  it('errors when an entry is not the size it promised', async () => {
    await assert.rejects(collect(createZipStream([{ name: 'a', size: 5, open: () => encoder.encode('abc') }])), /3 bytes, expected 5/);
  });

  it('errors (without writing its header) when an entry fails to open', async () => {
    const chunks = [];
    const reader = createZipStream([
      { name: 'ok', open: () => encoder.encode('ok') },
      { name: 'broken', open: async () => { throw new Error('storage 404'); } },
    ]).getReader();
    await assert.rejects((async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
      }
    })(), /storage 404/);
    assert.equal(Buffer.concat(chunks).indexOf('broken'), -1);
  });

  it('cancelling the archive cancels the entry being read', async () => {
    let cancelled = null;
    const source = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel(reason) {
        cancelled = reason ?? true;
      },
    });
    const reader = createZipStream([{ name: 'endless', open: () => source }]).getReader();
    await reader.read();
    await reader.read();
    await reader.cancel('client went away');
    assert.ok(cancelled);
  });
});
