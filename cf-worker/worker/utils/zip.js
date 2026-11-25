// A small streaming ZIP writer for album "Download all" (docs/redesign/contracts/milestone-3.md §3).
//
// - Store mode only (method 0): the bytes are copied through, never compressed or buffered.
// - General-purpose bit 3: the local header carries zero CRC and sizes, and a data descriptor
//   (with its 0x08074b50 signature) follows each entry with the CRC-32 computed while streaming.
// - Bit 11: names are UTF-8.
// - No ZIP64: the caller caps the total (2 GiB), and anything that would overflow a 32-bit field
//   throws instead of writing a corrupt archive.
//
// Pure (Web Streams and typed arrays only), so it runs in workerd and in Node's test runner.

const encoder = new TextEncoder();

export const ZIP_FLAGS = 0x0808; // bit 3 (data descriptor) | bit 11 (UTF-8 names)
const VERSION_NEEDED = 20; // 2.0: data descriptors
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED; // Unix, so the external attributes are modes
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0; // a regular file, rw-r--r--
const UINT32_MAX = 0xFFFFFFFF;
const UINT16_MAX = 0xFFFF;

export const LOCAL_HEADER_SIZE = 30;
export const DATA_DESCRIPTOR_SIZE = 16;
export const CENTRAL_HEADER_SIZE = 46;
export const END_OF_CENTRAL_DIRECTORY_SIZE = 22;


// --- CRC-32 (IEEE 802.3, reflected 0xEDB88320), slice-by-8 ------------------------------------

const CRC_TABLES = (() => {
  const tables = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let k = 1; k < 8; k++) {
      c = tables[c & 0xFF] ^ (c >>> 8);
      tables[k * 256 + n] = c;
    }
  }
  return tables;
})();

// Like zlib's crc32(): `crc32(chunk2, crc32(chunk1))` equals `crc32(chunk1 + chunk2)`.
export function crc32(bytes, previous = 0) {
  const t = CRC_TABLES;
  let c = (~previous) >>> 0;
  let i = 0;
  const length = bytes.length;
  for (; i + 8 <= length; i += 8) {
    const a = (c ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))) >>> 0;
    const b = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
    c = t[1792 + (a & 0xFF)] ^ t[1536 + ((a >>> 8) & 0xFF)] ^ t[1280 + ((a >>> 16) & 0xFF)] ^ t[1024 + (a >>> 24)]
      ^ t[768 + (b & 0xFF)] ^ t[512 + ((b >>> 8) & 0xFF)] ^ t[256 + ((b >>> 16) & 0xFF)] ^ t[b >>> 24];
  }
  for (; i < length; i++) {
    c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}


// --- Names ---------------------------------------------------------------------------------

// Makes names unique, case-insensitively (Windows and macOS file systems are): the second
// "a.png" becomes "a (2).png", the third "a (3).png", skipping any name already taken.
export function uniqueNames(names) {
  const used = new Set();
  return names.map((name) => {
    let candidate = name;
    if (used.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const base = (dot > 0) ? name.slice(0, dot) : name;
      const extension = (dot > 0) ? name.slice(dot) : '';
      for (let n = 2; used.has(candidate.toLowerCase()); n++) {
        candidate = `${base} (${n})${extension}`;
      }
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}


// --- Layout ----------------------------------------------------------------------------------

// MS-DOS date and time (local fields; the Worker runs in UTC). Years before 1980 clamp to 1980.
export function dosDateTime(date = new Date()) {
  const d = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & UINT16_MAX,
    date: (((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & UINT16_MAX,
  };
}

// The exact archive size for entries [{ name, size }], or null when any size is unknown.
export function zipSize(entries) {
  let total = END_OF_CENTRAL_DIRECTORY_SIZE;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      return null;
    }
    const nameLength = encoder.encode(entry.name).length;
    total += LOCAL_HEADER_SIZE + nameLength + entry.size + DATA_DESCRIPTOR_SIZE + CENTRAL_HEADER_SIZE + nameLength;
  }
  return total;
}

function localHeader(name, stamp) {
  const bytes = new Uint8Array(LOCAL_HEADER_SIZE + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, VERSION_NEEDED, true);
  view.setUint16(6, ZIP_FLAGS, true);
  view.setUint16(8, 0, true); // stored
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  // 14-25: CRC-32, compressed and uncompressed sizes are zero (bit 3); 26-29: name and extra lengths.
  view.setUint16(26, name.length, true);
  bytes.set(name, LOCAL_HEADER_SIZE);
  return bytes;
}

function dataDescriptor(crc, size) {
  const bytes = new Uint8Array(DATA_DESCRIPTOR_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return bytes;
}

function centralDirectory(records, offset) {
  let size = 0;
  for (const record of records) {
    size += CENTRAL_HEADER_SIZE + record.name.length;
  }
  if (records.length > UINT16_MAX || offset > UINT32_MAX || offset + size > UINT32_MAX) {
    throw new RangeError('ZIP too large without ZIP64');
  }
  const bytes = new Uint8Array(size + END_OF_CENTRAL_DIRECTORY_SIZE);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const record of records) {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, VERSION_MADE_BY, true);
    view.setUint16(at + 6, VERSION_NEEDED, true);
    view.setUint16(at + 8, ZIP_FLAGS, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, record.stamp.time, true);
    view.setUint16(at + 14, record.stamp.date, true);
    view.setUint32(at + 16, record.crc, true);
    view.setUint32(at + 20, record.size, true);
    view.setUint32(at + 24, record.size, true);
    view.setUint16(at + 28, record.name.length, true);
    // 30: extra length, 32: comment length, 34: disk number, 36: internal attributes (all 0).
    view.setUint32(at + 38, EXTERNAL_ATTRIBUTES, true);
    view.setUint32(at + 42, record.offset, true);
    bytes.set(record.name, at + CENTRAL_HEADER_SIZE);
    at += CENTRAL_HEADER_SIZE + record.name.length;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, size, true);
  view.setUint32(at + 16, offset, true);
  return bytes;
}

function toBytes(chunk) {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof(chunk) === 'string') {
    return encoder.encode(chunk);
  }
  throw new TypeError('ZIP entry streams must yield bytes');
}

function asStream(body) {
  if (body && typeof(body.getReader) === 'function') {
    return body;
  }
  const bytes = (body === null || body === undefined) ? new Uint8Array(0) : toBytes(body);
  return new ReadableStream({
    start(controller) {
      if (bytes.length) {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
}


async function* generate(entries, defaultDate) {
  const records = [];
  let offset = 0;
  for await (const entry of entries) {
    const name = encoder.encode(String(entry.name));
    if (name.length > UINT16_MAX) {
      throw new RangeError('ZIP entry name too long');
    }
    const stamp = dosDateTime(entry.date || defaultDate);
    // Open before the header goes out, so a failure never leaves a half-written entry.
    const reader = asStream(await entry.open()).getReader();

    const header = localHeader(name, stamp);
    const entryOffset = offset;
    offset += header.length;
    yield header;

    let crc = 0;
    let size = 0;
    let done = false;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          done = true;
          break;
        }
        const chunk = toBytes(result.value);
        if (!chunk.length) {
          continue;
        }
        crc = crc32(chunk, crc);
        size += chunk.length;
        if (size > UINT32_MAX || offset + chunk.length > UINT32_MAX) {
          throw new RangeError('ZIP too large without ZIP64');
        }
        offset += chunk.length;
        yield chunk;
      }
    } finally {
      if (!done) {
        await reader.cancel().catch(() => {});
      }
      reader.releaseLock();
    }
    if (Number.isSafeInteger(entry.size) && entry.size !== size) {
      throw new Error(`ZIP entry ${JSON.stringify(String(entry.name))} is ${size} bytes, expected ${entry.size}`);
    }

    const descriptor = dataDescriptor(crc, size);
    offset += descriptor.length;
    yield descriptor;
    records.push({ name, stamp, crc, size, offset: entryOffset });
  }
  yield centralDirectory(records, offset);
}


// entries: an array or (async) iterable of { name, size?, date?, open }, where `open()` returns
// (a promise of) a ReadableStream of bytes, or bytes. Entries are opened one at a time, in order,
// only when the reader gets to them. With `size`, a body of any other length errors the stream.
// Returns a ReadableStream of the archive; it errors if an entry fails, and cancelling it cancels
// the entry being read.
export function createZipStream(entries, { date = new Date() } = {}) {
  const iterator = generate(entries, date);
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      await iterator.return(undefined).catch(() => {});
    },
  }, { highWaterMark: 0 });
}
