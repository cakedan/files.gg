// Regional rules (docs/redesign/contracts/milestone-7.md §11): the visitor's country, the
// ADULT_BLOCKED_COUNTRIES setting, the X-Filesgg-Client-Country header and the `region` shells.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  adultBlocked,
  adultBlockedCountries,
  adultBlockedFor,
  clientCountry,
  DEFAULT_ADULT_BLOCKED_COUNTRIES,
  normalizeCountry,
} from '../worker/utils/region.js';
import {
  CLIENT_COUNTRY_HEADER,
  CLIENT_IP_HEADER,
  ORIGIN_SECRET_HEADER,
  originRequestHeaders,
} from '../worker/utils/security.js';
import { decideAlbumShell, decideFileShell } from '../worker/utils/viewer.js';


const NOW = Date.UTC(2026, 10, 25, 12);
const NOW_S = NOW / 1000;
const browser = new Headers({ 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'accept-language': 'en' });
const sharex = new Headers({ 'user-agent': 'ShareX/15.0' });


describe('ADULT_BLOCKED_COUNTRIES', () => {
  it('unset or empty is GB', () => {
    assert.deepEqual(DEFAULT_ADULT_BLOCKED_COUNTRIES, ['GB']);
    for (const env of [undefined, null, {}, { ADULT_BLOCKED_COUNTRIES: '' }, { ADULT_BLOCKED_COUNTRIES: '  ' },
      { ADULT_BLOCKED_COUNTRIES: ',' }, { ADULT_BLOCKED_COUNTRIES: 42 }]) {
      assert.deepEqual(adultBlockedCountries(env), ['GB'], JSON.stringify(env));
    }
  });

  it('is comma-separated, with spaces and lower case allowed', () => {
    assert.deepEqual(adultBlockedCountries({ ADULT_BLOCKED_COUNTRIES: 'US' }), ['US']);
    assert.deepEqual(adultBlockedCountries({ ADULT_BLOCKED_COUNTRIES: 'gb, de ,FR' }), ['GB', 'DE', 'FR']);
    assert.deepEqual(adultBlockedCountries({ ADULT_BLOCKED_COUNTRIES: ' gb,,gb, ' }), ['GB']);
  });

  it('ignores anything that is not a two-letter code (check-env refuses those)', () => {
    assert.deepEqual(adultBlockedCountries({ ADULT_BLOCKED_COUNTRIES: 'GBR, U1, DE' }), ['DE']);
    assert.deepEqual(adultBlockedCountries({ ADULT_BLOCKED_COUNTRIES: 'GBR' }), ['GB']);
  });

  it('adultBlocked: only a known country on the list', () => {
    assert.equal(adultBlocked({}, 'GB'), true);
    assert.equal(adultBlocked({}, 'gb'), true);
    assert.equal(adultBlocked({}, 'US'), false);
    assert.equal(adultBlocked({ ADULT_BLOCKED_COUNTRIES: 'us, de' }, 'US'), true);
    assert.equal(adultBlocked({ ADULT_BLOCKED_COUNTRIES: 'us, de' }, 'GB'), false);
    for (const unknown of [null, undefined, '', 'XX', 'T1', 'GBR']) {
      assert.equal(adultBlocked({ ADULT_BLOCKED_COUNTRIES: 'GB,XX,T1' }, unknown), false, String(unknown));
    }
  });
});


describe('the visitor country', () => {
  it('comes from request.cf.country only, never a header', () => {
    assert.equal(clientCountry({ cf: { country: 'GB' } }), 'GB');
    assert.equal(clientCountry({ cf: { country: 'de' } }), 'DE');
    const spoofed = new Request('https://files.gg/x', { headers: { 'cf-ipcountry': 'GB', 'x-filesgg-client-country': 'GB' } });
    assert.equal(clientCountry(spoofed), null);
    assert.equal(clientCountry(null), null);
    assert.equal(clientCountry({ cf: {} }), null);
  });

  it('XX (unknown) and T1 (Tor) are unknown, like anything malformed', () => {
    for (const value of ['XX', 'T1', 't1', '', 'GBR', '1A', 42, null]) {
      assert.equal(normalizeCountry(value), null, String(value));
    }
    assert.equal(normalizeCountry(' us '), 'US');
  });

  it('adultBlockedFor reads the request country against the setting', () => {
    assert.equal(adultBlockedFor({}, { cf: { country: 'GB' } }), true);
    assert.equal(adultBlockedFor({}, { cf: { country: 'US' } }), false);
    assert.equal(adultBlockedFor({}, { cf: { country: 'T1' } }), false);
    assert.equal(adultBlockedFor({ ADULT_BLOCKED_COUNTRIES: 'US' }, { cf: { country: 'US' } }), true);
  });
});


describe('X-Filesgg-Client-Country (§11.1)', () => {
  const incoming = () => new Headers({
    'cf-connecting-ip': '203.0.113.5',
    'cf-ipcountry': 'FR',
    'x-filesgg-client-country': 'FR',
  });

  it('is the given country, with the secret, and the client copies are gone', () => {
    const { headers } = originRequestHeaders(incoming(), 's3cret', undefined, { country: 'GB' });
    assert.equal(headers.get(CLIENT_COUNTRY_HEADER), 'GB');
    assert.equal(headers.get(CLIENT_IP_HEADER), '203.0.113.5');
    assert.equal(headers.has('cf-ipcountry'), false);
  });

  it('is never taken from the incoming headers: no country, no header', () => {
    for (const country of [undefined, null, '', 'XX', 'T1', 'nope']) {
      const { headers } = originRequestHeaders(incoming(), 's3cret', undefined, { country });
      assert.equal(headers.has(CLIENT_COUNTRY_HEADER), false, String(country));
      assert.equal(headers.has('cf-ipcountry'), false);
    }
  });

  it('is never sent without the secret, and client copies are still removed', () => {
    const { headers, trusted } = originRequestHeaders(incoming(), '', undefined, { country: 'GB' });
    assert.equal(trusted, false);
    assert.equal(headers.has(ORIGIN_SECRET_HEADER), false);
    assert.equal(headers.has(CLIENT_COUNTRY_HEADER), false);
    assert.equal(headers.has('cf-ipcountry'), false);
  });
});


const nsfwFile = {
  id: '1111', vanity: 'adult', kind: 'image', filename: 'secret-name.png', mimetype: 'image/png', extension: 'png',
  size: 123456, width: 800, height: 600, cdn_url: 'https://cdn.files.gg/files/adult.png', url: 'https://files.gg/adult.png',
  uploaded_at: NOW_S - 1, expires_at: null, nsfw: true,
  assets: { thumb: { url: 'https://cdn.files.gg/previews/thumb/adult.webp?v=1' } },
  thumbnail: { url: 'https://cdn.files.gg/previews/thumb/adult.webp?v=1', type: 'thumb' },
};
const fileLookup = ({ file = nsfwFile, visibility = 'link', state = 'ok', reason = null, extra = {} } = {}) => ({
  status: 'found',
  data: {
    file,
    access: { visibility, access_version: 0, unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: true },
    safety: { state, reason },
    serve_inline: true,
    ...extra,
  },
});
const fileShell = (options, { adultBlocked = true, headers = browser } = {}) => decideFileShell({
  lookup: fileLookup(options), vanity: 'adult', headers, nowMs: NOW, adultBlocked,
});

const REGION_FILE = {
  page: 'file', state: 'region', dataId: 'file-data', data: { vanity: 'adult' }, status: 451, cacheControl: 'no-store',
};


describe('file shells from a blocked country (§11.2)', () => {
  it('an NSFW file is the region shell: 451, no-store, the vanity only, the default meta', () => {
    const shell = fileShell();
    assert.deepEqual(shell, REGION_FILE);
    assert.equal(shell.meta, undefined);
    assert.doesNotMatch(JSON.stringify(shell), /secret-name|123456|cdn\.files\.gg|thumb/);
  });

  it('the same for bots (no redirect), password files (no lock) and view-limited files', () => {
    assert.deepEqual(fileShell({}, { headers: sharex }), REGION_FILE);
    assert.deepEqual(fileShell({ visibility: 'password' }), REGION_FILE);
    const viewLimit = { limit: 3, used: 1, action: 'expire' };
    assert.deepEqual(fileShell({ extra: { view_limit: viewLimit } }), REGION_FILE);
    assert.deepEqual(fileShell({ extra: { view_limit: viewLimit } }, { headers: sharex }), REGION_FILE);
    assert.deepEqual(fileShell({ state: 'pending' }), REGION_FILE);
  });

  it('missing, removed and hidden keep their own states', () => {
    assert.equal(fileShell({ visibility: 'private' }).state, 'missing');
    assert.equal(fileShell({ state: 'blocked' }).state, 'missing');
    assert.equal(fileShell({ file: { ...nsfwFile, expires_at: NOW_S - 1 } }).state, 'missing');
    assert.equal(fileShell({ extra: { view_limit: { limit: 1, used: 1, action: 'expire' } } }).state, 'missing');
    assert.deepEqual([fileShell({ state: 'removed', reason: 'terms' }).state, fileShell({ state: 'removed', reason: 'terms' }).status], ['removed', 410]);
    assert.equal(fileShell({ state: 'hidden', reason: 'review' }).state, 'removed');
    assert.equal(decideFileShell({ lookup: { status: 'missing' }, vanity: 'adult', headers: browser, nowMs: NOW, adultBlocked: true }).state, 'missing');
    assert.equal(decideFileShell({ lookup: { status: 'unavailable' }, vanity: 'adult', headers: browser, nowMs: NOW, adultBlocked: true }).state, 'unavailable');
  });

  it('a file that is not NSFW is served as before', () => {
    const clean = { ...nsfwFile, nsfw: false };
    const shell = fileShell({ file: clean });
    assert.deepEqual([shell.state, shell.status], ['file', 200]);
    assert.equal(fileShell({ file: clean }, { headers: sharex }).redirect, clean.cdn_url);
  });

  it('not blocked: an NSFW file is served as before', () => {
    const shell = fileShell({}, { adultBlocked: false });
    assert.deepEqual([shell.state, shell.status, shell.data.filename], ['file', 200, 'secret-name.png']);
    assert.equal(fileShell({ visibility: 'password' }, { adultBlocked: false }).state, 'locked');
  });
});


describe('album shells from a blocked country (§11.2)', () => {
  const clean = { ...nsfwFile, id: '1', vanity: 'c1', nsfw: false, visibility: 'link' };
  const adult = { ...nsfwFile, id: '2', vanity: 'a2', visibility: 'link' };
  const albumLookup = ({ nsfw = false, items = [clean, adult], visibility = 'link', state = 'ok', pending = 0 } = {}) => ({
    status: 'found',
    data: {
      album: {
        id: '900', vanity: 'alb1', title: 'Secret title', description: 'Secret description', url: 'https://files.gg/a/alb1',
        nsfw, items, collage: { url: 'https://cdn.files.gg/albums/collage/alb1.webp?v=5' },
      },
      access: { visibility, access_version: 0, show_name_when_locked: true }, items_access: {},
      safety: { state, reason: state === 'ok' ? null : 'terms' }, pending_count: pending,
    },
  });
  const albumShell = (options, adultBlocked = true) => decideAlbumShell({ lookup: albumLookup(options), vanity: 'alb1', nowMs: NOW, adultBlocked });
  const REGION_ALBUM = {
    page: 'album', state: 'region', dataId: 'album-data', data: { vanity: 'alb1' }, status: 451, cacheControl: 'no-store',
  };

  it('an album with an NSFW item, or marked, is the region shell with nothing of the album', () => {
    const shell = albumShell();
    assert.deepEqual(shell, REGION_ALBUM);
    assert.doesNotMatch(JSON.stringify(shell), /Secret|collage|secret-name/);
    assert.deepEqual(albumShell({ nsfw: true, items: [clean] }), REGION_ALBUM);
    assert.deepEqual(albumShell({ visibility: 'password' }), REGION_ALBUM);
  });

  it('missing, removed and hidden first; pending after', () => {
    assert.equal(albumShell({ visibility: 'private' }).state, 'missing');
    assert.equal(albumShell({ nsfw: true, items: [] }).state, 'missing');
    assert.deepEqual([albumShell({ state: 'removed' }).state, albumShell({ state: 'removed' }).status], ['removed', 410]);
    assert.equal(albumShell({ state: 'hidden' }).state, 'removed');
    assert.deepEqual(albumShell({ nsfw: true, items: [], pending: 2 }), REGION_ALBUM);
    assert.deepEqual(albumShell({ state: 'pending' }), REGION_ALBUM);
  });

  it('only shown items count, and a clean album is served as before', () => {
    assert.equal(albumShell({ items: [clean, { ...adult, visibility: 'private' }] }).state, 'album');
    assert.equal(albumShell({ items: [clean] }).state, 'album');
    assert.equal(albumShell({ items: [], pending: 2 }).state, 'pending');
  });

  it('not blocked: an NSFW album is served as before', () => {
    const shell = albumShell({}, false);
    assert.deepEqual([shell.state, shell.status, shell.data.nsfw], ['album', 200, true]);
  });
});
