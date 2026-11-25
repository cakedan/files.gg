import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { cdnSignature, MOCK_API_PREFIX, mockApiMiddleware, signCdnUrl, signToken, verifyToken } from './mock-api';

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

const USER = { authorization: 'mock' };

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = USER): Promise<Reply> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(payload), {
    method,
    url: `${MOCK_API_PREFIX}${path}`,
    headers: { host: 'localhost:5173', 'content-type': 'application/json', ...headers },
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
    const unlock = await call('POST', '/files/locked1234/unlock', { password: 'files.gg', turnstile_token: turnstile }, {});
    expect(unlock.status).toBe(200);
    expect(unlock.body).toMatchObject({ token: expect.any(String), expires_at: expect.any(Number), file: { filename: 'holiday.png' } });
    const url = new URL(unlock.body.file.cdn_url);
    expect(url.searchParams.get('expires')).toBe(String(unlock.body.expires_at));
    expect(url.searchParams.get('sig')).toBe(cdnSignature(url.pathname, unlock.body.expires_at, 'file:1234567890123456789:0'));
    expect(unlock.body.file.cdn_url).not.toContain('t=');

    const view = await call('GET', '/files/locked1234/view', undefined, { 'x-filesgg-access': unlock.body.token });
    expect(view.body).toMatchObject({ token: unlock.body.token, expires_at: unlock.body.expires_at, file: { cdn_url: unlock.body.file.cdn_url } });
    const refresh = await call('POST', '/files/locked1234/unlock/refresh', { token: unlock.body.token }, {});
    expect(refresh.body).toMatchObject({ token: expect.any(String), expires_at: expect.any(Number), file: { filename: 'holiday.png' } });
    expect(new URL(refresh.body.file.cdn_url).searchParams.get('expires')).toBe(String(refresh.body.expires_at));

    const album = await call('POST', '/albums/lockedalbum/unlock', { password: 'files.gg', turnstile_token: turnstile }, {});
    expect(album.body.album.download_url).toMatch(/^https:\/\/cdn\.files\.gg\/albums\/download\/lockedalbum\.zip\?expires=\d+&sig=/);
    for (const item of album.body.album.items) expect(item.cdn_url).toMatch(/\?album=lockedalbum&expires=\d+&sig=/);
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
    const unlock = await call('POST', `/files/${access.body.items[1].vanity}/unlock`, { password: access.body.password, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, {});
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
