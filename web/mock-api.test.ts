import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  cdnSignature,
  crc32,
  makeToken,
  MOCK_API_PREFIX,
  MOCK_PASSWORD,
  mockAgeSession,
  mockApiMiddleware,
  mockDiscordCode,
  mockLastEmailToken,
  mockSessionCookie,
  pkceChallenge,
  signCdnUrl,
  signLabelled,
  signStaffUrl,
  signToken,
  tokenValid,
  verifyLabelled,
  verifyToken,
} from './mock-api';

// The milestone-2 §1 vectors: unlock tokens keep that format (the API now signs them with its own key).
const SECRET = 'test-cdn-token-secret';

describe('mock API signed CDN URLs match milestone-3 §3', () => {
  it.each([
    ['/files/abc123.png', 1795603600, 'file:1234567890123456789:0', '2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8'],
    ['/previews/thumb/abc123.webp', 1795603600, 'file:1234567890123456789:0', 'fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0'],
    ['/files/abcd/xyz.png', 1795603600, 'file:1234567890123456790:2', 'oBzsm8vQj1Gu63_mqxqJxnryvfOrRIn_lFlRFzE7TJA'],
    ['/files/abc123.png', 1795603600, 'album:987654321098765432:3', 'qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68'],
    ['/albums/download/Ab3dE6gH.zip', 1796204800, 'album:987654321098765432:3', 'wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA'],
    ['/files/abc123.png', 1795603600, 'file:1234567890123456789:1', 'Fx-ceAVJ1NUckKl8KkrfXvv9EjlAht92rlHCfcN4RUs'],
  ])('signs %s until %i for %s', (path, expires, grant, sig) => {
    expect(cdnSignature(path, expires, grant)).toBe(sig);
  });

  it('signs over the path only, keeping ?v= and adding album= for album items', () => {
    expect(signCdnUrl('https://cdn.files.gg/files/abc123.png', 1795603600, 'album:987654321098765432:3', 'Ab3dE6gH')).toBe(
      'https://cdn.files.gg/files/abc123.png?album=Ab3dE6gH&expires=1795603600&sig=qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68',
    );
    expect(signCdnUrl('https://cdn.files.gg/previews/thumb/abc123.webp?v=5', 1795603600, 'file:1234567890123456789:0')).toBe(
      'https://cdn.files.gg/previews/thumb/abc123.webp?v=5&expires=1795603600&sig=fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0',
    );
    expect(signCdnUrl('data:image/svg+xml,x', 1, 'file:1:0')).toBe('data:image/svg+xml,x');
  });
});

describe('mock API tokens keep the milestone-2 §1 format', () => {
  it.each([
    [
      { e: 1795603600, k: 'file', s: 'unlock', t: '1234567890123456789', u: 1795600000, v: 0 },
      'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjB9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk',
    ],
    [
      { e: 1796204800, k: 'album', s: 'unlock', t: '987654321098765432', u: 1795600000, v: 3 },
      'eyJlIjoxNzk2MjA0ODAwLCJrIjoiYWxidW0iLCJzIjoidW5sb2NrIiwidCI6Ijk4NzY1NDMyMTA5ODc2NTQzMiIsInUiOjE3OTU2MDAwMDAsInYiOjN9.363h20AIfnXPJ20FngplD6_ARO_pidniwnoIaD0Lebk',
    ],
    [
      { e: 1795603600, k: 'file', s: 'owner', t: '1234567890123456789', u: 1795600000, v: 2 },
      'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJvd25lciIsInQiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5IiwidSI6MTc5NTYwMDAwMCwidiI6Mn0.S7b7xKQg5Cu19qkZa4BGRNLeZgwmnVmqGjN_1p4nFiE',
    ],
  ] as const)('signs %o', (claims, token) => {
    expect(signToken(claims, SECRET)).toBe(token);
    expect(verifyToken(token, SECRET)).toEqual(claims);
  });

  it('rejects the tampered vector', () => {
    const tampered =
      'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjF9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk';
    expect(verifyToken(tampered, SECRET)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Milestone 3 endpoints, through the real middleware
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
}

/** Signed in as Mock User (42) through a session cookie (milestone-6 §3). */
const USER = { cookie: mockSessionCookie('42') };

/** Writes carry the CSRF header like the web client (milestone-6 §3.6), unless a test overrides it. */
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = USER): Promise<Reply> {
  const payload = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
  const csrf = method === 'GET' || method === 'HEAD' ? {} : { 'x-filesgg-csrf': '1' };
  const req = Object.assign(Readable.from(payload), {
    method,
    url: `${MOCK_API_PREFIX}${path}`,
    headers: { host: 'localhost:5173', 'content-type': 'application/json', ...csrf, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return new Promise((resolve) => {
    const out: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader: (key: string, value: string) => (out[key.toLowerCase()] = value),
      end: (text?: string) => {
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          // Plain text (raw files).
        }
        resolve({ status: res.statusCode, body: parsed, headers: out });
      },
    };
    mockApiMiddleware()(req as never, res as never, () => resolve({ status: 404, body: 'next', headers: {} }));
  });
}

describe('mock API: owner library (milestone-3 §6)', () => {
  it('lists the seeded library with filters, sort, pagination and totals', async () => {
    const all = await call('GET', '/users/@me/files?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.total.count).toBe(all.body.count);
    const kinds = new Set(all.body.items.map((file: { kind: string }) => file.kind));
    expect([...kinds].sort()).toEqual(['audio', 'file', 'image', 'pdf', 'text', 'video']);
    expect(all.body.items.some((file: { processing: boolean }) => file.processing)).toBe(true);

    const images = await call('GET', '/users/@me/files?type=image&sort_by=-size&limit=3');
    expect(images.body.items).toHaveLength(3);
    expect(images.body.items.every((file: { kind: string }) => file.kind === 'image')).toBe(true);
    const sizes = images.body.items.map((file: { size: number }) => file.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(images.body.total.count).toBe(all.body.count);

    const protectedFiles = await call('GET', '/users/@me/files?visibility=private');
    expect(protectedFiles.body.items.every((file: { visibility: string }) => file.visibility === 'private')).toBe(true);
    const temporary = await call('GET', '/users/@me/files?temporary=true&limit=100');
    expect(temporary.body.items.every((file: { expires_at: number | null }) => file.expires_at !== null)).toBe(true);
    const search = await call('GET', '/users/@me/files?query=TONE');
    expect(search.body.count).toBe(3);
  });

  it('returns the owner file shape: snake_case, assets with ?v=, thumbnail, snippet, owner fields', async () => {
    const { body } = await call('GET', '/users/@me/files?limit=100');
    const pdf = body.items.find((file: { filename: string }) => file.filename === 'files-gg-sample.pdf');
    expect(pdf).toMatchObject({ kind: 'pdf', cdn_url: 'http://localhost:5173/fixtures/sample.pdf', thumbnail: { type: 'thumb' }, access_version: 0 });
    expect(pdf.uploaded_at).toBeLessThan(Date.now() / 1000);
    for (const key of ['cdnUrl', 'uploadedAt', 'expiresAt', 'urls', 'access_token']) expect(pdf).not.toHaveProperty(key);
    expect(pdf.albums).toEqual([expect.objectContaining({ title: 'Client drafts' })]);
    expect(pdf.assets.thumb.url).toMatch(/\?v=\d+$/);
    const video = body.items.find((file: { filename: string }) => file.filename === 'sunset-timelapse.mp4');
    expect(video.thumbnail.type).toBe('poster');
    const text = body.items.find((file: { filename: string }) => file.filename === 'README.md');
    expect(text.media.snippet).toContain('# files.gg');
    const raw = await call('GET', `/raw/${text.vanity}`);
    expect(raw.body).toContain('# files.gg');
    const photo = body.items.find((file: { filename: string }) => file.filename === 'lisbon-tram.png');
    expect(photo.albums.map((album: { title: string }) => album.title)).toEqual(['Lisbon, November', 'Client drafts']);
    expect(photo.assets['thumb-2x'].url).toMatch(/\?v=\d+$/);
    const heic = body.items.find((file: { filename: string }) => file.filename === 'IMG_4032.heic');
    expect(Object.keys(heic.assets)).toContain('display');
  });

  it('signs a protected file\'s URLs for its owner for 1 h, and leaves link files plain', async () => {
    const { body } = await call('GET', '/users/@me/files?limit=100');
    const locked = body.items.find((file: { filename: string }) => file.filename === 'belem-tower.png');
    const expires = Number(new URL(locked.cdn_url).searchParams.get('expires'));
    expect(expires - Date.now() / 1000).toBeGreaterThan(3590);
    expect(expires - Date.now() / 1000).toBeLessThanOrEqual(3600);
    expect(new URL(locked.cdn_url).searchParams.get('sig')).toBe(cdnSignature(new URL(locked.cdn_url).pathname, expires, `file:${locked.id}:0`));
    expect(locked.assets.thumb.url).toMatch(/\?v=\d+&expires=\d+&sig=/);
    expect(locked.thumbnail.url).toBe(locked.assets.thumb.url);
    const link = body.items.find((file: { filename: string }) => file.filename === 'lisbon-tram.png');
    expect(link.cdn_url).not.toContain('sig=');
  });

  it('unlock, view and refresh return the payload with signed URLs plus token and expires_at', async () => {
    const turnstile = 'XXXX.DUMMY.TOKEN.XXXX';
    const unlock = await call('POST', '/access/unlock/files/locked1234', { password: 'files.gg', turnstile_token: turnstile }, {});
    expect(unlock.status).toBe(200);
    expect(unlock.body).toMatchObject({ token: expect.any(String), expires_at: expect.any(Number), file: { filename: 'holiday.png' } });
    const url = new URL(unlock.body.file.cdn_url);
    expect(url.searchParams.get('expires')).toBe(String(unlock.body.expires_at));
    expect(url.searchParams.get('sig')).toBe(cdnSignature(url.pathname, unlock.body.expires_at, 'file:1234567890123456789:0'));
    expect(unlock.body.file.cdn_url).not.toContain('t=');

    const view = await call('GET', '/access/view/files/locked1234', undefined, { 'x-filesgg-access': unlock.body.token });
    expect(view.body).toMatchObject({ token: unlock.body.token, expires_at: unlock.body.expires_at, file: { cdn_url: unlock.body.file.cdn_url } });
    const refresh = await call('POST', '/access/refresh/files/locked1234', { token: unlock.body.token }, {});
    expect(refresh.body).toMatchObject({ token: expect.any(String), expires_at: expect.any(Number), file: { filename: 'holiday.png' } });
    expect(new URL(refresh.body.file.cdn_url).searchParams.get('expires')).toBe(String(refresh.body.expires_at));

    const album = await call('POST', '/access/unlock/albums/lockedalbum', { password: 'files.gg', turnstile_token: turnstile }, {});
    expect(album.body.album.download_url).toMatch(/^https:\/\/cdn\.files\.gg\/albums\/download\/lockedalbum\.zip\?expires=\d+&sig=/);
    for (const item of album.body.album.items) expect(item.cdn_url).toMatch(/\?album=lockedalbum&expires=\d+&sig=/);
  });

  it('serves the access routes with the vanity last; the old paths are 404 (milestone-6 §20.1)', async () => {
    const turnstile = 'XXXX.DUMMY.TOKEN.XXXX';
    const old = [
      ['POST', '/files/locked1234/unlock', { password: 'files.gg', turnstile_token: turnstile }],
      ['POST', '/files/locked1234/unlock/refresh', { token: 'x' }],
      ['GET', '/files/locked1234/view', undefined],
      ['POST', '/albums/lockedalbum/unlock', { password: 'files.gg', turnstile_token: turnstile }],
      ['GET', '/albums/lockedalbum/view', undefined],
    ] as const;
    for (const [method, path, body] of old) {
      const response = await call(method, path, body, {});
      expect(response.status, path).toBe(404);
    }
    const unlocked = await call('POST', '/access/unlock/files/locked1234', { password: 'files.gg', turnstile_token: turnstile }, {});
    expect(unlocked.status).toBe(200);
    expect((await call('POST', '/access/refresh/albums/lockedalbum', { token: 'x' }, {})).body.code).toBe('UNLOCK_EXPIRED');
    expect((await call('GET', '/access/view/files/nope', undefined, {})).status).toBe(404);
  });

  it('renames, sets expiry in bulk, changes access with one shared generated password, and deletes', async () => {
    const { body } = await call('GET', '/users/@me/files?type=other&limit=100');
    const [a, b] = body.items as Array<{ id: string; extension: string }>;
    const renamed = await call('PATCH', `/users/@me/files/${a!.id}`, { filename: 'renamed' });
    expect(renamed.body.filename).toBe(`renamed.${a!.extension}`);

    const expiry = await call('POST', '/users/@me/files/expiry', { file_ids: [a!.id, b!.id], expires_in: 3600 });
    expect(expiry.body.items.map((file: { expires_at: number }) => file.expires_at > Date.now() / 1000)).toEqual([true, true]);
    const forever = await call('POST', '/users/@me/files/expiry', { file_ids: [a!.id], expires_in: null });
    expect(forever.body.items[0].expires_at).toBeNull();

    const access = await call('POST', '/users/@me/files/access', { file_ids: [a!.id, b!.id], visibility: 'password', generate_password: true });
    expect(access.body.password).toMatch(/^[a-z]+(-[a-z]+){3}$/);
    expect(access.body.items.map((file: { visibility: string; access_version: number }) => [file.visibility, file.access_version])).toEqual([
      ['password', 1],
      ['password', 1],
    ]);
    // The bulk password unlocks both.
    const unlock = await call('POST', `/access/unlock/files/${access.body.items[1].vanity}`, { password: access.body.password, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, {});
    expect(unlock.status).toBe(200);

    const pass = await call('POST', `/users/@me/files/${a!.id}/pass`);
    expect(pass.body.url).toContain('#t=');

    const deleted = await call('POST', '/users/@me/files/delete', { file_ids: [b!.id, '1'] });
    expect(deleted.body.deleted).toEqual([b!.id]);
    expect((await call('DELETE', `/users/@me/files/${b!.id}`)).status).toBe(404);
  });
});

describe('mock API: albums (milestone-3 §6)', () => {
  it('creates, reorders, captions, hides protected items in a link album, and deletes with files', async () => {
    const { body } = await call('GET', '/users/@me/files?type=image&limit=100');
    const link = body.items.filter((file: { visibility: string; processing: boolean }) => file.visibility === 'link' && !file.processing).slice(0, 2);
    const locked = body.items.find((file: { visibility: string }) => file.visibility === 'password');
    const ids = [...link.map((file: { id: string }) => file.id), locked.id];

    const created = await call('POST', '/users/@me/albums', { title: 'Test', file_ids: ids });
    expect(created.status).toBe(201);
    expect(created.body.items.map((item: { shown: boolean }) => item.shown)).toEqual([true, true, false]);
    const albumId = created.body.id;

    const reordered = await call('PUT', `/users/@me/albums/${albumId}/files`, { file_ids: [...ids].reverse() });
    expect(reordered.body.items.map((item: { id: string; position: number }) => [item.id, item.position])).toEqual(
      [...ids].reverse().map((id, position) => [id, position]),
    );
    const captioned = await call('PATCH', `/users/@me/albums/${albumId}/files/${ids[0]}`, { caption: 'Hi\u0007 there' });
    expect(captioned.body.items.find((item: { id: string }) => item.id === ids[0]).caption).toBe('Hi there');

    const foreign = await call('POST', `/users/@me/albums/${albumId}/files`, { file_ids: ['999'] });
    expect(foreign).toMatchObject({ status: 400, body: { code: 'INVALID_ALBUM_FILES', file_ids: ['999'] } });

    const publicView = await call('GET', `/albums/${created.body.vanity}`, undefined, {});
    expect(publicView.body.items).toHaveLength(2);

    expect(created.body.download_url).toBe(`https://cdn.files.gg/albums/download/${created.body.vanity}.zip`);
    const protectedAlbum = await call('PATCH', `/users/@me/albums/${albumId}`, { visibility: 'password', generate_password: true });
    expect(protectedAlbum.body.download_url).toMatch(/\.zip\?expires=\d+&sig=/);
    expect(protectedAlbum.body.password).toBeTruthy();
    expect(protectedAlbum.body.items.every((item: { shown: boolean }) => item.shown)).toBe(true);
    expect((await call('GET', `/albums/${created.body.vanity}`, undefined, {})).body).toEqual({ vanity: created.body.vanity, protected: 'password' });

    const list = await call('GET', '/users/@me/albums?query=test');
    expect(list.body.items[0]).toMatchObject({ id: albumId, count: 3, visibility: 'password' });

    expect((await call('DELETE', `/users/@me/albums/${albumId}?delete_files=true`)).status).toBe(204);
    expect((await call('GET', `/users/@me/albums/${albumId}`)).body.code).toBe('UNKNOWN_ALBUM');
    const after = await call('GET', '/users/@me/files?limit=100');
    expect(after.body.items.some((file: { id: string }) => ids.includes(file.id))).toBe(false);
  });

  it('lets anonymous callers make an album only from their own recent uploads', async () => {
    const anon = { 'x-fingerprint': 'fp-test' };
    const seeded = await call('GET', '/users/@me/files?limit=1');
    const denied = await call('POST', '/users/@me/albums', { file_ids: [seeded.body.items[0].id] }, anon);
    expect(denied).toMatchObject({ status: 403, body: { code: 'ANONYMOUS_ALBUM_NOT_ALLOWED' } });
    const limits = await call('GET', '/users/@me/limits', undefined, anon);
    expect(limits.body).toMatchObject({ album_max_files: 50, albums_max: null });
  });
});

// ---------------------------------------------------------------------------
// Milestone 4: trust & safety
// ---------------------------------------------------------------------------

const MEMBER = { cookie: mockSessionCookie('45') };
const MODERATOR = { cookie: mockSessionCookie('43') };
type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const byFilename = (items: Item[], filename: string) => items.find((file) => file.filename === filename)!;

describe('mock API staff grants match milestone-4 §14.1', () => {
  it.each([
    ['https://cdn.files.gg/files/abc123.png', 'xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk'],
    ['https://cdn.files.gg/previews/thumb/abc123.webp', 'iFEB3jhXpXydlpjhc4oefiKwO4n2afK7iXj3MJ4mIVY'],
  ])('signs %s', (url, sig) => {
    expect(signStaffUrl(url, '555555555555555555', '1234567890123456789', 1795603600)).toBe(`${url}?staff=555555555555555555&expires=1795603600&sig=${sig}`);
  });

  it('a grant for another staff id gives a different signature', () => {
    expect(cdnSignature('/files/abc123.png', 1795603600, 'staff:555555555555555556:1234567890123456789')).toBe('yw_60Ca7UMA3Y07HsKVPtC9j-1TwPAo3rx7Ne4r2Epw');
  });
});

describe('mock API: owner safety and NSFW (milestone-4 §4, §6)', () => {
  it('owner files carry safety, nsfw and warnings for every state', async () => {
    const { body } = await call('GET', '/users/@me/files?limit=100');
    expect(byFilename(body.items, 'meme-dump.png').safety).toMatchObject({ state: 'hidden', reason: 'harassment', notice_id: expect.any(String) });
    expect(byFilename(body.items, 'leaked-episode.mp4').safety).toMatchObject({ state: 'removed', reason: 'copyright' });
    expect(byFilename(body.items, 'cracked-tool.zip').safety).toMatchObject({ state: 'blocked', reason: 'malware' });
    expect(byFilename(body.items, 'scan-in-progress.png').safety.state).toBe('pending');
    expect(byFilename(body.items, 'backup-encrypted.zip').warnings).toEqual(['encrypted_archive']);
    expect(byFilename(body.items, 'beach-day.png')).toMatchObject({ nsfw: true, safety: { nsfw_source: 'uploader', nsfw_locked: false } });
    expect(byFilename(body.items, 'night-shoot.png')).toMatchObject({ nsfw: true, safety: { nsfw_source: 'auto', nsfw_locked: true, nsfw_review: 'none' } });
    expect(body.items.some((file: Item) => file.filename === 'free-robux.zip')).toBe(false);
  });

  it('marks and unmarks, refuses to unmark a locked file, and takes one review request', async () => {
    const { body } = await call('GET', '/users/@me/files?limit=100');
    const plain = byFilename(body.items, 'pastel-de-nata.png');
    const auto = byFilename(body.items, 'night-shoot.png');
    expect((await call('PATCH', `/users/@me/files/${plain.id}`, { nsfw: true })).body).toMatchObject({ nsfw: true, safety: { nsfw_source: 'uploader' } });
    expect((await call('PATCH', `/users/@me/files/${plain.id}`, { nsfw: false })).body.nsfw).toBe(false);
    expect((await call('PATCH', `/users/@me/files/${auto.id}`, { nsfw: false })).body.code).toBe('NSFW_LOCKED');
    const bulk = await call('POST', '/users/@me/files/nsfw', { file_ids: [plain.id, auto.id], nsfw: false });
    expect(bulk.body.skipped).toEqual([auto.id]);
    expect((await call('POST', `/users/@me/files/${auto.id}/nsfw-review`, { message: 'Just a dark photo.' })).status).toBe(202);
    expect((await call('POST', `/users/@me/files/${auto.id}/nsfw-review`, {})).body.code).toBe('APPEAL_NOT_ALLOWED');
    expect((await call('GET', `/users/@me/files/${auto.id}`)).body.safety.nsfw_review).toBe('open');
  });

  it('keeps pending, hidden and removed items out of an album and its nsfw follows shown items', async () => {
    const { body } = await call('GET', '/users/@me/albums?query=lisbon');
    const album = (await call('GET', `/users/@me/albums/${body.items[0].id}`)).body;
    const item = (name: string) => album.items.find((each: Item) => each.name === name);
    expect(item('meme-dump').shown).toBe(false);
    expect(item('scan-in-progress').shown).toBe(false);
    expect(item('beach-day').shown).toBe(true);
    expect(album).toMatchObject({ nsfw: true, nsfw_marked: false, safety: { state: 'ok' } });
    const marked = await call('PATCH', `/users/@me/albums/${album.id}`, { nsfw: true });
    expect(marked.body.nsfw_marked).toBe(true);
    const publicView = await call('GET', `/albums/${album.vanity}`, undefined, {});
    expect(publicView.body.collage).toBeNull();
    expect(publicView.body.items.some((each: Item) => each.name === 'meme-dump')).toBe(false);
  });

  it('rejects anonymous sensitive uploads, then answers 410 UPLOAD_REJECTED once the scan finishes', async () => {
    process.env.MOCK_SCAN_MS = '0';
    try {
      const anon = { 'x-fingerprint': 'fp-reject' };
      const upfront = await call('POST', '/uploads', { filename: 'a.png', size: 10, nsfw: true, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, anon);
      expect(upfront.body.code).toBe('NSFW_REQUIRES_ACCOUNT');
      const session = await call('POST', '/uploads', { filename: 'nsfw-photo.png', size: 10, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, anon);
      const chunk = Object.assign(Readable.from([Buffer.alloc(10)]), {
        method: 'PUT',
        url: `${MOCK_API_PREFIX}/uploads/${session.body.upload_id}/chunks/0`,
        headers: { host: 'localhost:5173', ...anon },
        socket: { remoteAddress: '127.0.0.1' },
      });
      process.env.MOCK_CHUNK_DELAY_MS = '0';
      process.env.MOCK_PROCESSING_MS = '0';
      await new Promise<void>((resolve) => mockApiMiddleware()(chunk as never, { statusCode: 0, setHeader: () => undefined, end: () => resolve() } as never, () => resolve()));
      await call('POST', `/uploads/${session.body.upload_id}/complete`, undefined, anon);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const done = await call('GET', `/uploads/${session.body.upload_id}`, undefined, anon);
      expect(done.body.file.safety.state).toBe('pending');
      const rejected = await call('GET', `/users/@me/files/${done.body.file.id}`, undefined, anon);
      expect(rejected).toMatchObject({ status: 410, body: { code: 'UPLOAD_REJECTED', reason: 'NSFW_REQUIRES_ACCOUNT' } });
    } finally {
      delete process.env.MOCK_SCAN_MS;
      delete process.env.MOCK_CHUNK_DELAY_MS;
      delete process.env.MOCK_PROCESSING_MS;
    }
  });

  it('blocks uploads for a restricted account and everything but notices for a suspended one', async () => {
    const RESTRICTED = { cookie: mockSessionCookie('46') };
    const restricted = await call('POST', '/uploads', { filename: 'a.png', size: 10 }, RESTRICTED);
    expect(restricted).toMatchObject({ status: 403, body: { code: 'UPLOADS_RESTRICTED', until: expect.any(Number) } });
    expect((await call('GET', '/users/@me/limits', undefined, RESTRICTED)).body.nsfw_allowed).toBe(false);
    const suspended = { cookie: mockSessionCookie('47') };
    expect((await call('GET', '/users/@me/files', undefined, suspended)).body).toMatchObject({ code: 'ACCOUNT_SUSPENDED', until: null });
    expect((await call('GET', '/users/@me', undefined, suspended)).body.restrictions).toEqual([{ kind: 'suspended', until: null, notice_id: expect.any(String) }]);
    expect((await call('GET', '/users/@me/badges', undefined, suspended)).body.notices_unacknowledged).toBe(1);
    expect((await call('GET', '/users/@me/warnings', undefined, suspended)).body.items[0]).toMatchObject({ action: 'suspend_user', appeal: { can_appeal: true } });
  });
});

describe('mock API: reports, notices and badges (milestone-4 §7, §8)', () => {
  it('lists My reports with statuses, unread counts, threads and Reopen', async () => {
    const list = await call('GET', '/users/@me/reports');
    const reasons = list.body.items.map((report: Item) => report.reason);
    expect(reasons).toEqual(expect.arrayContaining(['malware', 'spam', 'copyright', 'harassment', 'bug', 'csam']));
    const malware = list.body.items.find((report: Item) => report.reason === 'malware');
    expect(malware).toMatchObject({ status: 'open', unread: 1, target: { type: 'file', url: expect.stringContaining(malware.target.vanity) } });
    expect(list.body.items.find((report: Item) => report.reason === 'harassment')).toMatchObject({ closed: true, unread: 0 });
    expect(list.body.items.find((report: Item) => report.reason === 'csam').escalated).toBe(true);

    const before = (await call('GET', '/users/@me/badges')).body.reports_unread;
    const thread = await call('GET', `/users/@me/reports/${malware.id}/messages`);
    expect(thread.body.items[0]).toMatchObject({ author: 'staff', body: expect.stringContaining('checking') });
    expect((await call('GET', '/users/@me/badges')).body.reports_unread).toBe(before - 1);
    const reply = await call('POST', `/users/@me/reports/${malware.id}/messages`, { body: 'It also asks for my email.' });
    expect(reply).toMatchObject({ status: 201, body: { author: 'you' } });

    const dismissed = list.body.items.find((report: Item) => report.status === 'dismissed');
    expect(dismissed.can_reopen).toBe(true);
    const reopened = await call('PATCH', `/users/@me/reports/${dismissed.id}`, { status: 'open' });
    expect(reopened.body).toMatchObject({ status: 'open', can_reopen: false });
    expect((await call('PATCH', `/users/@me/reports/${dismissed.id}`, { status: 'open' })).body.code).toBe('REOPEN_NOT_ALLOWED');
    const closed = list.body.items.find((report: Item) => report.closed);
    expect((await call('POST', `/users/@me/reports/${closed.id}/messages`, { body: 'hi' })).body.code).toBe('REPORT_CLOSED');
    expect((await call('GET', '/users/@me/reports?status=resolved')).body.items.every((report: Item) => report.status === 'resolved')).toBe(true);
  });

  it('takes reports: validation, yourself, duplicates, escalation and anonymous ones', async () => {
    const { body } = await call('GET', '/users/@me/files?limit=100');
    const own = byFilename(body.items, 'tagus-panorama.png');
    expect((await call('POST', '/reports', { target: { type: 'file', vanity: own.vanity }, reason: 'spam' }, MEMBER)).status).toBe(201);
    expect((await call('POST', '/reports', { target: { type: 'file', vanity: own.vanity }, reason: 'spam' })).body.code).toBe('CANNOT_REPORT_YOURSELF');
    expect((await call('POST', '/reports', { target: { type: 'file', vanity: own.vanity }, reason: 'other' }, MEMBER)).body).toMatchObject({ code: 'DETAILS_REQUIRED', errors: { details: expect.any(String) } });
    expect((await call('POST', '/reports', { target: { type: 'file', vanity: own.vanity }, reason: 'copyright', details: 'Mine.' }, MEMBER)).body.code).toBe('DMCA_FIELDS_REQUIRED');
    expect((await call('POST', '/reports', { target: { type: 'bug' }, reason: 'spam' }, MEMBER)).body.code).toBe('INVALID_REPORT_TARGET');
    const duplicate = await call('POST', '/reports', { target: { type: 'url', url: own.url }, reason: 'spam', details: 'Again.' }, MEMBER);
    expect(duplicate).toMatchObject({ status: 200, body: { duplicate: true } });
    const anon = await call('POST', '/reports/anonymous', { target: { type: 'file', vanity: own.vanity }, reason: 'csam', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, { 'x-fingerprint': 'fp-r' });
    expect(anon).toMatchObject({ status: 201, body: { status: 'open', escalated: true } });
    // A CSAM report hides the file at once and sends the owner nothing (§7.4, §8.1).
    const after = (await call('GET', `/users/@me/files/${own.id}`)).body.safety;
    expect(after).toMatchObject({ state: 'hidden', reason: 'review', notice_id: null });
  });

  it('acknowledges notices and takes one appeal, with the counter-notice for copyright', async () => {
    const list = await call('GET', '/users/@me/warnings');
    expect(list.body.unacknowledged).toBeGreaterThan(0);
    const copyright = list.body.items.find((notice: Item) => notice.rule === 'copyright');
    expect(copyright).toMatchObject({ rule_text: 'Copyright infringement', target: { kind: 'file' }, appeal: { state: 'none', can_appeal: true } });
    const missing = await call('POST', `/users/@me/warnings/${copyright.id}/appeal`, { message: 'I own it.' });
    expect(missing.body).toMatchObject({ code: 'DMCA_FIELDS_REQUIRED', errors: { signature: expect.any(String), service_consent: expect.any(String) } });
    const counter = { name: 'Mock User', address: '1 Example Street', phone: '1', email: 'mock@example.com', material: 'leaked-episode.mp4', mistake_statement: true, jurisdiction_consent: true, service_consent: true, signature: 'Mock User' };
    const appealed = await call('POST', `/users/@me/warnings/${copyright.id}/appeal`, { message: 'I own it.', counter_notice: counter });
    expect(appealed.body.appeal).toMatchObject({ state: 'open', can_appeal: false });
    expect((await call('POST', `/users/@me/warnings/${copyright.id}/appeal`, { message: 'Again' })).body.code).toBe('APPEAL_NOT_ALLOWED');
    const ack = await call('POST', '/users/@me/warnings/acknowledge', { ids: list.body.items.map((notice: Item) => notice.id).concat('nope') });
    expect(ack.body.acknowledged).toHaveLength(list.body.items.length);
    expect((await call('GET', '/users/@me/badges')).body.notices_unacknowledged).toBe(0);
  });
});

describe('mock API: admin (milestone-4 §9)', () => {
  it('answers non-staff with the same 404 as an unknown route', async () => {
    const admin = await call('GET', '/admin/summary', undefined, MEMBER);
    const unknown = await call('GET', '/nope', undefined, MEMBER);
    expect(admin.status).toBe(404);
    expect(admin.body.code).toBe(unknown.body.code);
    expect((await call('GET', '/admin/cases', undefined, {})).status).toBe(404);
    expect((await call('GET', '/users/@me', undefined, MEMBER)).body.staff).toBeNull();
    expect((await call('GET', '/users/@me/badges', undefined, MEMBER)).body.staff).toBeNull();
  });

  it('lists a case of each kind by priority, and hides child-safety cases from other staff', async () => {
    const admin = await call('GET', '/admin/cases?limit=100');
    const kinds = new Set(admin.body.items.map((c: Item) => c.kind));
    for (const kind of ['file', 'album', 'user', 'hash', 'bug', 'appeal']) expect(kinds).toContain(kind);
    const priorities = admin.body.items.map((c: Item) => c.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(admin.body.items.some((c: Item) => c.child_safety)).toBe(true);
    const moderator = await call('GET', '/admin/cases?limit=100', undefined, MODERATOR);
    expect(moderator.body.items.some((c: Item) => c.child_safety)).toBe(false);
    const hidden = admin.body.items.find((c: Item) => c.child_safety);
    expect((await call('GET', `/admin/cases/${hidden.id}`, undefined, MODERATOR)).body.code).toBe('UNKNOWN_CASE');
    const summary = await call('GET', '/admin/summary');
    expect(summary.body).toMatchObject({ open: { p0: expect.any(Number) }, newest_p0_at: expect.any(Number), cybertip_unrecorded: 1 });
    expect((await call('GET', '/admin/summary', undefined, MODERATOR)).body.cybertip_unrecorded).toBe(0);
  });

  it('claims with CASE_CLAIMED for someone else’s case, unless an admin forces it', async () => {
    const { body } = await call('GET', '/admin/cases?assignee=43');
    const claimed = body.items[0];
    expect(claimed.assignee).toEqual({ id: '43', username: 'modmary' });
    expect((await call('POST', `/admin/cases/${claimed.id}/claim`, {})).body).toMatchObject({ code: 'CASE_CLAIMED', assignee_id: '43' });
    expect((await call('POST', `/admin/cases/${claimed.id}/claim`, { force: true })).body.assignee.id).toBe('42');
    expect((await call('POST', `/admin/cases/${claimed.id}/claim`, { force: true }, MODERATOR)).body.code).toBe('CASE_CLAIMED');
    expect((await call('POST', `/admin/cases/${claimed.id}/release`, {})).body.assignee).toBeNull();
  });

  it('runs actions with a rule, sends notices, and checks permissions', async () => {
    const { body } = await call('GET', '/admin/cases?kind=file&limit=100');
    const robux = body.items.find((c: Item) => c.target.name === 'free-robux.zip');
    const detail = (await call('GET', `/admin/cases/${robux.id}`)).body;
    expect(detail.target_detail.staff_urls.content).toMatch(/\?staff=42&expires=\d+&sig=/);
    expect(detail.reports[0]).toMatchObject({ reason: 'malware', reporter: { signed_in: true, user_id: '42' } });
    expect((await call('POST', '/admin/actions', { action: 'remove', target: { type: 'file', id: robux.target.id } })).body.code).toBe('INVALID_ACTION');
    const removed = await call('POST', '/admin/actions', { action: 'remove', target: { type: 'file', id: robux.target.id }, rule: 'malware', message: 'Contains a password stealer.', case_id: robux.id });
    expect(removed.body).toMatchObject({ action: { action: 'remove', rule: 'malware', actor: { id: '42', kind: 'staff' } }, notice_ids: [expect.any(String)] });
    expect((await call('POST', '/admin/actions', { action: 'suspend_user', target: { type: 'user', id: '77' }, rule: 'malware' }, MODERATOR)).body.code).toBe('FORBIDDEN');
    const closed = await call('POST', `/admin/cases/${robux.id}/close`, { outcome: 'actioned', reason: 'Malware.' });
    expect(closed.body.status).toBe('closed');
    const report = (await call('GET', '/users/@me/reports?status=resolved')).body.items.find((each: Item) => each.target.vanity === robux.target.vanity);
    expect(report).toBeTruthy();
    const audit = await call('GET', `/admin/audit?case_id=${robux.id}`, undefined, MODERATOR);
    expect(audit.body.items.map((row: Item) => row.action)).toEqual(expect.arrayContaining(['remove', 'close_case']));
    expect((await call('GET', '/admin/audit', undefined, MODERATOR)).body.code).toBe('FORBIDDEN');
  });

  it('never returns a URL for hash-matched content, and decides appeals with SAME_MODERATOR', async () => {
    const { body } = await call('GET', '/admin/cases?kind=hash');
    const hash = (await call('GET', `/admin/cases/${body.items[0].id}`)).body;
    expect(hash).toMatchObject({ hash_matched: true, child_safety: true });
    expect(hash.target_detail.staff_urls).toBeUndefined();
    expect(hash.target_detail.file.cdn_url).toBe('');
    expect((await call('POST', `/admin/cases/${hash.id}/cybertip`, { report_id: '123456' })).body.cybertip_report_id).toBe('123456');

    const appeals = await call('GET', '/admin/cases?kind=appeal&needs_second_review=true');
    const appeal = appeals.body.items.find((c: Item) => c.target.name === 'quiet-notes.pdf');
    const same = await call('POST', `/admin/cases/${appeal.id}/appeal`, { decision: 'grant', message: 'Fair.' });
    expect(same).toMatchObject({ status: 409, body: { code: 'SAME_MODERATOR' } });
    const granted = await call('POST', `/admin/cases/${appeal.id}/appeal`, { decision: 'grant', message: 'These are lecture notes.' }, MODERATOR);
    expect(granted.body).toMatchObject({ status: 'closed', outcome: 'actioned' });
    expect(granted.body.appeal.notice.appeal).toMatchObject({ state: 'granted', message: 'These are lecture notes.' });
    const file = await call('GET', `/admin/files/${appeal.target.id}`, undefined, MODERATOR);
    expect(file.body.moderation_state).toBe('visible');
  });

  it('looks up by vanity, URL, user id and username, and manages bans', async () => {
    const files = (await call('GET', '/users/@me/files?limit=100')).body.items;
    const tram = byFilename(files, 'pastel-de-nata.png');
    expect((await call('GET', `/admin/lookup?q=${tram.vanity}`)).body.files[0].id).toBe(tram.id);
    expect((await call('GET', `/admin/lookup?q=${encodeURIComponent(tram.url)}`)).body.files[0].id).toBe(tram.id);
    expect((await call('GET', '/admin/lookup?q=tracker99')).body.users[0].id).toBe('77');
    expect((await call('GET', '/admin/lookup?q=77')).body.users[0].username).toBe('tracker99');
    const user = await call('GET', '/admin/users/77');
    expect(user.body).toMatchObject({ user: { username: 'tracker99' }, counts: { files: expect.any(Number) } });

    expect((await call('POST', '/admin/bans', { kind: 'fingerprint', from: { fingerprint: '999' }, rule: 'spam' }, MODERATOR)).body.code).toBe('FORBIDDEN');
    const ban = await call('POST', '/admin/bans', { kind: 'fingerprint', from: { fingerprint: '999' }, rule: 'spam', duration: 86400 }, MODERATOR);
    expect(ban).toMatchObject({ status: 201, body: { kind: 'fingerprint', expires_at: expect.any(Number) } });
    const banned = await call('POST', '/uploads', { filename: 'a.png', size: 10, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, { 'x-fingerprint': '999' });
    expect(banned.body.code).toBe('BANNED');
    expect((await call('DELETE', `/admin/bans/${ban.body.id}`, undefined, MODERATOR)).body.code).toBe('FORBIDDEN');
    expect((await call('DELETE', `/admin/bans/${ban.body.id}`)).body.lifted_at).toEqual(expect.any(Number));
    expect((await call('GET', '/admin/staff', undefined, MODERATOR)).body.code).toBe('FORBIDDEN');
    expect((await call('GET', '/admin/staff')).body.items.map((each: Item) => each.username)).toEqual(['mockuser', 'modmary']);
    expect((await call('POST', '/admin/rescans', { checks: ['clamav'] })).status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Milestone 6: accounts
// ---------------------------------------------------------------------------

const TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX';
const VERIFIER = 'dBjftJeZ4CVP-mJ92IGzWRE3ZTJ0-YHlfYSV0xHrl4w';
const CHALLENGE = 'SkrKhQFbMBX5ptYerKJJajG2CIJ-X_1O1IyRGzbnMZ8';
let ipCounter = 0;
/** A fresh client IP, so per-IP limits (register: 5 an hour) never leak between tests. */
const freshIp = () => ({ 'cf-connecting-ip': `10.0.0.${++ipCounter}` });
const cookieOf = (reply: Reply) => /^(filesgg_session=[^;]*)/.exec(reply.headers['set-cookie'] ?? '')?.[1] ?? '';

function multipart(filename: string, fields: Record<string, string> = {}) {
  const boundary = 'mockboundary';
  const parts = [
    ...Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\nhello\r\n`,
    `--${boundary}--\r\n`,
  ];
  return { body: Buffer.from(parts.join('')), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function signInAs(email: string, extra: Record<string, string> = {}, password = MOCK_PASSWORD) {
  const reply = await call('POST', '/auth/login', { email, password, turnstile_token: TURNSTILE }, { ...freshIp(), ...extra });
  expect(reply.status).toBe(200);
  return { cookie: cookieOf(reply) };
}

describe('mock API: tokens and signatures (milestone-6 §7.1, §16)', () => {
  it.each([
    ['fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V', true, 3255368311],
    ['fgg_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz43NeoO', true, 3714498764],
    ['fgg_0000000000000000000000000000001BAc6F', true, 1081202267],
    ['fgs_0123456789ABCDEFGHIJabcdefghij3CXBkC', true, 2933624500],
    ['fgs_Q7xK2mP9vL4nR8tW1yB5cD3fG6hJ0k2iu6sT', true, 2495797257],
    ['fgg_0123456789ABCDEFGHIJabcdefghij3YJC0W', false, null],
    ['fgs_0123456789ABCDEFGHIJabcdefghij3YJC0V', false, null],
    ['fgg_0123456789ABCDEFGHIJabcdefghij3YJC0', false, null],
  ] as const)('%s is %s', (token, valid, crc) => {
    expect(tokenValid(token)).toBe(valid);
    if (crc !== null) expect(crc32(token.slice(0, 34))).toBe(crc);
  });

  it('makes tokens that pass their own checksum', () => {
    const key = makeToken('fgg_');
    expect(key).toMatch(/^fgg_[0-9A-Za-z]{36}$/);
    expect(tokenValid(key, 'fgg_')).toBe(true);
    expect(tokenValid(key, 'fgs_')).toBe(false);
  });

  it('matches the PKCE, state and sign-up token vectors, and rejects the bad ones', () => {
    expect(pkceChallenge(VERIFIER)).toBe(CHALLENGE);
    const claims = { c: CHALLENGE, e: 1795604200, i: 1795603600, n: 'n0nce-AbC123', p: 'login', u: null };
    const state = signLabelled(claims, 'filesgg-oauth-state-1', 'test-secret-key');
    expect(state).toBe(
      'eyJjIjoiU2tyS2hRRmJNQlg1cHRZZXJLSkphakcyQ0lKLVhfMU8xSXlSR3pibk1aOCIsImUiOjE3OTU2MDQyMDAsImkiOjE3OTU2MDM2MDAsIm4iOiJuMG5jZS1BYkMxMjMiLCJwIjoibG9naW4iLCJ1IjpudWxsfQ.IhS_8MHN3GRuPXze_CmM976stCIR2ZaU3_35ENFnidw',
    );
    expect(signLabelled({ ...claims, p: 'link', u: '1234567890123456789' }, 'filesgg-oauth-state-1', 'test-secret-key')).toBe(
      'eyJjIjoiU2tyS2hRRmJNQlg1cHRZZXJLSkphakcyQ0lKLVhfMU8xSXlSR3pibk1aOCIsImUiOjE3OTU2MDQyMDAsImkiOjE3OTU2MDM2MDAsIm4iOiJuMG5jZS1BYkMxMjMiLCJwIjoibGluayIsInUiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5In0.XQseFi7qgojAlK9eM0H2Xq0NgIJl-cTGsQKB6lXSiT0',
    );
    const signup = signLabelled(
      { a: 'a_1b2c3d4e5f', d: '80351110224678912', e: 1795604500, g: 'Dan W', m: 'dan@example.com', mv: true, n: 'dan.w' },
      'filesgg-discord-signup-1',
      'test-secret-key',
    );
    expect(signup).toBe(
      'eyJhIjoiYV8xYjJjM2Q0ZTVmIiwiZCI6IjgwMzUxMTEwMjI0Njc4OTEyIiwiZSI6MTc5NTYwNDUwMCwiZyI6IkRhbiBXIiwibSI6ImRhbkBleGFtcGxlLmNvbSIsIm12Ijp0cnVlLCJuIjoiZGFuLncifQ.dTHKYhVaOnp_pzHdX018IqrZTCEuvdOBmNe41i_3cLc',
    );
    expect(verifyLabelled(state, 'filesgg-oauth-state-1', 'test-secret-key', 1795603700)).toEqual(claims);
    const forged = `${state.split('.')[0]}.cov0bNlk7-TsdIbPPPwY4hxHTGXu5GRkTtl4gPue1eE`;
    expect(verifyLabelled(forged, 'filesgg-oauth-state-1', 'test-secret-key', 1795603700)).toBeNull();
    expect(verifyLabelled(state, 'filesgg-oauth-state-1', 'test-secret-key', 1795604200)).toBeNull();
    expect(verifyLabelled(signup, 'filesgg-oauth-state-1', 'test-secret-key', 1795603700)).toBeNull();
  });
});

describe('mock API: sessions, CSRF and sign-in (milestone-6 §3, §4)', () => {
  it('refuses writes without the CSRF header, from another origin or a sandboxed document', async () => {
    expect((await call('PATCH', '/users/@me', { display_name: 'X' }, { ...USER, 'x-filesgg-csrf': '' })).body.code).toBe('CSRF');
    expect((await call('PATCH', '/users/@me', { display_name: 'Mock User' }, { ...USER, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).body.code).toBe('CSRF');
    expect((await call('POST', '/users/@me/albums', { file_ids: [] }, { ...USER, origin: 'null', 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await call('POST', '/auth/login', { email: 'a@b.cc' }, { 'x-filesgg-csrf': '' })).body.code).toBe('CSRF');
    expect((await call('PATCH', '/users/@me', { display_name: 'Mock User' }, { ...USER, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await call('GET', '/users/@me')).status).toBe(200);
  });

  it('never signs in from Authorization, and keeps keys to the upload endpoints', async () => {
    expect((await call('GET', '/users/@me', undefined, { authorization: 'Bearer anything' })).body.code).toBe('UNAUTHORIZED');
    const key = await call('POST', '/users/@me/upload-keys', { name: 'Scope test' });
    expect((await call('GET', '/users/@me', undefined, { authorization: `Key ${key.body.secret}` })).body.code).toBe('UPLOAD_KEY_NOT_ALLOWED');
    expect((await call('GET', '/admin/summary', undefined, { authorization: `Key ${key.body.secret}` })).status).toBe(404);
  });

  it('signs in by email, sets and clears the cookie, and answers /auth/session either way', async () => {
    expect((await call('GET', '/auth/session', undefined, {})).body).toEqual({ user: null });
    expect((await call('GET', '/auth/config', undefined, {})).body).toEqual({ discord: true });
    expect((await call('POST', '/auth/login', { email: 'mock@example.com', password: MOCK_PASSWORD }, freshIp())).body.code).toBe('CAPTCHA_INVALID');
    const wrong = await call('POST', '/auth/login', { email: 'MOCK@example.com', password: 'nope', turnstile_token: TURNSTILE }, freshIp());
    expect(wrong).toMatchObject({ status: 400, body: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password.' } });
    const ok = await call('POST', '/auth/login', { email: 'MOCK@example.com', password: MOCK_PASSWORD, turnstile_token: TURNSTILE }, freshIp());
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/^filesgg_session=fgs_[0-9A-Za-z]{36}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
    expect(ok.body).toMatchObject({ expires_at: expect.any(Number), user: { id: '42', username: 'mockuser', email_verified: true, has_password: true, premium: { active: false } } });
    expect(JSON.stringify(ok.body)).not.toContain('fgs_');
    const cookie = { cookie: cookieOf(ok) };
    expect((await call('GET', '/auth/session', undefined, cookie)).body.user.identities[0]).toMatchObject({ provider: 'discord', username: 'mockuser' });
    const out = await call('POST', '/auth/logout', undefined, cookie);
    expect(out.status).toBe(204);
    expect(out.headers['set-cookie']).toContain('Max-Age=0');
    const after = await call('GET', '/auth/session', undefined, cookie);
    expect(after.body).toEqual({ user: null });
    expect(after.headers['set-cookie']).toContain('Max-Age=0');
    expect((await call('GET', '/users/@me/files', undefined, cookie)).body.code).toBe('UNAUTHORIZED');
  });

  it('limits failed logins per account', async () => {
    for (let i = 0; i < 10; i++) await call('POST', '/auth/login', { email: 'quietfox@example.com', password: 'nope', turnstile_token: TURNSTILE }, freshIp());
    const limited = await call('POST', '/auth/login', { email: 'quietfox@example.com', password: MOCK_PASSWORD, turnstile_token: TURNSTILE }, freshIp());
    expect(limited).toMatchObject({ status: 429, body: { code: 'TOO_MANY_ATTEMPTS', retry_after: expect.any(Number) } });
  });

  it('registers with the field rules, then verifies the email from the link', async () => {
    const many = await call('POST', '/auth/register', { email: 'nope', username: 'admin', password: 'short', turnstile_token: TURNSTILE }, freshIp());
    expect(many).toMatchObject({ status: 400, body: { code: 'INVALID_PARAMETERS', errors: { email: expect.any(String), username: expect.any(String), password: expect.any(String) } } });
    const one = await call('POST', '/auth/register', { email: 'new1@example.com', username: 'Files.GG', password: 'long enough', turnstile_token: TURNSTILE }, freshIp());
    expect(one.body).toMatchObject({ code: 'USERNAME_INVALID', reason: 'reserved' });
    const same = await call('POST', '/auth/register', { email: 'new1@example.com', username: 'Dan.W', password: 'DAN.W', turnstile_token: TURNSTILE }, freshIp());
    expect(same.body).toMatchObject({ code: 'INVALID_PASSWORD', reason: 'matches_username' });
    expect((await call('POST', '/auth/register', { email: 'MEMBER@example.com', username: 'fresh_one', password: 'long enough', turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('EMAIL_TAKEN');
    expect((await call('POST', '/auth/register', { email: 'new1@example.com', username: 'quietfox', password: 'long enough', turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('USERNAME_TAKEN');
    const created = await call('POST', '/auth/register', { email: 'new1@example.com', username: 'Dan.W', display_name: '  Dan   W ', password: 'long enough', turnstile_token: TURNSTILE }, freshIp());
    expect(created).toMatchObject({ status: 201, body: { user: { username: 'dan.w', display_name: 'Dan W', email_verified: false } } });
    expect(created.body.user.id).not.toBe('42');
    const cookie = { cookie: cookieOf(created) };
    expect((await call('POST', '/auth/verify', { token: 'bad' }, {})).body.code).toBe('INVALID_TOKEN');
    expect((await call('POST', '/auth/verify', { token: mockLastEmailToken('verify_email') }, {})).status).toBe(204);
    expect((await call('GET', '/users/@me', undefined, cookie)).body.email_verified).toBe(true);
    expect((await call('POST', '/auth/verify/resend', undefined, cookie)).body.code).toBe('NOTHING_TO_VERIFY');
    const check = await call('GET', '/users/@me/username/check?username=Dan.W', undefined, {});
    expect(check.body).toEqual({ username: 'dan.w', available: false, reason: 'taken' });
    expect((await call('GET', '/users/@me/username/check?username=da..n', undefined, {})).body.reason).toBe('dots');
    expect((await call('GET', '/users/@me/username/check?username=dan.w', undefined, cookie)).body.available).toBe(true);
  });

  it('claims files uploaded from this browser on sign-in', async () => {
    const anon = { 'x-fingerprint': 'fp-claim' };
    const upload = multipart('claim-me.png', { turnstile_token: TURNSTILE });
    const sent = await call('POST', '/files', upload.body, { ...anon, ...upload.headers });
    expect(sent.status).toBe(200);
    const member = await signInAs('restricted@example.com', anon);
    const files = await call('GET', '/users/@me/files?query=claim-me', undefined, member);
    expect(files.body.items.map((file: Item) => file.id)).toEqual([sent.body.id]);
    expect((await call('GET', '/users/@me/files?query=claim-me', undefined, anon)).body.count).toBe(0);
  });

  it('resets a forgotten password, which signs in and ends other sessions', async () => {
    expect((await call('POST', '/auth/forgot', { email: 'nobody@example.com', turnstile_token: TURNSTILE }, freshIp())).status).toBe(204);
    const other = await signInAs('reporterbee@example.com');
    expect((await call('POST', '/auth/forgot', { email: 'reporterbee@example.com', turnstile_token: TURNSTILE }, freshIp())).status).toBe(204);
    const token = mockLastEmailToken('reset_password');
    expect((await call('POST', '/auth/forgot/reset', { token, password: MOCK_PASSWORD, turnstile_token: TURNSTILE }, {})).body.code).toBe('SAME_PASSWORD');
    const reset = await call('POST', '/auth/forgot/reset', { token, password: 'a brand new one', turnstile_token: TURNSTILE }, {});
    expect(reset).toMatchObject({ status: 200, body: { user: { username: 'reporterbee' } } });
    expect((await call('GET', '/auth/session', undefined, other)).body.user).toBeNull();
    expect((await call('POST', '/auth/forgot/reset', { token, password: 'another one!', turnstile_token: TURNSTILE }, {})).body.code).toBe('INVALID_TOKEN');
  });
});

describe('mock API: settings (milestone-6 §2, §8)', () => {
  it('renames with the cooldown and hold, and edits the display name and privacy', async () => {
    expect((await call('PUT', '/users/@me/username', { username: 'mocky' })).body).toMatchObject({ code: 'USERNAME_COOLDOWN', available_at: expect.any(Number) });
    const me = await call('GET', '/users/@me');
    expect(me.body.username_change_available_at).toEqual(expect.any(Number));
    const member = await signInAs('member@example.com');
    expect((await call('GET', '/users/@me', undefined, member)).body).toMatchObject({ username: 'member', email_verified: false, username_change_available_at: null });
    const renamed = await call('PUT', '/users/@me/username', { username: 'Member.Two' }, member);
    expect(renamed.body).toMatchObject({ username: 'member.two', username_change_available_at: expect.any(Number) });
    expect((await call('GET', '/users/@me/username/check?username=member', undefined, {})).body.reason).toBe('taken');
    expect((await call('GET', '/users/@me/username/check?username=member', undefined, member)).body.available).toBe(true);
    const patched = await call('PATCH', '/users/@me', { display_name: 'files.gg staff' }, member);
    expect(patched.body).toMatchObject({ code: 'DISPLAY_NAME_INVALID', reason: 'reserved' });
    const ok = await call('PATCH', '/users/@me', { display_name: '', settings: { show_name_on_albums: true } }, member);
    expect(ok.body).toMatchObject({ display_name: null, settings: { show_name_on_albums: true } });
  });

  it('needs a fresh session for sensitive changes, and re-auth makes it fresh', async () => {
    const member = await signInAs('modmary@example.com');
    mockAgeSession(member.cookie, 3600);
    const stale = await call('POST', '/users/@me/email', { email: 'mary.new@example.com' }, member);
    expect(stale).toMatchObject({ status: 403, body: { code: 'REAUTH_REQUIRED', methods: ['password'] } });
    expect((await call('POST', '/auth/reauth', { password: 'nope' }, member)).body.code).toBe('INVALID_CREDENTIALS');
    expect((await call('POST', '/auth/reauth', { password: MOCK_PASSWORD }, member)).status).toBe(204);
    expect((await call('POST', '/users/@me/email', { email: 'mary.new@example.com' }, member))).toMatchObject({ status: 202, body: { pending_email: 'mary.new@example.com' } });
    expect((await call('GET', '/users/@me', undefined, member)).body).toMatchObject({ email: 'modmary@example.com', pending_email: 'mary.new@example.com' });
    expect((await call('DELETE', '/users/@me/email/pending', undefined, member)).status).toBe(204);
    expect((await call('PUT', '/users/@me/password', { current_password: 'wrong', new_password: 'long enough' }, member)).body.code).toBe('INVALID_CREDENTIALS');
    expect((await call('PUT', '/users/@me/password', { current_password: MOCK_PASSWORD, new_password: MOCK_PASSWORD }, member)).body.code).toBe('SAME_PASSWORD');
  });

  it('refuses to unlink the last login method, and lets Discord-only accounts set a password only once verified', async () => {
    const discordOnly = { cookie: mockSessionCookie('50') };
    expect((await call('GET', '/users/@me/identities', undefined, discordOnly)).body.items).toHaveLength(1);
    expect((await call('DELETE', '/users/@me/identities/discord', undefined, discordOnly)).body.code).toBe('LAST_LOGIN_METHOD');
    expect((await call('PUT', '/users/@me/password', { new_password: 'long enough' }, discordOnly)).body.code).toBe('EMAIL_NOT_VERIFIED');
    mockAgeSession(discordOnly.cookie, 3600);
    expect((await call('DELETE', '/users/@me/identities/discord', undefined, discordOnly)).body).toMatchObject({ code: 'REAUTH_REQUIRED', methods: ['discord'] });
    expect((await call('DELETE', '/users/@me/identities/discord', undefined, MEMBER)).body.code).toBe('UNKNOWN_IDENTITY');
  });

  it('lists sessions with this device first, signs out one, then everywhere', async () => {
    const first = await signInAs('tracker99@example.com', { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36' });
    const second = await signInAs('tracker99@example.com', { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/140.0' });
    const list = await call('GET', '/users/@me/sessions', undefined, second);
    expect(list.body.items[0]).toMatchObject({ current: true, device: 'Firefox on macOS', method: 'password', country: 'GB' });
    expect(list.body.items[1]).toMatchObject({ current: false, device: 'Chrome on Windows' });
    expect(JSON.stringify(list.body)).not.toContain('fgs_');
    expect((await call('DELETE', `/users/@me/sessions/${list.body.items[1].id}`, undefined, second)).status).toBe(204);
    expect((await call('GET', '/auth/session', undefined, first)).body.user).toBeNull();
    expect((await call('DELETE', '/users/@me/sessions/123', undefined, second)).body.code).toBe('UNKNOWN_SESSION');
    const everywhere = await call('DELETE', '/users/@me/sessions', undefined, second);
    expect(everywhere).toMatchObject({ status: 200, body: { revoked: 1 } });
    expect(everywhere.headers['set-cookie']).toContain('Max-Age=0');
    expect((await call('GET', '/auth/session', undefined, second)).body.user).toBeNull();
  });

  it('queues one export a day and serves the ZIP once it is ready', async () => {
    const list = await call('GET', '/users/@me/exports');
    expect(list.body.items[0]).toMatchObject({ status: 'ready', size: 22 });
    const zip = await call('GET', `/users/@me/exports/${list.body.items[0].id}/download`);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toMatch(/^attachment; filename="filesgg-export-mockuser-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(zip.headers['cache-control']).toBe('private, no-store');
    const queued = await call('POST', '/users/@me/exports');
    expect(queued).toMatchObject({ status: 202, body: { export: { status: 'queued', ready_at: null } } });
    expect((await call('POST', '/users/@me/exports')).body).toMatchObject({ code: 'EXPORT_LIMIT', retry_after: expect.any(Number) });
    expect((await call('GET', `/users/@me/exports/${queued.body.export.id}/download`)).body.code).toBe('EXPORT_NOT_READY');
    expect((await call('GET', '/users/@me/exports/1/download')).body.code).toBe('UNKNOWN_EXPORT');
  });

  it('deletes with a grace period: locked, offline, then kept', async () => {
    const created = await call('POST', '/auth/register', { email: 'bye@example.com', username: 'bye_bye', password: 'long enough', turnstile_token: TURNSTILE }, freshIp());
    const cookie = { cookie: cookieOf(created) };
    const other = await signInAs('bye@example.com', {}, 'long enough');
    expect((await call('POST', '/users/@me/delete', { confirm_username: 'mockuser' })).body).toMatchObject({ code: 'ACCOUNT_DELETE_NOT_ALLOWED', reason: 'staff' });
    expect((await call('POST', '/users/@me/delete', { confirm_username: 'nope' }, cookie)).body.code).toBe('INVALID_PARAMETERS');
    mockAgeSession(cookie.cookie, 3600);
    expect((await call('POST', '/users/@me/delete', { confirm_username: 'bye_bye' }, cookie)).body.code).toBe('REAUTH_REQUIRED');
    await call('POST', '/auth/reauth', { password: 'long enough' }, cookie);
    const requested = await call('POST', '/users/@me/delete', { confirm_username: 'BYE_BYE' }, cookie);
    expect(requested.status).toBe(202);
    expect(requested.body.deletion.scheduled_for - requested.body.deletion.requested_at).toBe(14 * 86400);
    expect((await call('GET', '/auth/session', undefined, other)).body.user).toBeNull();
    expect((await call('GET', '/users/@me/files', undefined, cookie)).body).toMatchObject({ code: 'ACCOUNT_PENDING_DELETION', scheduled_for: expect.any(Number) });
    expect((await call('POST', '/users/@me/upload-keys', { name: 'x' }, cookie)).body.code).toBe('ACCOUNT_PENDING_DELETION');
    expect((await call('GET', '/users/@me', undefined, cookie)).body.deletion).not.toBeNull();
    expect((await call('GET', '/users/@me/sessions', undefined, cookie)).status).toBe(200);
    expect((await call('POST', '/users/@me/exports', undefined, cookie)).status).toBe(202);
    const kept = await call('POST', '/users/@me/delete/cancel', undefined, cookie);
    expect(kept).toMatchObject({ status: 200, body: { deletion: null } });
    expect((await call('GET', '/users/@me/files', undefined, cookie)).status).toBe(200);
    const leaving = await signInAs('leaving@example.com');
    expect((await call('GET', '/auth/session', undefined, leaving)).body.user.deletion).toMatchObject({ scheduled_for: expect.any(Number) });
  });

  it('lets a suspended account manage sessions and exports, and nothing else new', async () => {
    const suspended = { cookie: mockSessionCookie('47') };
    expect((await call('GET', '/users/@me/sessions', undefined, suspended)).status).toBe(200);
    expect((await call('POST', '/users/@me/exports', undefined, suspended)).status).toBe(202);
    expect((await call('POST', '/users/@me/upload-keys', { name: 'x' }, suspended)).body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await call('POST', '/users/@me/delete', { confirm_username: 'suspended' }, suspended)).body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await call('POST', '/auth/discord/authorize', { purpose: 'link', code_challenge: CHALLENGE }, suspended)).body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('mock API: upload keys (milestone-6 §7)', () => {
  it('creates, lists, renames and revokes keys, and uploads with them', async () => {
    const list = await call('GET', '/users/@me/upload-keys');
    expect(list.body.limit).toBe(20);
    expect(list.body.items.map((key: Item) => key.state)).toEqual(expect.arrayContaining(['active', 'revoked']));
    expect((await call('POST', '/users/@me/upload-keys', { name: 'x', expires_in: 12 })).body.code).toBe('INVALID_PARAMETERS');
    const created = await call('POST', '/users/@me/upload-keys', { name: 'Laptop', scopes: ['files:upload', 'albums:append'], expires_in: 30 * 86400 });
    expect(created.status).toBe(201);
    expect(tokenValid(created.body.secret, 'fgg_')).toBe(true);
    expect(created.body.key).toMatchObject({ name: 'Laptop', prefix: created.body.secret.slice(0, 12), state: 'active', domain: null, scopes: ['files:upload', 'albums:append'] });
    expect(created.body.key.expires_at - created.body.key.created_at).toBe(30 * 86400);
    expect(Object.keys(created.body.sharex)).toEqual(['Version', 'Name', 'DestinationType', 'RequestMethod', 'RequestURL', 'Headers', 'Body', 'FileFormName', 'URL', 'ErrorMessage']);
    expect(created.body.sharex).toMatchObject({ Version: '17.0.0', Name: 'files.gg (Laptop)', RequestURL: 'https://api.files.gg/files', Headers: { Authorization: `Key ${created.body.secret}` } });
    expect(created.body.curl).toContain(`Authorization: Key ${created.body.secret}`);
    expect((await call('GET', '/users/@me/upload-keys')).body.items.every((key: Item) => !('secret' in key))).toBe(true);

    const key = { authorization: `Key ${created.body.secret}` };
    const upload = multipart('from-sharex.png');
    const sent = await call('POST', '/files', upload.body, { ...key, ...upload.headers, cookie: MEMBER.cookie });
    expect(sent.status).toBe(200);
    expect((await call('GET', '/users/@me/files?query=from-sharex')).body.count).toBe(1);
    const chunked = await call('POST', '/uploads', { filename: 'big.png', size: 10 }, { ...key, 'x-filesgg-csrf': '' });
    expect(chunked.status).toBe(201);
    expect((await call('GET', `/uploads/${chunked.body.upload_id}`, undefined, key)).status).toBe(200);

    const narrow = await call('POST', '/users/@me/upload-keys', { name: 'No albums' });
    const album = multipart('to-album.png', { album: 'whatever' });
    const scoped = await call('POST', '/files', album.body, { authorization: `Key ${narrow.body.secret}`, ...album.headers });
    expect(scoped).toMatchObject({ status: 403, body: { code: 'UPLOAD_KEY_SCOPE', scope: 'albums:append' } });
    expect((await call('GET', `/uploads/${chunked.body.upload_id}`, undefined, { authorization: `Key ${narrow.body.secret}` })).body.code).toBe('UNKNOWN_UPLOAD');

    expect((await call('PATCH', `/users/@me/upload-keys/${created.body.key.id}`, { name: 'Desktop' })).body.name).toBe('Desktop');
    expect((await call('DELETE', `/users/@me/upload-keys/${created.body.key.id}`)).status).toBe(204);
    expect((await call('POST', '/files', upload.body, { ...key, ...upload.headers })).body.code).toBe('UPLOAD_KEY_INVALID');
    expect((await call('POST', '/files', upload.body, { authorization: 'Key fgg_0123456789ABCDEFGHIJabcdefghij3YJC0W', ...upload.headers })).body.code).toBe('UPLOAD_KEY_INVALID');
    expect((await call('DELETE', '/users/@me/upload-keys/1')).body.code).toBe('UNKNOWN_UPLOAD_KEY');
  });

  it('asks tools without any credential for a key', async () => {
    const upload = multipart('anon.png');
    expect((await call('POST', '/files', upload.body, { 'x-fingerprint': 'fp-tool', ...upload.headers })).body.code).toBe('UPLOAD_KEY_REQUIRED');
    expect((await call('POST', '/uploads', { filename: 'a.png', size: 10 }, { 'x-fingerprint': 'fp-tool' })).status).toBe(401);
    expect((await call('POST', '/uploads', { filename: 'a.png', size: 10, turnstile_token: 'bad' }, { 'x-fingerprint': 'fp-tool' })).body.code).toBe('CAPTCHA_INVALID');
  });
});

describe('mock API: Discord (milestone-6 §5)', () => {
  async function authorize(purpose: string, headers: Record<string, string> = {}) {
    const reply = await call('POST', '/auth/discord/authorize', { purpose, code_challenge: CHALLENGE }, headers);
    expect(reply.status).toBe(200);
    return reply.body as { url: string; state: string };
  }

  it('signs in a linked account with PKCE and state, and refuses a wrong verifier or code', async () => {
    const { url, state } = await authorize('login');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/__discord/authorize');
    expect([...parsed.searchParams.keys()]).toEqual(['response_type', 'client_id', 'scope', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'prompt']);
    expect(parsed.searchParams.get('prompt')).toBe('none');
    expect(url).toContain('scope=identify%20email');
    const page = await call('GET', `/__discord/authorize${parsed.search}`, undefined, {});
    expect(page.headers['content-type']).toContain('text/html');
    expect(String(page.body)).toContain('Mock Discord');

    const code = mockDiscordCode('80351110224678912', CHALLENGE);
    expect((await call('POST', '/auth/discord/callback', { code, state, code_verifier: 'x'.repeat(43), turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('INVALID_OAUTH_STATE');
    expect((await call('POST', '/auth/discord/callback', { code, state: `${state}x`, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('INVALID_OAUTH_STATE');
    expect((await call('POST', '/auth/discord/callback', { code: 'nope', state, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('DISCORD_CODE_INVALID');
    expect((await call('POST', '/auth/discord/callback', { code, state, code_verifier: VERIFIER }, freshIp())).body.code).toBe('CAPTCHA_INVALID');
    const signed = await call('POST', '/auth/discord/callback', { code, state, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp());
    expect(signed.body).toMatchObject({ status: 'signed_in', user: { id: '42' } });
    expect(cookieOf(signed)).toMatch(/^filesgg_session=fgs_/);
  });

  it('signs up a new Discord account with a verified email, and refuses one whose email is taken', async () => {
    const { state } = await authorize('login');
    const fresh = await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678914', CHALLENGE), state, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp());
    expect(fresh.body).toMatchObject({
      status: 'signup_required',
      suggested_username: 'newdiscord',
      discord: { id: '80351110224678914', username: 'newdiscord', display_name: 'New Discord', avatar_url: expect.stringMatching(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/) },
      email: { address: 'new.discord@example.com', usable: true, reason: null },
    });
    expect(fresh.headers['set-cookie']).toBeUndefined();
    const created = await call('POST', '/auth/discord/signup', { signup_token: fresh.body.signup_token, username: 'newdiscord', display_name: 'New Discord', turnstile_token: TURNSTILE }, freshIp());
    expect(created).toMatchObject({ status: 201, body: { user: { username: 'newdiscord', email: 'new.discord@example.com', email_verified: true, has_password: false } } });
    expect((await call('POST', '/auth/discord/signup', { signup_token: fresh.body.signup_token, username: 'another', turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('IDENTITY_IN_USE');

    const unverified = await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678915', CHALLENGE), state, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp());
    expect(unverified.body.email).toEqual({ address: 'unverified.discord@example.com', usable: false, reason: 'unverified' });
    const noEmail = await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678916', CHALLENGE), state, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp());
    expect(noEmail.body.email).toEqual({ address: null, usable: false, reason: 'missing' });
    const noEmailUser = await call('POST', '/auth/discord/signup', { signup_token: noEmail.body.signup_token, username: 'no_email_here', turnstile_token: TURNSTILE }, freshIp());
    expect(noEmailUser.body.user).toMatchObject({ email: null, email_verified: false });
    const taken = await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678917', CHALLENGE), state, code_verifier: VERIFIER, turnstile_token: TURNSTILE }, freshIp());
    expect(taken.body.email).toEqual({ address: 'member@example.com', usable: false, reason: 'in_use' });
    expect((await call('POST', '/auth/discord/signup', { signup_token: taken.body.signup_token, username: 'takendiscord', turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('DISCORD_EMAIL_IN_USE');
    expect((await call('POST', '/auth/discord/signup', { signup_token: 'bad.token', username: 'x_y', turnstile_token: TURNSTILE }, freshIp())).body.code).toBe('INVALID_SIGNUP_TOKEN');
  });

  it('links and re-authenticates only for the signed-in account', async () => {
    const owner = await signInAs('restricted@example.com');
    expect((await call('POST', '/auth/discord/authorize', { purpose: 'link', code_challenge: CHALLENGE }, {})).body.code).toBe('UNAUTHORIZED');
    const link = await authorize('link', owner);
    expect(new URL(link.url).searchParams.get('prompt')).toBe('consent');
    expect((await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678912', CHALLENGE), state: link.state, code_verifier: VERIFIER }, owner)).body.code).toBe('IDENTITY_IN_USE');
    expect((await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678915', CHALLENGE), state: link.state, code_verifier: VERIFIER }, USER)).body.code).toBe('INVALID_OAUTH_STATE');
    const linked = await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678915', CHALLENGE), state: link.state, code_verifier: VERIFIER }, owner);
    expect(linked.body).toMatchObject({ status: 'linked', identity: { provider: 'discord', username: 'unverifieddiscord' } });
    expect((await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678913', CHALLENGE), state: link.state, code_verifier: VERIFIER }, owner)).body.code).toBe('IDENTITY_IN_USE');

    mockAgeSession(owner.cookie, 3600);
    const reauth = await authorize('reauth', owner);
    expect((await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678912', CHALLENGE), state: reauth.state, code_verifier: VERIFIER }, owner)).body.code).toBe('IDENTITY_MISMATCH');
    const ok = await call('POST', '/auth/discord/callback', { code: mockDiscordCode('80351110224678915', CHALLENGE), state: reauth.state, code_verifier: VERIFIER }, owner);
    expect(ok.body).toEqual({ status: 'reauthenticated' });
    expect((await call('DELETE', '/users/@me/identities/discord', undefined, owner)).status).toBe(204);
  });
});

describe('mock API: premium and domains (milestone-6 §9, §10)', () => {
  const PRIYA = { cookie: mockSessionCookie('48') };

  it('raises the limits for premium', async () => {
    const limits = await call('GET', '/users/@me/limits', undefined, PRIYA);
    expect(limits.body).toMatchObject({
      premium: true,
      storage: { limit: 107374182400 },
      max_file_size_chunked: 5368709120,
      max_file_size_single: 100_000_000 - 1048576,
      max_file_size_single_configured: 524288000,
      custom_domains: { used: 5, limit: 5 },
      upload_keys: { used: 0, limit: 20 },
    });
    const free = await call('GET', '/users/@me/limits');
    expect(free.body).toMatchObject({ premium: false, storage: { limit: 10737418240 }, max_file_size_chunked: 1073741824, custom_domains: { limit: 0 } });
  });

  it('lists domains in every status, with records and serving', async () => {
    const list = await call('GET', '/users/@me/domains', undefined, PRIYA);
    expect(list.body.limit).toBe(5);
    expect(list.body.domain_only).toEqual({ enabled: false, effective: false, paused: false });
    const byHost = Object.fromEntries(list.body.items.map((domain: Item) => [domain.hostname, domain]));
    expect(byHost['i.priya.example']).toMatchObject({ status: 'active', serving: true, is_default: true, scope: 'own' });
    expect(byHost['cdn.priya.example']).toMatchObject({ status: 'pending_dns', serving: false, pending_until: expect.any(Number) });
    expect(byHost['cdn.priya.example'].records).toEqual([
      { type: 'CNAME', name: 'cdn.priya.example', value: 'domains.files.gg', ok: false },
      { type: 'TXT', name: '_filesgg-verify.cdn.priya.example', value: expect.stringMatching(/^filesgg-verify=[a-z2-7]{26}$/), ok: false },
    ]);
    expect(byHost['img.priya.example']).toMatchObject({ status: 'pending_cert', cloudflare: { status: 'active', ssl_status: 'pending_validation' } });
    expect(byHost['old.priya.example']).toMatchObject({ status: 'failing', serving: true, failing_since: expect.any(Number) });
    expect(byHost['dead.priya.example']).toMatchObject({ status: 'failed', status_reason: 'dns_timeout', serving: false });
    expect(byHost['bad.priya.example']).toMatchObject({ status: 'disabled', disabled_reason: 'phishing', serving: false });
    const notices = await call('GET', '/users/@me/warnings', undefined, PRIYA);
    expect(notices.body.items[0]).toMatchObject({ action: 'disable_domain', target: { kind: 'domain', hostname: 'bad.priya.example' } });
    const files = multipart('on-my-domain.png');
    const sent = await call('POST', '/files', files.body, { ...PRIYA, ...files.headers });
    expect(sent.body.url).toMatch(/^https:\/\/i\.priya\.example\/[a-z0-9]+\.png$/);
    expect(sent.body.direct_url).toMatch(/^https:\/\/i\.priya\.example\/files\/[a-z0-9]+\.png$/);
  });

  it('adds a domain that moves from pending_dns to active, with the add rules', async () => {
    expect((await call('POST', '/users/@me/domains', { hostname: 'x.example.com' })).body.code).toBe('PREMIUM_REQUIRED');
    expect((await call('POST', '/users/@me/domains', { hostname: 'new.priya.example' }, PRIYA)).body).toMatchObject({ code: 'DOMAIN_LIMIT_REACHED', limit: 5 });
    const dead = (await call('GET', '/users/@me/domains', undefined, PRIYA)).body.items.find((domain: Item) => domain.hostname === 'dead.priya.example');
    const bad = (await call('GET', '/users/@me/domains', undefined, PRIYA)).body.items.find((domain: Item) => domain.hostname === 'bad.priya.example');
    expect((await call('DELETE', `/users/@me/domains/${bad.id}`, undefined, PRIYA)).body.code).toBe('DOMAIN_DISABLED');
    expect((await call('POST', `/users/@me/domains/${bad.id}/retry`, undefined, PRIYA)).body.code).toBe('DOMAIN_NOT_FAILED');
    expect((await call('DELETE', `/users/@me/domains/${dead.id}`, undefined, PRIYA)).status).toBe(204);
    for (const [hostname, reason] of [['example.com', 'apex'], ['example.co.uk', 'apex'], ['co.uk', 'public_suffix'], ['*.example.com', 'wildcard'], ['192.0.2.1', 'ip'], ['x.files.gg', 'reserved'], ['-bad.example.com', 'syntax']]) {
      expect((await call('POST', '/users/@me/domains', { hostname }, PRIYA)).body, hostname).toMatchObject({ code: 'INVALID_HOSTNAME', reason });
    }
    expect((await call('POST', '/users/@me/domains', { hostname: 'I.Priya.Example.' }, PRIYA)).body.code).toBe('DOMAIN_TAKEN');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const added = await call('POST', '/users/@me/domains', { hostname: 'Bücher.Priya.Example.' }, PRIYA);
      expect(added).toMatchObject({ status: 201, body: { hostname: 'xn--bcher-kva.priya.example', status: 'pending_dns', serving: false, is_default: false } });
      expect((await call('PATCH', `/users/@me/domains/${added.body.id}`, { default: true }, PRIYA)).body.code).toBe('DOMAIN_NOT_ACTIVE');
      expect((await call('POST', `/users/@me/domains/${added.body.id}/verify`, undefined, PRIYA)).status).toBe(200);
      expect((await call('POST', `/users/@me/domains/${added.body.id}/verify`, undefined, PRIYA)).body.code).toBe('DOMAIN_CHECK_RATE_LIMITED');
      vi.setSystemTime(Date.now() + 25_000);
      expect((await call('GET', '/users/@me/domains', undefined, PRIYA)).body.items.find((domain: Item) => domain.id === added.body.id).status).toBe('pending_cert');
      vi.setSystemTime(Date.now() + 20_000);
      const active = (await call('GET', '/users/@me/domains', undefined, PRIYA)).body.items.find((domain: Item) => domain.id === added.body.id);
      expect(active).toMatchObject({ status: 'active', serving: true, verified_at: expect.any(Number) });
      expect(active.records.every((record: Item) => record.ok)).toBe(true);
      expect((await call('PATCH', `/users/@me/domains/${added.body.id}`, { scope: 'any' }, PRIYA)).body.code).toBe('INVALID_PARAMETERS');
      expect((await call('PATCH', `/users/@me/domains/${added.body.id}`, { scope: 'any', confirm: true }, PRIYA)).body.scope).toBe('any');
      expect((await call('PATCH', `/users/@me/domains/${added.body.id}`, { default: true }, PRIYA)).body.is_default).toBe(true);
      const list = (await call('GET', '/users/@me/domains', undefined, PRIYA)).body.items;
      expect(list.filter((domain: Item) => domain.is_default).map((domain: Item) => domain.id)).toEqual([added.body.id]);
      await call('PATCH', `/users/@me/domains/${list.find((domain: Item) => domain.hostname === 'i.priya.example').id}`, { default: true }, PRIYA);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns domain-only mode on with confirmation and the counts', async () => {
    const preview = await call('GET', '/users/@me/domain-only/preview', undefined, PRIYA);
    expect(preview.body).toEqual({ affected_files: expect.any(Number), affected_albums: 0 });
    expect(preview.body.affected_files).toBeGreaterThan(0);
    expect((await call('PUT', '/users/@me/domain-only', { enabled: true }, PRIYA)).body.code).toBe('INVALID_PARAMETERS');
    const on = await call('PUT', '/users/@me/domain-only', { enabled: true, confirm: true }, PRIYA);
    expect(on.body).toMatchObject({ enabled: true, effective: true, paused: false, affected_files: preview.body.affected_files });
    expect((await call('GET', '/users/@me', undefined, PRIYA)).body.settings.domain_only).toBe(true);
    expect((await call('PUT', '/users/@me/domain-only', { enabled: false }, PRIYA)).body.enabled).toBe(false);
    expect((await call('PUT', '/users/@me/domain-only', { enabled: true, confirm: true })).body.code).toBe('PREMIUM_REQUIRED');
  });

  it('puts an owner pass on a serving domain', async () => {
    const files = multipart('passme.png', { visibility: 'private' });
    const sent = await call('POST', '/files', files.body, { ...PRIYA, ...files.headers });
    const domains = (await call('GET', '/users/@me/domains', undefined, PRIYA)).body.items;
    const active = domains.find((domain: Item) => domain.hostname === 'i.priya.example');
    const pending = domains.find((domain: Item) => domain.hostname === 'cdn.priya.example');
    expect((await call('POST', `/users/@me/files/${sent.body.id}/pass`, { domain_id: active.id }, PRIYA)).body.url).toMatch(/^https:\/\/i\.priya\.example\/[a-z0-9]+#t=/);
    expect((await call('POST', `/users/@me/files/${sent.body.id}/pass`, { domain_id: pending.id }, PRIYA)).body.code).toBe('DOMAIN_NOT_ACTIVE');
  });
});

describe('mock API: admin premium, domains and account actions (milestone-6 §9.3, §10.12, §11.4)', () => {
  it('grants, changes and revokes premium (admins only), and shows the account fields', async () => {
    expect((await call('POST', '/admin/users/78/entitlements', { kind: 'premium', note: 'x' }, MODERATOR)).body.code).toBe('FORBIDDEN');
    expect((await call('POST', '/admin/users/78/entitlements', { kind: 'premium', note: 'x' }, MEMBER)).status).toBe(404);
    expect((await call('POST', '/admin/users/78/entitlements', { kind: 'premium' })).body.code).toBe('INVALID_PARAMETERS');
    expect((await call('POST', '/admin/users/78/entitlements', { kind: 'premium', note: 'x', expires_at: 1 })).body.code).toBe('INVALID_PARAMETERS');
    const granted = await call('POST', '/admin/users/78/entitlements', { kind: 'premium', note: 'Beta tester' });
    expect(granted).toMatchObject({ status: 201, body: { kind: 'premium', active: true, granted_by: { id: '42', username: 'mockuser' }, expires_at: null, note: 'Beta tester' } });
    expect((await call('POST', '/admin/users/78/entitlements', { kind: 'premium', note: 'again' })).body.code).toBe('ENTITLEMENT_EXISTS');
    const until = Math.floor(Date.now() / 1000) + 86400;
    expect((await call('PATCH', `/admin/users/78/entitlements/${granted.body.id}`, { expires_at: until, note: 'One day' })).body.expires_at).toBe(until);
    const detail = await call('GET', '/admin/users/78');
    expect(detail.body).toMatchObject({ premium: { active: true, expires_at: until }, sessions: { active: expect.any(Number) }, upload_keys: [], domains: [], deletion: null, identities: [] });
    expect(detail.body.entitlements[0].id).toBe(granted.body.id);
    expect(detail.body.actions.map((row: Item) => row.action)).toEqual(expect.arrayContaining(['grant_entitlement', 'change_entitlement']));
    const revoked = await call('DELETE', `/admin/users/78/entitlements/${granted.body.id}`, { note: 'Ended' });
    expect(revoked.body).toMatchObject({ active: false, revoked_by: { id: '42' } });
    expect((await call('DELETE', `/admin/users/78/entitlements/${granted.body.id}`, { note: 'Again' })).body.code).toBe('UNKNOWN_ENTITLEMENT');
    expect((await call('GET', '/admin/users/48')).body.domains.length).toBeGreaterThan(0);
    expect((await call('GET', '/admin/users/42')).body.identities[0]).toMatchObject({ provider: 'discord', provider_user_id: '80351110224678912' });
  });

  it('lists the domain case and disables, enables and re-scopes a domain', async () => {
    const queue = await call('GET', '/admin/cases?kind=domain', undefined, MODERATOR);
    const item = queue.body.items[0];
    expect(item).toMatchObject({ kind: 'domain', target: { type: 'domain', name: 'i.priya.example', state: 'active' } });
    const detail = await call('GET', `/admin/cases/${item.id}`, undefined, MODERATOR);
    expect(detail.body.target_detail).toMatchObject({ hostname: 'i.priya.example', owner: { id: '48', username: 'priya' }, cf_hostname_id: expect.any(String), cases: [expect.objectContaining({ id: item.id })] });
    const domainId = item.target.id;
    expect((await call('POST', '/admin/actions', { action: 'disable_domain', target: { type: 'domain', id: domainId } }, MODERATOR)).body.code).toBe('INVALID_ACTION');
    const disabled = await call('POST', '/admin/actions', { action: 'disable_domain', target: { type: 'domain', id: domainId }, rule: 'phishing', case_id: item.id }, MODERATOR);
    expect(disabled.body.notice_ids).toHaveLength(1);
    expect((await call('GET', `/admin/domains/${domainId}`, undefined, MODERATOR)).body).toMatchObject({ status: 'disabled', disabled_reason: 'phishing', serving: false });
    expect((await call('GET', '/admin/domains?status=disabled', undefined, MODERATOR)).body.items.length).toBeGreaterThanOrEqual(2);
    expect((await call('POST', '/admin/actions', { action: 'enable_domain', target: { type: 'domain', id: domainId } }, MODERATOR)).status).toBe(200);
    expect((await call('GET', `/admin/domains/${domainId}`, undefined, MODERATOR)).body.status).toBe('active');
    const priya = { cookie: mockSessionCookie('48') };
    const any = (await call('GET', '/users/@me/domains', undefined, priya)).body.items.find((domain: Item) => domain.scope === 'any');
    expect((await call('POST', '/admin/actions', { action: 'set_domain_scope', target: { type: 'domain', id: any.id }, rule: 'spam' })).status).toBe(200);
    expect((await call('GET', `/admin/domains/${any.id}`)).body.scope).toBe('own');
    expect((await call('GET', '/admin/lookup?q=i.priya.example')).body.domains[0]).toMatchObject({ hostname: 'i.priya.example' });
    expect((await call('GET', '/admin/domains/1')).body.code).toBe('UNKNOWN_DOMAIN');
    expect((await call('GET', '/admin/domains', undefined, MEMBER)).status).toBe(404);
  });

  it('revokes sessions and upload keys, and resets usernames', async () => {
    const victim = { cookie: mockSessionCookie('79') };
    expect((await call('POST', '/admin/actions', { action: 'revoke_sessions', target: { type: 'user', id: '79' } }, MODERATOR)).status).toBe(200);
    const gone = await call('GET', '/users/@me', undefined, victim);
    expect(gone).toMatchObject({ status: 401, body: { code: 'UNAUTHORIZED' } });
    expect(gone.headers['set-cookie']).toContain('Max-Age=0');
    const keys = (await call('GET', '/users/@me/upload-keys')).body.items.filter((key: Item) => key.state === 'active');
    expect((await call('POST', '/admin/actions', { action: 'revoke_upload_keys', target: { type: 'user', id: '42' }, details: { key_id: keys[0].id } })).status).toBe(200);
    expect((await call('GET', '/users/@me/upload-keys')).body.items.find((key: Item) => key.id === keys[0].id).state).toBe('revoked');
    expect((await call('POST', '/admin/actions', { action: 'reset_username', target: { type: 'user', id: '77' } })).body.code).toBe('INVALID_ACTION');
    expect((await call('POST', '/admin/actions', { action: 'reset_username', target: { type: 'user', id: '77' }, rule: 'harassment' })).status).toBe(200);
    const tracker = await call('GET', '/users/@me', undefined, { cookie: mockSessionCookie('77') });
    expect(tracker.body).toMatchObject({ username: 'u77', needs_username: true, username_change_available_at: null });
    expect((await call('GET', '/users/@me/username/check?username=tracker99', undefined, {})).body.reason).toBe('taken');
  });
});

// ---------------------------------------------------------------------------
// Milestone 6 §19: view limits
// ---------------------------------------------------------------------------

describe('mock API: view limits (milestone-6 §19)', () => {
  const viewer = (n: number) => ({ 'cf-connecting-ip': `10.19.0.${n}` });
  const open = (vanity: string, headers: Record<string, string> = viewer(1), token: string = TURNSTILE) =>
    call('POST', `/access/open/files/${vanity}`, { turnstile_token: token }, headers);
  const ownFile = async (name: string): Promise<Item> =>
    (await call('GET', `/users/@me/files?query=${encodeURIComponent(name)}&limit=100`)).body.items.find((file: Item) => file.filename.startsWith(name));
  let uploads = 0;
  /** A fresh upload of Mock User (scanned at once), then a fresh limit through PATCH. */
  const limited = async (limit: number, action: 'expire' | 'private' = 'expire') => {
    const name = `view-limit-${++uploads}`;
    const upload = multipart(`${name}.zip`);
    const scan = [process.env.MOCK_SCAN_MS, process.env.MOCK_DERIVE_MS];
    process.env.MOCK_SCAN_MS = '0';
    process.env.MOCK_DERIVE_MS = '0';
    try {
      expect((await call('POST', '/files', upload.body, { ...USER, ...upload.headers })).status).toBe(200);
    } finally {
      for (const [key, value] of [['MOCK_SCAN_MS', scan[0]], ['MOCK_DERIVE_MS', scan[1]]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    const file = await ownFile(name);
    const set = await call('PATCH', `/users/@me/files/${file.id}`, { view_limit: limit, view_limit_action: action });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ view_limit: limit, view_limit_action: action, views_used: 0 });
    return { ...(set.body as Item), name };
  };

  it('3 viewers on a limit of 3: the third still gets the file, then it expires and a fourth gets missing', async () => {
    const file = await limited(3);
    const first = await open(file.vanity, viewer(101));
    expect(first.status).toBe(200);
    expect(first.body.file.view_limit).toEqual({ remaining: 2 });
    expect(first.body.file.cdn_url).toMatch(/[?&]expires=\d+&sig=/);
    expect(first.body.expires_at - Date.now() / 1000).toBeLessThanOrEqual(3600);
    expect((await open(file.vanity, viewer(102))).body.file.view_limit).toEqual({ remaining: 1 });
    const third = await open(file.vanity, viewer(103));
    expect(third.status).toBe(200);
    expect(third.body.file.view_limit).toEqual({ remaining: 0 });
    const fourth = await open(file.vanity, viewer(104));
    expect(fourth).toMatchObject({ status: 404, body: { code: 'UNKNOWN_FILE' } });
    // Never described as "view limit reached".
    expect(JSON.stringify(fourth.body)).not.toMatch(/limit/i);
    // The last viewer keeps it for their URLs' hour; the owner sees it expiring within the hour.
    expect((await open(file.vanity, viewer(103))).status).toBe(200);
    const owner = await ownFile(file.name);
    expect(owner).toMatchObject({ views_used: 3, view_limit: 3 });
    expect(owner.expires_at - Date.now() / 1000).toBeLessThanOrEqual(3600);
  });

  it('one viewer opening 5 times uses 1 view; the owner and staff never count', async () => {
    const file = await limited(2);
    for (let i = 0; i < 5; i++) expect((await open(file.vanity, viewer(110))).status).toBe(200);
    expect((await ownFile(file.name)).views_used).toBe(1);
    expect((await open(file.vanity, { ...USER, ...viewer(111) })).body.file.view_limit).toEqual({ remaining: 1 });
    expect((await open(file.vanity, { ...MODERATOR, ...viewer(112) })).status).toBe(200);
    expect((await ownFile(file.name)).views_used).toBe(1);
  });

  it('the private action hides it from everyone but the owner and bumps access_version', async () => {
    const file = await limited(1, 'private');
    expect((await open(file.vanity, viewer(120))).status).toBe(200);
    const after = await ownFile(file.name);
    expect(after).toMatchObject({ visibility: 'private', views_used: 1, view_limit: 1, view_limit_action: 'private' });
    expect(after.access_version).toBe(file.access_version + 1);
    expect((await open(file.vanity, viewer(121))).status).toBe(404);
    expect((await open(file.vanity, viewer(120))).status).toBe(404);
    expect((await open(file.vanity, { ...USER, ...viewer(122) })).status).toBe(200);
    // Raising the limit and changing visibility back shares it again; the count stays.
    const raised = await call('PATCH', `/users/@me/files/${file.id}`, { view_limit: 3, visibility: 'link' });
    expect(raised.body).toMatchObject({ view_limit: 3, views_used: 1, visibility: 'link' });
  });

  it('refuses a limit at or below views_used (VIEW_LIMIT_TOO_LOW), and removes one with null', async () => {
    const file = await limited(5);
    await open(file.vanity, viewer(130));
    await open(file.vanity, viewer(131));
    const low = await call('PATCH', `/users/@me/files/${file.id}`, { view_limit: 2 });
    expect(low).toMatchObject({ status: 400, body: { code: 'VIEW_LIMIT_TOO_LOW', views_used: 2, errors: { view_limit: expect.any(String) } } });
    expect((await call('PATCH', `/users/@me/files/${file.id}`, { view_limit: 3 })).body).toMatchObject({ view_limit: 3, views_used: 2 });
    expect((await call('PATCH', `/users/@me/files/${file.id}`, { view_limit: 0 })).body.code).toBe('INVALID_PARAMETERS');
    expect((await call('PATCH', `/users/@me/files/${file.id}`, { view_limit: null })).body).toMatchObject({ view_limit: null, views_used: 2 });
  });

  it('needs Turnstile (action view) before anything else', async () => {
    expect((await open('limited1', viewer(140), 'nope')).body.code).toBe('CAPTCHA_INVALID');
    expect((await call('POST', '/access/open/files/limited1', {}, viewer(140))).status).toBe(403);
  });

  it('a password file answers UNLOCK_REQUIRED, and a successful unlock counts as the view', async () => {
    expect((await open('limitedpw', viewer(150))).body.code).toBe('UNLOCK_REQUIRED');
    const before = (await ownFile('limited-notes')).views_used;
    const unlock = await call('POST', '/access/unlock/files/limitedpw', { password: 'files.gg', turnstile_token: TURNSTILE }, viewer(150));
    expect(unlock.status).toBe(200);
    expect(unlock.body.file.view_limit).toEqual({ remaining: 5 - before - 1 });
    expect((await ownFile('limited-notes')).views_used).toBe(before + 1);
    // With the unlock token, /open serves it without counting again.
    const reopened = await open('limitedpw', { ...viewer(150), 'x-filesgg-access': unlock.body.token });
    expect(reopened.status).toBe(200);
    expect((await ownFile('limited-notes')).views_used).toBe(before + 1);
  });

  it('takes view_limit on uploads; anonymous uploads can\'t choose private', async () => {
    const signedIn = multipart('limited-upload.png', { view_limit: '4', view_limit_action: 'private' });
    const sent = await call('POST', '/files', signedIn.body, { ...USER, ...signedIn.headers });
    expect(sent.status).toBe(200);
    expect((await ownFile('limited-upload')).view_limit).toBe(4);

    const anon = { 'x-fingerprint': 'fp-view-limit' };
    const refused = multipart('anon-limit.png', { turnstile_token: TURNSTILE, view_limit: '2', view_limit_action: 'private' });
    expect((await call('POST', '/files', refused.body, { ...anon, ...refused.headers })).body.code).toBe('PRIVATE_REQUIRES_ACCOUNT');
    const allowed = multipart('anon-limit.png', { turnstile_token: TURNSTILE, view_limit: '2' });
    expect((await call('POST', '/files', allowed.body, { ...anon, ...allowed.headers })).status).toBe(200);
    const range = multipart('anon-limit.png', { turnstile_token: TURNSTILE, view_limit: '1001' });
    expect((await call('POST', '/files', range.body, { ...anon, ...range.headers })).body.code).toBe('INVALID_PARAMETERS');
    const chunked = await call('POST', '/uploads', { filename: 'big.bin', size: 20 * 1024 * 1024, view_limit: 9, view_limit_action: 'expire' });
    expect(chunked.status).toBe(201);
  });

  it('view-limited files are hidden in albums, and shown as hidden to the owner', async () => {
    const albums = await call('GET', '/users/@me/albums');
    const lisbon = albums.body.items.find((album: Item) => album.title === 'Lisbon, November');
    const detail = await call('GET', `/users/@me/albums/${lisbon.id}`);
    const item = detail.body.items.find((each: Item) => each.filename === 'limited-photo.png');
    expect(item).toMatchObject({ shown: false, view_limit: 3, hidden_reason: 'view_limit' });
    const publicView = await call('GET', `/albums/${lisbon.vanity}`, undefined, {});
    expect(publicView.body.items.some((each: Item) => each.filename === 'limited-photo.png')).toBe(false);
  });
});
