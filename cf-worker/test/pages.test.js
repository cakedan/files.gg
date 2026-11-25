import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeAttribute, escapeText, element } from '../worker/utils/html.js';
import { DEFAULT_METATAGS, Metatags, legacyMetatags, renderDocument, shouldRedirectToCdn } from '../worker/utils/pages.js';
import { cases, fileFor, headersFor, mithril, withOgProperty } from './support/fixtures.js';


// The old frontend's pages still use the legacy shell, byte for byte (apart from og:* property=).
export const LEGACY_PATH = /^\/(auth|dashboard|details|legal|options)(\/|$)/;

describe('legacy shell HTML matches the old Mithril output', () => {
  for (const request of cases.requests) {
    if (!LEGACY_PATH.test(request.path)) {
      continue;
    }
    it(request.name, () => {
      const html = renderDocument({ manifest: cases.manifest, metatags: legacyMetatags(request.path) });
      let expected = withOgProperty(mithril[request.name].body);
      if (request.path === '/auth' || request.path === '/legal') {
        // Deliberate: the old router let the vanity route win for these two exact paths, so it
        // looked up the (reserved) vanity "auth"/"legal" and said "404, file not found".
        expected = expected.replace('content="404, file not found"', 'content="??"');
      }
      assert.equal(html, expected);
    });
  }

  it('keeps the route-specific descriptions for trailing slashes and deeper paths', () => {
    assert.equal(legacyMetatags('/auth/login/').get('description'), 'Login here to view your files');
    assert.equal(legacyMetatags('/options/theme/dark').get('description'), '??');
    assert.equal(legacyMetatags('/dashboard/files/1/2').get('description'), 'View your files here.');
    assert.equal(legacyMetatags('/dashboard/files/1/2').get('title'), 'File Uploader');
    assert.equal(legacyMetatags('/dashboard/x').get('title'), 'File Uploader Dashboard');
  });

  it('renders the "script unavailable" body without a manifest', () => {
    const html = renderDocument({ manifest: null, metatags: legacyMetatags('/auth/login') });
    assert.match(html, /<body><span>script unavailable srry bro<\/span><\/body>/);
    assert.doesNotMatch(html, /name="og:/);
  });
});


describe('bot and embed routing (PLAN.md §1.4 item 3)', () => {
  for (const request of cases.requests) {
    const file = fileFor(request.path);
    const expected = mithril[request.name];
    if (!file || request.method === 'HEAD') {
      continue;
    }
    it(`${request.name}: ${expected.status === 302 ? 'redirects to the CDN' : 'renders the page'}`, () => {
      assert.equal(shouldRedirectToCdn(new Headers(headersFor(request)), file), expected.status === 302);
    });
  }
});


describe('HTML escaping', () => {
  it('escapes text like Mithril (quotes left alone)', () => {
    assert.equal(escapeText(`<a href="x">&'`), `&lt;a href="x"&gt;&amp;'`);
  });

  it('escapes attribute values including double quotes', () => {
    assert.equal(escapeAttribute(`"><script>alert(1)</script>&`), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;');
  });

  it('cannot break out of a meta tag or the title', () => {
    const metatags = new Metatags();
    metatags.set('title', '"><script>alert(1)</script>.png');
    metatags.set('og:image:alt', '"><script>alert(1)</script>.png');
    const html = metatags.toHtml();
    assert.doesNotMatch(html, /<script>/);
    assert.ok(html.includes('<title>"&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png</title>'));
    assert.ok(html.includes('content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;.png"'));
  });

  it('leaves out null and undefined attributes, like Mithril', () => {
    assert.equal(element('meta', { name: 'x', content: undefined }), '<meta name="x">');
    assert.equal(element('meta', { name: 'x', content: null }), '<meta name="x">');
    assert.equal(element('meta', { name: 'x', content: 0 }), '<meta name="x" content="0">');
  });

  it('keeps the default tag order', () => {
    assert.deepEqual([...new Metatags().keys()], Object.keys(DEFAULT_METATAGS));
  });
});
