import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CDN_EXPOSE_HEADERS,
  decideCdnResponse,
  isForcedText,
  sanitizeFilename,
} from '../worker/utils/security.js';


describe('isForcedText: every XML-family type is served as text/plain', () => {
  const forced = [
    'text/html', 'image/svg+xml', 'application/xhtml+xml',
    'application/xml', 'text/xml', 'text/xsl',
    'application/rss+xml', 'application/atom+xml', 'APPLICATION/XML; charset=utf-8',
  ];
  for (const mimetype of forced) {
    it(`${mimetype} is forced`, () => assert.equal(isForcedText(mimetype), true));
  }
  for (const mimetype of ['text/plain', 'image/png', 'application/json', 'application/pdf', '']) {
    it(`${JSON.stringify(mimetype)} is not forced`, () => assert.equal(isForcedText(mimetype), false));
  }

  it('an RSS feed renders inline as plain text, never as markup', () => {
    const result = decideCdnResponse({ mimetype: 'application/rss+xml', query: {}, filename: 'feed.xml' });
    assert.equal(result.contentType, 'text/plain');
    assert.equal(result.disposition, 'inline');
  });
});


describe('CDN range support for pdf.js', () => {
  it('exposes the headers a ranged fetch needs', () => {
    for (const name of ['Accept-Ranges', 'Content-Range', 'Content-Length', 'Content-Disposition']) {
      assert.ok(CDN_EXPOSE_HEADERS.includes(name), name);
    }
  });
});


describe('source stays free of literal invisible characters', () => {
  // Literal bidi or zero-width characters in source can be stripped by tooling without anyone
  // noticing, which would silently disable sanitizeFilename's protection.
  it('security.js contains no raw bidi or zero-width characters', () => {
    const source = readFileSync(new URL('../worker/utils/security.js', import.meta.url), 'utf8');
    assert.equal(/[‪-‮⁦-⁩​-‏⁠﻿؜]/.test(source), false);
  });

  it('the escaped regexes still strip the right-to-left override trick', () => {
    assert.equal(sanitizeFilename('invoice‮fdp.exe'), 'invoicefdp.exe');
  });
});
