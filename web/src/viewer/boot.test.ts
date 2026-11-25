import { describe, expect, it } from 'vitest';

import { normalizeKind, parseAlbumData, parseBoot, parseFileData, readBootInput } from './boot';

const file = {
  kind: 'image',
  filename: 'cat.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 1234,
  width: 800,
  height: 600,
  cdn_url: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  uploaded_at: 1_700_000_000,
  expires_at: null,
};

describe('parseBoot', () => {
  it('reads a custom domain\'s landing card (milestone-6 §10.8)', () => {
    expect(parseBoot({ page: 'domain-home', state: 'missing' })).toEqual({ page: 'domain-home' });
  });

  it('shows the home card for data-page="home", even with other data present', () => {
    expect(parseBoot({ page: 'home', state: 'unavailable', fileJson: JSON.stringify(file) })).toEqual({ page: 'home' });
  });

  it('shows unavailable for data-state="unavailable"', () => {
    expect(parseBoot({ page: 'file', state: 'unavailable', fileJson: null })).toEqual({ page: 'unavailable' });
  });

  it('unavailable wins over a file payload', () => {
    expect(parseBoot({ state: 'unavailable', fileJson: JSON.stringify(file) }).page).toBe('unavailable');
  });

  it('shows the file card when the payload is a valid file', () => {
    const state = parseBoot({ page: 'file', state: 'file', fileJson: JSON.stringify(file) });
    expect(state.page).toBe('file');
    if (state.page === 'file') {
      expect(state.file).toMatchObject({ kind: 'image', filename: 'cat.png', width: 800, height: 600, uploaded_at: 1_700_000_000, expires_at: null });
    }
  });

  it.each([
    ['a null payload', 'null'],
    ['no script tag', null],
    ['an empty script tag', '   '],
    ['malformed JSON', '{"kind":'],
    ['an array', '[]'],
    ['a payload without cdn_url', JSON.stringify({ ...file, cdn_url: undefined })],
    ['a payload without filename', JSON.stringify({ ...file, filename: '' })],
  ])('treats %s as missing', (_label, fileJson) => {
    expect(parseBoot({ page: 'file', fileJson })).toEqual({ page: 'missing' });
  });

  it('honours an explicit data-state="missing"', () => {
    expect(parseBoot({ state: 'missing', fileJson: JSON.stringify(file) })).toEqual({ page: 'missing' });
  });
});

describe('parseFileData', () => {
  it('falls back to the generic kind for unknown kinds', () => {
    expect(parseFileData({ ...file, kind: 'hologram' })?.kind).toBe('file');
    expect(normalizeKind(undefined)).toBe('file');
  });

  it('drops invalid dimensions; numbers must be numbers', () => {
    const parsed = parseFileData({ ...file, width: 0, height: -5, size: '2048', expires_at: 1_800_000_000 });
    expect(parsed?.width).toBeUndefined();
    expect(parsed?.height).toBeUndefined();
    expect(parsed?.size).toBe(0);
    expect(parsed?.expires_at).toBe(1_800_000_000);
  });

  it('reads only the snake_case payload (contract §4), not the old camelCase or ISO spellings', () => {
    const old = {
      kind: 'image',
      filename: 'cat.png',
      cdnUrl: 'https://cdn.files.gg/files/abc.png',
      uploadedAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000,
      hoverUrl: 'https://cdn.files.gg/x.mp4',
    };
    expect(parseFileData(old)).toBeNull();
    const parsed = parseFileData({ ...old, cdn_url: old.cdnUrl, created_at: 1_700_000_000, expires_at: '2026-11-24T00:00:00Z' });
    expect(parsed).toMatchObject({ uploaded_at: 0, expires_at: null, hover_url: undefined });
  });

  it('keeps signed URLs exactly as they arrive', () => {
    const signed = (path: string) => `https://cdn.files.gg${path}?v=5&expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8`;
    const parsed = parseFileData({
      ...file,
      visibility: 'password',
      cdn_url: 'https://cdn.files.gg/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8',
      assets: { thumb: { url: signed('/previews/thumb/abc.webp') }, hover: { url: signed('/previews/hover/abc.mp4') } },
      thumbnail: { url: signed('/previews/thumb/abc.webp'), type: 'thumb' },
    });
    expect(parsed?.cdn_url).toBe('https://cdn.files.gg/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8');
    expect(parsed?.assets?.thumb?.url).toBe(signed('/previews/thumb/abc.webp'));
    expect(parsed?.thumbnail?.url).toBe(signed('/previews/thumb/abc.webp'));
    expect(parsed?.hover_url).toBe(signed('/previews/hover/abc.mp4'));
  });

  it('derives extension and mimetype defaults', () => {
    const parsed = parseFileData({ filename: 'notes.tar.gz', cdn_url: 'https://cdn.files.gg/files/x.gz' });
    expect(parsed).toMatchObject({
      kind: 'file',
      extension: 'gz',
      mimetype: 'application/octet-stream',
      size: 0,
      uploaded_at: 0,
      expires_at: null,
    });
  });

  it('keeps a valid thumbnail and drops an invalid one', () => {
    expect(parseFileData({ ...file, thumbnail: { url: 'https://x/y.webp', type: 'cover' } })?.thumbnail).toEqual({
      url: 'https://x/y.webp',
      type: 'cover',
    });
    expect(parseFileData({ ...file, thumbnail: { type: 'cover' } })?.thumbnail).toBeUndefined();
  });
});

describe('readBootInput', () => {
  it('reads data attributes and the #file-data script from the document', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = `<div id="root" data-page="file" data-state="file"></div><script id="file-data" type="application/json">${JSON.stringify(file)}</script>`;
    const input = readBootInput(doc);
    expect(input.page).toBe('file');
    expect(input.state).toBe('file');
    expect(parseBoot(input).page).toBe('file');
  });

  it('returns nulls for an empty shell', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = '<div id="root"></div>';
    expect(readBootInput(doc)).toEqual({ page: null, state: null, fileJson: null, albumJson: null, reportJson: null });
  });
});

describe('parseBoot: convert and album pages', () => {
  /** ms; payload times are seconds. */
  const NOW = 1_800_000_000_000;
  const NOW_S = NOW / 1000;
  const album = {
    vanity: 'Ab3dE6gH',
    url: 'https://files.gg/a/Ab3dE6gH',
    title: 'Trip',
    description: 'Photos',
    layout: 'grid',
    nsfw: false,
    expires_at: null,
    items: [
      { ...file, filename: 'b.png', position: 1, caption: 'second' },
      { ...file, filename: 'a.png', position: 0, caption: 'first' },
    ],
  };

  it('shows the convert placeholder for data-page="convert"', () => {
    expect(parseBoot({ page: 'convert' })).toEqual({ page: 'convert' });
  });

  it('boots an album from #album-data', () => {
    const state = parseBoot({ page: 'album', albumJson: JSON.stringify(album) }, NOW);
    expect(state.page).toBe('album');
    if (state.page === 'album') {
      expect(state.album.items.map((i) => i.filename)).toEqual(['a.png', 'b.png']);
      expect(state.album.items[0]?.caption).toBe('first');
      expect(state.album.count).toBe(2);
      expect(state.album.total_size).toBe(2468);
    }
  });

  it('unavailable and missing still win over album data', () => {
    expect(parseBoot({ page: 'album', state: 'unavailable', albumJson: JSON.stringify(album) }).page).toBe('unavailable');
    expect(parseBoot({ page: 'album', state: 'missing', albumJson: JSON.stringify(album) }).page).toBe('missing');
  });

  it.each([
    ['no script tag', null],
    ['null', 'null'],
    ['malformed JSON', '{'],
    ['no vanity', JSON.stringify({ ...album, vanity: '' })],
    ['no items', JSON.stringify({ ...album, items: [] })],
    ['only invalid items', JSON.stringify({ ...album, items: [{ filename: 'x' }] })],
    ['an expired album', JSON.stringify({ ...album, expires_at: NOW_S - 1 })],
    ['an album expiring right now', JSON.stringify({ ...album, expires_at: NOW_S })],
    ['only expired items', JSON.stringify({ ...album, items: [{ ...file, expires_at: NOW_S - 1 }] })],
  ])('treats an album with %s as missing', (_label, albumJson) => {
    expect(parseBoot({ page: 'album', albumJson }, NOW)).toEqual({ page: 'missing' });
  });
});

describe('parseAlbumData', () => {
  const NOW = Date.UTC(2026, 10, 24);
  const NOW_S = NOW / 1000;
  const base = { vanity: 'v', items: [{ ...file, position: 0 }] };

  it('drops expired items but keeps the rest', () => {
    const parsed = parseAlbumData(
      { ...base, items: [{ ...file, expires_at: NOW_S - 1 }, { ...file, filename: 'ok.png', expires_at: NOW_S + 1 }] },
      NOW,
    );
    expect(parsed?.items.map((i) => i.filename)).toEqual(['ok.png']);
  });

  it('reads snake_case fields with epoch-second times only', () => {
    expect(parseAlbumData({ ...base, expires_at: NOW_S + 60 }, NOW)?.expires_at).toBe(NOW_S + 60);
    expect(parseAlbumData({ ...base, expires_at: new Date(NOW + 60_000).toISOString() }, NOW)?.expires_at).toBeNull();
    expect(parseAlbumData({ ...base, total_size: 99, next_cursor: 'c2' }, NOW)).toMatchObject({ total_size: 99, next_cursor: 'c2' });
    expect(parseAlbumData({ ...base, totalSize: 99, nextCursor: 'c2', downloadUrl: 'https://x' }, NOW)).toMatchObject({
      total_size: 1234,
      next_cursor: null,
      download_url: undefined,
    });
  });

  it('defaults layout, nsfw, title and captions, and caps text lengths', () => {
    const parsed = parseAlbumData({ ...base, layout: 'carousel', nsfw: 'yes', title: 't'.repeat(150), items: [{ ...file, caption: 7 }] }, NOW);
    expect(parsed).toMatchObject({ layout: 'auto', nsfw: false, description: '' });
    expect(parsed?.title).toHaveLength(100);
    expect(parsed?.items[0]?.caption).toBe('');
  });

  it('uses array order when position is missing, and count from the payload when larger', () => {
    const parsed = parseAlbumData({ ...base, count: 250, items: [{ ...file, filename: '1.png' }, { ...file, filename: '2.png' }] }, NOW);
    expect(parsed?.items.map((i) => [i.filename, i.position])).toEqual([
      ['1.png', 0],
      ['2.png', 1],
    ]);
    expect(parsed?.count).toBe(250);
  });

  it('parses media, thumbnails and hover clips on items', () => {
    const parsed = parseAlbumData(
      {
        ...base,
        items: [
          {
            ...file,
            kind: 'audio',
            hover_url: 'https://cdn/x/hover.mp4',
            media: { duration: 4000, tags: { title: 'Song', artist: 'Band', track: 2 }, pages: 0, playable: true },
            thumbnail: { url: 'https://cdn/x/cover.webp', type: 'cover', width: 400, height: 400 },
          },
        ],
      },
      NOW,
    );
    const item = parsed?.items[0];
    expect(item?.hover_url).toBe('https://cdn/x/hover.mp4');
    expect(item?.media).toMatchObject({ duration: 4000, tags: { title: 'Song', artist: 'Band', track: 2 }, playable: true });
    expect(item?.media?.pages).toBeUndefined();
    expect(item?.duration).toBe(4000);
    expect(item?.thumbnail).toEqual({ url: 'https://cdn/x/cover.webp', type: 'cover', width: 400, height: 400 });
  });
});

describe('parseBoot: locked (contract §4)', () => {
  it('parses a locked file, with the name only when present', () => {
    expect(parseBoot({ page: 'file', state: 'locked', fileJson: '{"vanity":"abc","protected":"password"}' })).toEqual({
      page: 'locked',
      target: { kind: 'file', vanity: 'abc', name: undefined, passwordExpired: false },
    });
    expect(
      parseBoot({ page: 'file', state: 'locked', fileJson: '{"vanity":"abc","protected":"password","filename":"a.png"}' }),
    ).toMatchObject({ page: 'locked', target: { name: 'a.png' } });
  });

  it('parses password_expired', () => {
    expect(
      parseBoot({ page: 'file', state: 'locked', fileJson: '{"vanity":"abc","protected":"password","password_expired":true}' }),
    ).toMatchObject({ page: 'locked', target: { passwordExpired: true } });
  });

  it('parses a locked album from #album-data, with its title', () => {
    expect(
      parseBoot({ page: 'album', state: 'locked', albumJson: '{"vanity":"alb","protected":"password","title":"Trip"}' }),
    ).toEqual({ page: 'locked', target: { kind: 'album', vanity: 'alb', name: 'Trip', passwordExpired: false } });
  });

  it('treats a malformed locked payload as missing', () => {
    expect(parseBoot({ page: 'file', state: 'locked', fileJson: '{"protected":"password"}' })).toEqual({ page: 'missing' });
    expect(parseBoot({ page: 'file', state: 'locked', fileJson: '{"vanity":"a","protected":"private"}' })).toEqual({ page: 'missing' });
    expect(parseBoot({ page: 'file', state: 'locked', fileJson: null })).toEqual({ page: 'missing' });
  });

  it('private files are plain missing (null payload)', () => {
    expect(parseBoot({ page: 'file', state: 'missing', fileJson: 'null' })).toEqual({ page: 'missing' });
  });

  it('keeps visibility on file payloads', () => {
    expect(parseFileData({ ...file, visibility: 'password' })?.visibility).toBe('password');
    expect(parseFileData({ ...file, visibility: 'public' })?.visibility).toBeUndefined();
  });
});

describe('milestone 3 payload fields', () => {
  it('parses assets, keeping only the contract §3 preview kinds with a URL', () => {
    const parsed = parseFileData({
      ...file,
      assets: {
        thumb: { url: 'https://cdn.files.gg/previews/thumb/abc.webp?v=2', width: 320, height: 240 },
        'thumb-2x': { url: 'https://cdn.files.gg/previews/thumb-2x/abc.webp?v=2', width: -1 },
        display: { url: 'https://cdn.files.gg/previews/display/abc.webp?v=2' },
        poster: 'https://cdn.files.gg/previews/poster/abc.webp?v=2',
        'thumb@2x': { url: 'https://cdn.files.gg/old/thumb@2x.webp' },
        preview: { url: 'https://cdn.files.gg/old/preview.webp' },
        peaks: { url: '' },
        bogus: { url: 'https://cdn.files.gg/x' },
        hover: null,
      },
    });
    expect(parsed?.assets).toEqual({
      thumb: { url: 'https://cdn.files.gg/previews/thumb/abc.webp?v=2', width: 320, height: 240 },
      'thumb-2x': { url: 'https://cdn.files.gg/previews/thumb-2x/abc.webp?v=2', width: undefined, height: undefined },
      display: { url: 'https://cdn.files.gg/previews/display/abc.webp?v=2', width: undefined, height: undefined },
    });
  });

  it('drops assets that are empty or not an object, and fills hover_url from assets.hover', () => {
    expect(parseFileData({ ...file, assets: {} })?.assets).toBeUndefined();
    expect(parseFileData({ ...file, assets: ['x'] })?.assets).toBeUndefined();
    const parsed = parseFileData({ ...file, assets: { hover: { url: 'https://cdn.files.gg/previews/hover/abc.mp4?v=2' } } });
    expect(parsed?.hover_url).toBe('https://cdn.files.gg/previews/hover/abc.mp4?v=2');
  });

  it('parses media.language (lowercased) and snippet', () => {
    const parsed = parseFileData({ ...file, kind: 'text', media: { lines: 40, language: 'Python', snippet: 'import os\n' } });
    expect(parsed?.media).toMatchObject({ lines: 40, language: 'python', snippet: 'import os\n' });
    expect(parseFileData({ ...file, media: { language: null, snippet: 3 } })?.media).toMatchObject({
      language: undefined,
      snippet: undefined,
    });
  });

  it('parses the album id, visibility, collage and download_url, signed URLs untouched', () => {
    const sig = 'expires=1796204800&sig=wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA';
    const album = parseAlbumData({
      id: '987654321098765432',
      vanity: 'Ab3dE6gH',
      visibility: 'password',
      collage: { url: `https://cdn.files.gg/albums/collage/Ab3dE6gH.webp?v=5&${sig}`, width: 1200, height: 630 },
      download_url: `https://cdn.files.gg/albums/download/Ab3dE6gH.zip?${sig}`,
      items: [{ ...file, cdn_url: `https://cdn.files.gg/files/abc.png?album=Ab3dE6gH&${sig}` }],
    });
    expect(album).toMatchObject({
      id: '987654321098765432',
      visibility: 'password',
      collage: { url: `https://cdn.files.gg/albums/collage/Ab3dE6gH.webp?v=5&${sig}`, width: 1200, height: 630 },
      download_url: `https://cdn.files.gg/albums/download/Ab3dE6gH.zip?${sig}`,
    });
    expect(album?.items[0]?.cdn_url).toBe(`https://cdn.files.gg/files/abc.png?album=Ab3dE6gH&${sig}`);
    const bare = parseAlbumData({ id: 123, vanity: 'v1', visibility: 'secret', collage: { width: 1 }, items: [file] });
    expect(bare?.id).toBeUndefined();
    expect(bare?.visibility).toBeUndefined();
    expect(bare?.collage).toBeUndefined();
    expect(bare?.download_url).toBeUndefined();
  });
});

describe('milestone 4 boot states (milestone-4 §10.1, §11.1)', () => {
  const json = (value: unknown) => JSON.stringify(value);

  it('parses pending files and albums', () => {
    expect(parseBoot({ page: 'file', state: 'pending', fileJson: json({ vanity: 'abc', pending: true }) })).toEqual({
      page: 'pending',
      target: { kind: 'file', vanity: 'abc' },
    });
    expect(parseBoot({ page: 'album', state: 'pending', albumJson: json({ vanity: 'Ab3', pending: true }) })).toEqual({
      page: 'pending',
      target: { kind: 'album', vanity: 'Ab3' },
    });
  });

  it('parses removed files and albums, with each public reason', () => {
    for (const reason of ['review', 'terms', 'copyright', 'malware']) {
      expect(parseBoot({ page: 'file', state: 'removed', fileJson: json({ vanity: 'abc', removed: reason }) })).toEqual({
        page: 'removed',
        target: { kind: 'file', vanity: 'abc' },
        reason,
      });
    }
    expect(parseBoot({ page: 'album', state: 'removed', albumJson: json({ vanity: 'Ab3', removed: 'terms' }) })).toMatchObject({
      page: 'removed',
      target: { kind: 'album', vanity: 'Ab3' },
    });
  });

  it('keeps anything malformed missing', () => {
    const cases = [
      { page: 'file', state: 'pending', fileJson: json({ vanity: 'abc' }) },
      { page: 'file', state: 'pending', fileJson: json({ pending: true }) },
      { page: 'file', state: 'pending', fileJson: 'not json' },
      { page: 'file', state: 'removed', fileJson: json({ vanity: 'abc', removed: 'because' }) },
      { page: 'file', state: 'removed', fileJson: json({ vanity: 'abc' }) },
      { page: 'album', state: 'removed', albumJson: null },
      { page: 'report', reportJson: json({ type: 'file' }) },
      { page: 'report', reportJson: json({ type: 'user', vanity: 'x' }) },
      { page: 'report', reportJson: null },
    ];
    for (const input of cases) expect(parseBoot(input)).toEqual({ page: 'missing' });
  });

  it('CSAM-blocked files arrive as plain missing and parse exactly like an unknown vanity', () => {
    expect(parseBoot({ page: 'file', state: 'missing', fileJson: 'null' })).toEqual(parseBoot({ page: 'file', state: 'missing' }));
  });

  it('parses the report page targets', () => {
    expect(parseBoot({ page: 'report', reportJson: json({ type: 'any' }) })).toEqual({ page: 'report', target: { type: 'any' } });
    expect(parseBoot({ page: 'report', reportJson: json({ type: 'file', vanity: 'abcd/xyz' }) })).toEqual({
      page: 'report',
      target: { type: 'file', vanity: 'abcd/xyz' },
    });
    expect(parseBoot({ page: 'report', reportJson: json({ type: 'album', vanity: 'Ab3' }) })).toEqual({
      page: 'report',
      target: { type: 'album', vanity: 'Ab3' },
    });
  });

  it('reads #report-data from the document', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.body.innerHTML = '<div id="root" data-page="report"></div><script id="report-data" type="application/json">{"type":"any"}</script>';
    expect(parseBoot(readBootInput(doc))).toEqual({ page: 'report', target: { type: 'any' } });
  });

  it('parses nsfw, known warnings and http(s) link warnings', () => {
    const parsed = parseFileData({
      ...file,
      nsfw: true,
      warnings: ['encrypted_archive', 'mystery', 'unwanted_software', 'encrypted_archive'],
      link_warnings: ['https://a.example/x', 'javascript:alert(1)', 42, 'http://b.example/'],
    });
    expect(parsed?.nsfw).toBe(true);
    expect(parsed?.warnings).toEqual(['unwanted_software', 'encrypted_archive']);
    expect(parsed?.link_warnings).toEqual(['https://a.example/x', 'http://b.example/']);
    const plain = parseFileData(file);
    expect(plain?.nsfw).toBeUndefined();
    expect(plain?.warnings).toBeUndefined();
    expect(plain?.link_warnings).toBeUndefined();
  });

  it('caps link warnings at 20', () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://x.example/${i}`);
    expect(parseFileData({ ...file, link_warnings: urls })?.link_warnings).toHaveLength(20);
  });

  it('serve_inline: false makes any file a download card with no previews', () => {
    const parsed = parseFileData({
      ...file,
      serve_inline: false,
      thumbnail: { url: 'https://cdn.files.gg/previews/thumb/abc.webp', type: 'thumb' },
      assets: { thumb: { url: 'https://cdn.files.gg/previews/thumb/abc.webp' } },
      hover_url: 'https://cdn.files.gg/previews/hover/abc.mp4',
    });
    expect(parsed).toMatchObject({ kind: 'file', thumbnail: undefined, assets: undefined, hover_url: undefined });
  });

  it('parses album link warnings', () => {
    const album = parseAlbumData({ vanity: 'v', items: [{ ...file, position: 0 }], link_warnings: ['https://bad.example/'] });
    expect(album?.link_warnings).toEqual(['https://bad.example/']);
  });
});
