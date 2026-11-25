import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeAttribute, escapeText, element } from '../worker/utils/html.js';
import { shouldRedirectToCdn } from '../worker/utils/pages.js';
import { cases, fileFor, headersFor } from './support/fixtures.js';


describe('bot and embed routing (PLAN.md §1.4 item 3)', () => {
  for (const request of cases.requests) {
    const file = fileFor(request.path);
    if (!file || request.method === 'HEAD') {
      continue;
    }
    it(`${request.name}: ${request.expect === 'redirect' ? 'redirects to the CDN' : 'renders the page'}`, () => {
      assert.equal(shouldRedirectToCdn(new Headers(headersFor(request)), file), request.expect === 'redirect');
    });
  }
});


describe('HTML escaping', () => {
  it('escapes text (quotes left alone)', () => {
    assert.equal(escapeText(`<a href="x">&'`), `&lt;a href="x"&gt;&amp;'`);
  });

  it('escapes attribute values including double quotes', () => {
    assert.equal(escapeAttribute(`"><script>alert(1)</script>&`), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;');
  });

  it('cannot break out of a meta tag', () => {
    const html = element('meta', { property: 'og:title', content: '"><script>alert(1)</script>.png' });
    assert.doesNotMatch(html, /<script>/);
    assert.equal(html, '<meta property="og:title" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png">');
    assert.equal(element('title', {}, { text: '</title><script>' }), '<title>&lt;/title&gt;&lt;script&gt;</title>');
  });

  it('leaves out null and undefined attributes', () => {
    assert.equal(element('meta', { name: 'x', content: undefined }), '<meta name="x">');
    assert.equal(element('meta', { name: 'x', content: null }), '<meta name="x">');
    assert.equal(element('meta', { name: 'x', content: 0 }), '<meta name="x" content="0">');
  });
});
