// View limits (docs/redesign/contracts/milestone-6.md §19.5): the lookup's `view_limit`, link-preview
// bots, and the file shell decisions. Pure, no Worker.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isLinkPreviewUserAgent, LINK_PREVIEW_FETCHERS } from '../worker/utils/bots.js';
import { shouldRedirectToCdn } from '../worker/utils/pages.js';
import { decideFileShell, LOCKED_FILE_TITLE } from '../worker/utils/viewer.js';
import {
  BOT_REFUSAL_TEXT,
  botRefusalResponse,
  isLinkPreviewBot,
  isViewLimited,
  LIMITED_FILE_TITLE,
  viewLimitOf,
} from '../worker/utils/viewlimits.js';


const NOW = Date.UTC(2026, 10, 25, 12);
const browser = new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' });
const OK = { state: 'ok', reason: null };
const imageFile = {
  id: '1111', vanity: 'img1', kind: 'image', filename: 'cat.png', mimetype: 'image/png', extension: 'png',
  size: 123456, width: 800, height: 600, cdn_url: 'https://cdn.files.gg/files/img1.png', url: 'https://files.gg/img1.png',
  thumbnail: { url: 'https://cdn.files.gg/previews/thumb/img1.webp?v=1', type: 'thumb' }, expires_at: null,
};
const limited = (viewLimit, access = {}, extra = {}) => ({
  status: 'found',
  data: {
    file: imageFile,
    access: { visibility: 'link', access_version: 0, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: false, ...access },
    safety: OK, serve_inline: true, view_limit: viewLimit, ...extra,
  },
});
const THREE = { limit: 3, used: 1, action: 'expire' };
const BOT_HEADERS = {
  discord: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' },
  telegram: { 'user-agent': 'TelegramBot (like TwitterBot)' },
  twitter: { 'user-agent': 'Twitterbot/1.0' },
  sharex: { 'user-agent': 'ShareX/15.0' },
  'accept image/*': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/*' },
  'accept image/webp,image/*': { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', accept: 'image/webp,image/*;q=0.8' },
};
// milestone-6.md §19.7a: link-preview fetchers without "bot" in their user agent, each with a browser's
// Accept and Accept-Language, so only the user agent marks them
const PREVIEW_FETCHER_AGENTS = {
  facebookexternalhit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  Facebot: 'Facebot',
  WhatsApp: 'WhatsApp/2.23.20.0 A',
  'Slack-ImgProxy': 'Slack-ImgProxy (+https://api.slack.com/robots)',
  SkypeUriPreview: 'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5',
  Embedly: 'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)',
  Iframely: 'Iframely/1.3.1 (+https://iframely.com/docs/about)',
  vkShare: 'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)',
  Mastodon: 'http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/)',
  'Bluesky Cardyb': 'Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)',
  'Google-InspectionTool': 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
  'upper case': 'FACEBOOKEXTERNALHIT/1.1',
  'lower case': 'bluesky cardyb/1.1',
};
for (const [name, userAgent] of Object.entries(PREVIEW_FETCHER_AGENTS)) {
  BOT_HEADERS[name] = { 'user-agent': userAgent, accept: 'text/html', 'accept-language': 'en' };
}


describe('viewLimitOf', () => {
  it('reads the lookup, null without a limit', () => {
    assert.equal(viewLimitOf({ view_limit: null }), null);
    assert.equal(viewLimitOf({}), null);
    assert.equal(viewLimitOf(null), null);
    assert.deepEqual(viewLimitOf({ view_limit: THREE }), { limit: 3, used: 1, remaining: 2, action: 'expire' });
    assert.deepEqual(viewLimitOf({ view_limit: { limit: 2, used: 5, action: 'private' } }).remaining, 0);
    assert.equal(isViewLimited({ view_limit: THREE }), true);
    assert.equal(isViewLimited({ view_limit: null }), false);
  });

  it('fails closed on anything malformed: limited, nothing left', () => {
    for (const value of [{}, { limit: 'many' }, { limit: 3 }, { limit: 0, used: 0 }, { limit: -1, used: 0 }, 'x', 3, true, []]) {
      const parsed = viewLimitOf({ view_limit: value });
      assert.ok(parsed, JSON.stringify(value));
      assert.equal(parsed.remaining, 0, JSON.stringify(value));
    }
  });
});


describe('isLinkPreviewBot', () => {
  it('is the bot user-agent list, the preview fetchers, plus Accept: image/*', () => {
    for (const [name, headers] of Object.entries(BOT_HEADERS)) {
      assert.equal(isLinkPreviewBot(new Headers(headers)), true, name);
    }
    assert.equal(isLinkPreviewBot(browser), false);
    assert.equal(isLinkPreviewBot(new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'image/avif,image/webp,*/*' })), false);
    assert.equal(isLinkPreviewBot(new Headers({ accept: 'text/html' })), false);
  });

  it('keeps the list in one place (utils/bots.js), every entry matched case-insensitively', () => {
    assert.deepEqual([...LINK_PREVIEW_FETCHERS], [
      'facebookexternalhit', 'Facebot', 'WhatsApp', 'Slack-ImgProxy', 'SkypeUriPreview', 'Embedly', 'Iframely',
      'vkShare', 'Mastodon', 'Bluesky Cardyb', 'Google-InspectionTool',
    ]);
    for (const name of LINK_PREVIEW_FETCHERS) {
      for (const userAgent of [name, name.toUpperCase(), name.toLowerCase(), `Mozilla/5.0 (compatible; ${name}/1.0)`]) {
        assert.equal(isLinkPreviewUserAgent(userAgent), true, userAgent);
      }
    }
    for (const userAgent of ['Mozilla/5.0', 'Bluesky/1.0', 'Slack/4.0', 'curl/8.0', '', undefined, null]) {
      assert.equal(isLinkPreviewUserAgent(userAgent), false, String(userAgent));
    }
  });

  it("doesn't change the CDN redirect for link files: only ShareX and Telegram among the bots", () => {
    const file = { mimetype: 'image/png' };
    const withBrowserHeaders = (userAgent) => new Headers({ 'user-agent': userAgent, accept: 'text/html', 'accept-language': 'en' });
    for (const userAgent of Object.values(PREVIEW_FETCHER_AGENTS)) {
      // the fetchers redirect exactly as any other client with the same headers (here: not at all)
      assert.equal(shouldRedirectToCdn(withBrowserHeaders(userAgent), file), false, userAgent);
    }
    assert.equal(shouldRedirectToCdn(withBrowserHeaders('ShareX/15.0'), file), true);
    assert.equal(shouldRedirectToCdn(withBrowserHeaders('TelegramBot (like TwitterBot)'), file), true);
    assert.equal(shouldRedirectToCdn(new Headers({ 'user-agent': 'Discordbot/2.0' }), file), false);
    assert.equal(shouldRedirectToCdn(new Headers({ 'user-agent': 'WhatsApp/2.23' }), file), true);
  });

  it('answers 403, private no-store, a short text and nothing else', async () => {
    const response = botRefusalResponse();
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), BOT_REFUSAL_TEXT);
    assert.equal(BOT_REFUSAL_TEXT, "This file has a view limit and can't be previewed.");
    assert.equal(await botRefusalResponse('HEAD').text(), '');
  });
});


describe('decideFileShell with a view limit', () => {
  it('a link file is the limited shell: no name, no URL, no media, never cached', () => {
    const shell = decideFileShell({ lookup: limited(THREE), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.equal(shell.redirect, undefined);
    assert.deepEqual([shell.page, shell.state, shell.status, shell.dataId], ['file', 'limited', 200, 'file-data']);
    assert.deepEqual(shell.data, { vanity: 'img1', view_limited: true, views_remaining: 2 });
    assert.equal(shell.cacheControl, 'private, no-store');
    assert.ok(shell.meta.includes(`content="${LIMITED_FILE_TITLE}"`));
    assert.doesNotMatch(shell.meta, /og:image|og:video|og:audio|twitter:image|twitter:player|cat\.png|cdn\.files\.gg/);
  });

  it('never redirects to the CDN, and link-preview bots are refused', () => {
    for (const [name, headers] of Object.entries(BOT_HEADERS)) {
      const shell = decideFileShell({ lookup: limited(THREE), vanity: 'img1', headers: new Headers(headers), nowMs: NOW });
      assert.deepEqual(shell, { refuse: 'view-limited' }, name);
    }
    // the headers that redirect a plain link file (no Accept-Language, no Accept, video/*) don't here
    for (const headers of [{ 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' }]) {
      const shell = decideFileShell({ lookup: limited(THREE), vanity: 'img1', headers: new Headers(headers), nowMs: NOW });
      assert.equal(shell.redirect, undefined);
      assert.equal(shell.state, 'limited');
    }
  });

  it('a password file keeps its lock screen, with the views left', () => {
    const shell = decideFileShell({
      lookup: limited({ limit: 2, used: 0, action: 'private' }, { visibility: 'password', show_name_when_locked: true }),
      vanity: 'img1', headers: browser, nowMs: NOW,
    });
    assert.deepEqual([shell.state, shell.status], ['locked', 200]);
    assert.deepEqual(shell.data, { vanity: 'img1', protected: 'password', view_limited: true, views_remaining: 2, filename: 'cat.png' });
    assert.ok(shell.meta.includes(`content="${LOCKED_FILE_TITLE}"`));
    assert.doesNotMatch(shell.meta, /og:image/);
    const bot = decideFileShell({
      lookup: limited({ limit: 2, used: 0, action: 'private' }, { visibility: 'password' }),
      vanity: 'img1', headers: new Headers(BOT_HEADERS.discord), nowMs: NOW,
    });
    assert.deepEqual(bot, { refuse: 'view-limited' });
  });

  it('a used-up or unreadable limit is missing, for browsers and bots alike', () => {
    for (const viewLimit of [{ limit: 2, used: 2, action: 'expire' }, { limit: 'x' }]) {
      for (const headers of [browser, new Headers(BOT_HEADERS.discord)]) {
        const shell = decideFileShell({ lookup: limited(viewLimit), vanity: 'img1', headers, nowMs: NOW });
        assert.deepEqual([shell.state, shell.status, shell.data], ['missing', 404, null]);
      }
    }
  });

  it('private stays missing, pending and removed keep their shells', () => {
    assert.equal(decideFileShell({ lookup: limited(THREE, { visibility: 'private' }), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'missing');
    assert.equal(decideFileShell({ lookup: limited(THREE, {}, { safety: { state: 'pending', reason: null } }), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'pending');
    assert.equal(decideFileShell({ lookup: limited(THREE, {}, { safety: { state: 'removed', reason: 'terms' } }), vanity: 'img1', headers: browser, nowMs: NOW }).state, 'removed');
  });

  it('without a limit nothing changes', () => {
    const shell = decideFileShell({ lookup: limited(null), vanity: 'img1', headers: browser, nowMs: NOW });
    assert.equal(shell.state, 'file');
    const redirect = decideFileShell({ lookup: limited(null), vanity: 'img1', headers: new Headers(BOT_HEADERS['accept image/*']), nowMs: NOW });
    assert.equal(redirect.redirect, imageFile.cdn_url);
  });
});
