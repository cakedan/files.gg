import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { escapeAttribute, escapeText, element } from '../worker/utils/html.js';
import { DEFAULT_METATAGS, Metatags, fileMetatags, renderDocument, shouldRedirectToCdn } from '../worker/utils/pages.js';
import { cases, fileFor, headersFor, mithril, withOgProperty } from './support/fixtures.js';


describe('stable page HTML matches the old Mithril output', () => {
  for (const request of cases.requests) {
    const expected = mithril[request.name];
    const isFilePage = request.path !== '/' && expected.status === 200 && !/^\/(auth|dashboard|details|legal|options)(\/|$)/.test(request.path);
    if (!isFilePage) {
      continue;
    }
    it(request.name, () => {
      const html = renderDocument({
        manifest: request.noManifest ? null : cases.manifest,
        metatags: fileMetatags(fileFor(request.path)),
      });
      assert.equal(html, withOgProperty(expected.body));
    });
  }

  it('root', () => {
    assert.equal(renderDocument({ manifest: cases.manifest, metatags: new Metatags() }), withOgProperty(mithril.root.body));
  });

  it('only og:* changed from name= to property=', () => {
    const html = renderDocument({ manifest: cases.manifest, metatags: fileMetatags(cases.files.vid1) });
    assert.match(html, /<meta property="og:video" content="https:\/\/cdn.files.gg\/files\/vid1.mp4">/);
    assert.match(html, /<meta name="twitter:player" content=/);
    assert.match(html, /<meta name="video:duration" content="12.5">/);
    assert.match(html, /<meta name="theme-color" content="#43b581">/);
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

  it('cannot break out of a meta tag through a filename', () => {
    const file = { ...cases.files.img1, filename: '"><script>alert(1)</script>.png' };
    const html = fileMetatags(file).toHtml();
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
