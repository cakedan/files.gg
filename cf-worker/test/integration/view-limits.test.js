// View limits on the real Worker (workerd), against the mock API and B2 (milestone-6.md §19.5): the
// `limited` shell with generic og tags, no CDN redirect ever, link-preview bots refused with 403 (and no
// API call beyond the lookup), the CDN serving bytes and previews only through signed URLs, a used-up
// limit as missing, and the same on a custom domain.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FILES, previewPath, signedForFile, startS3, startUpstream, startWorker } from '../support/worker.js';


const browser = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const BOTS = {
  discord: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  telegram: { 'user-agent': 'TelegramBot (like TwitterBot)' },
  sharex: { 'user-agent': 'ShareX/15.0' },
  'accept image/*': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/*' },
  // milestone-6.md §19.7a: preview fetchers without "bot" in their name, with browser-like headers
  facebook: { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', accept: 'text/html', 'accept-language': 'en' },
  whatsapp: { 'user-agent': 'WhatsApp/2.23.20.0 A', accept: 'text/html', 'accept-language': 'en' },
  bluesky: { 'user-agent': 'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)', accept: 'text/html', 'accept-language': 'en' },
  mastodon: { 'user-agent': 'http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)', accept: 'text/html', 'accept-language': 'en' },
};
const NO_STORE = 'private, no-store';
const BOT_TEXT = "This file has a view limit and can't be previewed.";
const HOSTS = ['files.gg', 'i.example.com'];

let upstream;
let s3;
let worker;
const at = (host, path, options = {}) => worker.request(`https://${host}${path}`, { headers: browser, ...options });
const cdnHost = (host) => (host === 'files.gg' ? 'cdn.files.gg' : host);

before(async () => {
  upstream = await startUpstream();
  s3 = await startS3();
  worker = await startWorker({ upstream, s3 });
});

after(async () => {
  await worker?.close();
  await s3?.close();
  await upstream?.close();
});


function shellOf(html) {
  const root = /<div id="root"([^>]*)><\/div>/.exec(html);
  assert.ok(root, 'has #root');
  const attributes = Object.fromEntries([...root[1].matchAll(/ (data-[a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const data = /<script id="file-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  const start = html.indexOf('-->', html.indexOf('filesgg:meta:start')) + 3;
  return {
    page: attributes['data-page'],
    state: attributes['data-state'],
    data: data ? JSON.parse(data[1]) : undefined,
    meta: html.slice(start, html.indexOf('<!-- filesgg:meta:end')),
  };
}


describe('the limited shell (§19.5)', () => {
  for (const host of HOSTS) {
    it(`${host}: a link file is { vanity, view_limited, views_remaining }, generic og tags, no media`, async () => {
      for (const path of ['/vl3', '/vl3.png']) {
        const response = await at(host, path);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers['cache-control'], NO_STORE, path);
        const shell = shellOf(response.text);
        assert.deepEqual([shell.page, shell.state], ['file', 'limited'], path);
        assert.deepEqual(shell.data, { vanity: 'vl3', view_limited: true, views_remaining: 2 }, path);
        assert.match(shell.meta, /<meta property="og:title" content="View-limited file · files\.gg">/);
        assert.doesNotMatch(shell.meta, /og:image|og:video|og:audio|twitter:image|twitter:player/);
        assert.doesNotMatch(response.text, /limited\.png|\/files\/vl3|previews\/thumb\/vl3/);
      }
      const video = shellOf((await at(host, '/vlvid.mp4')).text);
      assert.equal(video.state, 'limited');
      assert.doesNotMatch(video.meta, /og:image|og:video|twitter:player/);
    });

    it(`${host}: a password file keeps the lock screen, with the views left`, async () => {
      const response = await at(host, '/vlpw');
      assert.equal(response.status, 200);
      const shell = shellOf(response.text);
      assert.equal(shell.state, 'locked');
      assert.deepEqual(shell.data, { vanity: 'vlpw', protected: 'password', view_limited: true, views_remaining: 2, filename: 'limited-pw.png' });
      assert.doesNotMatch(shell.meta, /og:image/);
    });

    it(`${host}: a used-up or unreadable limit is missing`, async () => {
      for (const vanity of ['vldone', 'vlbad']) {
        const response = await at(host, `/${vanity}.png`);
        assert.equal(response.status, 404, vanity);
        assert.equal(shellOf(response.text).state, 'missing', vanity);
      }
    });

    it(`${host}: link-preview bots get 403 with the short text, never the CDN, never a page`, async () => {
      for (const vanity of ['vl3', 'vlpw', 'vlvid']) {
        for (const [name, headers] of Object.entries(BOTS)) {
          const before = upstream.requests.length;
          const response = await at(host, `/${vanity}.png`, { headers });
          assert.equal(response.status, 403, `${vanity} ${name}`);
          assert.equal(response.headers.location, undefined, `${vanity} ${name}`);
          assert.equal(response.headers['cache-control'], NO_STORE, `${vanity} ${name}`);
          assert.match(response.headers['content-type'], /^text\/plain/);
          assert.equal(response.text, BOT_TEXT, `${vanity} ${name}`);
          // nothing but (at most) the cached lookups: a bot never reaches the API's open endpoint
          const calls = upstream.requests.slice(before).filter((r) => !r.path.startsWith('/internal/'));
          assert.deepEqual(calls, [], `${vanity} ${name}`);
        }
      }
      // the same bots still get redirected for a file without a limit (owned by U, so on i.example.com too)
      const plain = await at(host, '/ulink.png', { headers: BOTS['accept image/*'] });
      assert.equal(plain.status, 302);
    });
  }

  it('another owner\'s view-limited file is missing on an `own` domain', async () => {
    const response = await at('i.example.com', '/vlv.png');
    assert.equal(response.status, 404);
    assert.equal((await at('i.example.com', '/vlv.png', { headers: BOTS.discord })).status, 404);
  });
});


describe('the CDN (§19.4, §19.5)', () => {
  for (const host of HOSTS) {
    const cdn = (path, options) => worker.request(`https://${cdnHost(host)}${path}`, options);

    it(`${cdnHost(host)}: an unsigned request is refused, a signed one is served privately`, async () => {
      for (const path of ['/files/vl3.png', previewPath('vl3', 'thumb')]) {
        const unsigned = await cdn(path);
        assert.equal(unsigned.status, 404, path);
        assert.equal(unsigned.headers['cache-control'], NO_STORE, path);
        // a bot asking the CDN directly is refused like any unsigned request
        assert.equal((await cdn(path, { headers: BOTS.discord })).status, 404, path);
        const signed = await cdn(signedForFile('vl3', path));
        assert.equal(signed.status, 200, path);
        assert.equal(signed.headers['cache-control'], NO_STORE, path);
      }
      // a password file with a limit: 401 unsigned, as any password file
      assert.equal((await cdn('/files/vlpw.png')).status, 401);
      assert.equal((await cdn(signedForFile('vlpw', '/files/vlpw.png'))).status, 200);
    });

    it(`${cdnHost(host)}: URLs signed for an older access_version (the action fired) are refused`, async () => {
      const stale = await cdn(signedForFile('vldone', '/files/vldone.png', { version: 0 }));
      assert.equal(stale.status, 404);
      // an album grant never opens a view-limited file (it's no album's item)
      const throughAlbum = await cdn(`/files/vl3.png?album=alb1&${new URLSearchParams(signedForFile('vl3', '/files/vl3.png').split('?')[1])}`);
      assert.equal(throughAlbum.status, 404);
    });
  }

  it('the fixtures carry the lookup field', () => {
    assert.deepEqual(FILES.vl3.view_limit, { limit: 3, used: 1, action: 'expire' });
    assert.equal(FILES.img1.view_limit, null);
  });
});
