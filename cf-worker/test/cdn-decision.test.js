import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideCdnResponse } from '../worker/utils/security.js';


// Expected [contentType, disposition] for each mimetype under each query.
const QUERIES = {
  none: '',
  download: '?download=true',
  forceText: '?force-text=true',
  both: '?download=true&force-text=true',
};

const MATRIX = {
  'text/html': {
    none: ['text/plain', 'inline'],
    download: ['text/plain', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
  'image/svg+xml': {
    none: ['text/plain', 'inline'],
    download: ['text/plain', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
  'application/pdf': {
    none: ['application/pdf', 'attachment'],
    download: ['application/pdf', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
  'image/png': {
    none: ['image/png', 'inline'],
    download: ['image/png', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
  'video/mp4': {
    none: ['video/mp4', 'inline'],
    download: ['video/mp4', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
  'application/zip': {
    none: ['application/zip', 'attachment'],
    download: ['application/zip', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
  'application/octet-stream': {
    none: ['application/octet-stream', 'attachment'],
    download: ['application/octet-stream', 'attachment'],
    forceText: ['text/plain', 'inline'],
    both: ['text/plain', 'attachment'],
  },
};


describe('decideCdnResponse matrix', () => {
  for (const [mimetype, expectations] of Object.entries(MATRIX)) {
    for (const [queryName, [contentType, disposition]] of Object.entries(expectations)) {
      it(`${mimetype} ${queryName} -> ${contentType}, ${disposition}`, () => {
        const query = new URLSearchParams(QUERIES[queryName]);
        const result = decideCdnResponse({ mimetype, query, filename: 'file.bin' });
        assert.equal(result.contentType, contentType);
        assert.equal(result.disposition, disposition);
        assert.equal(result.contentDisposition, `${disposition}; filename="file.bin"; filename*=UTF-8''file.bin`);
      });
    }
  }
});


describe('decideCdnResponse details', () => {
  it('forces markup to text even with parameters or odd casing', () => {
    for (const mimetype of ['text/html; charset=utf-8', 'TEXT/HTML', 'Image/SVG+XML', 'application/xhtml+xml']) {
      const result = decideCdnResponse({ mimetype, query: new URLSearchParams(), filename: 'a' });
      assert.equal(result.contentType, 'text/plain', mimetype);
      assert.equal(result.disposition, 'inline', mimetype);
    }
  });

  it('keeps the existing boolean parsing of ?download and ?force-text', () => {
    const decide = (search) => decideCdnResponse({ mimetype: 'image/png', query: new URLSearchParams(search), filename: 'a.png' });
    for (const value of ['true', '1', 'yes', 'ok', 'okay', 'TRUE']) {
      assert.equal(decide(`download=${value}`).disposition, 'attachment', value);
      assert.equal(decide(`force-text=${value}`).contentType, 'text/plain', value);
    }
    for (const search of ['download=false', 'download=0', 'download=no', 'download', 'download=']) {
      assert.equal(decide(search).disposition, 'inline', search);
    }
  });

  it('accepts a plain object as the query', () => {
    const result = decideCdnResponse({ mimetype: 'image/png', query: { download: 'true' }, filename: 'a.png' });
    assert.equal(result.disposition, 'attachment');
  });

  it('sanitizes the filename in the header', () => {
    const result = decideCdnResponse({
      mimetype: 'application/octet-stream',
      query: new URLSearchParams(),
      filename: 'invoice‮fdp.exe',
    });
    assert.equal(result.filename, 'invoicefdp.exe');
    assert.equal(result.contentDisposition, 'attachment; filename="invoicefdp.exe"; filename*=UTF-8\'\'invoicefdp.exe');
  });

  it('downloads when the mimetype is missing', () => {
    const result = decideCdnResponse({ mimetype: undefined, query: new URLSearchParams(), filename: undefined });
    assert.equal(result.contentType, 'application/octet-stream');
    assert.equal(result.disposition, 'attachment');
    assert.equal(result.filename, 'file');
  });
});
