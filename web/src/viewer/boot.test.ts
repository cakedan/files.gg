import { describe, expect, it } from 'vitest';

import { normalizeKind, parseAlbumData, parseBoot, parseFileData, parseTimestamp, readBootInput } from './boot';

const file = {
  kind: 'image',
  filename: 'cat.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 1234,
  width: 800,
  height: 600,
  cdnUrl: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  uploadedAt: 1_700_000_000_000,
  expiresAt: null,
};

describe('parseBoot', () => {
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
      expect(state.file).toMatchObject({ kind: 'image', filename: 'cat.png', width: 800, height: 600, expiresAt: null });
    }
  });

  it.each([
    ['a null payload', 'null'],
    ['no script tag', null],
    ['an empty script tag', '   '],
    ['malformed JSON', '{"kind":'],
    ['an array', '[]'],
    ['a payload without cdnUrl', JSON.stringify({ ...file, cdnUrl: undefined })],
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

  it('drops invalid dimensions and coerces numeric strings', () => {
    const parsed = parseFileData({ ...file, width: 0, height: -5, size: '2048', expiresAt: '1700000000000' });
    expect(parsed?.width).toBeUndefined();
    expect(parsed?.height).toBeUndefined();
    expect(parsed?.size).toBe(2048);
    expect(parsed?.expiresAt).toBe(1_700_000_000_000);
  });

  it('derives extension and mimetype defaults', () => {
    const parsed = parseFileData({ filename: 'notes.tar.gz', cdnUrl: 'https://cdn.files.gg/files/x.gz' });
    expect(parsed).toMatchObject({
      kind: 'file',
      extension: 'gz',
      mimetype: 'application/octet-stream',
      size: 0,
      uploadedAt: 0,
      expiresAt: null,
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
    expect(readBootInput(doc)).toEqual({ page: null, state: null, fileJson: null, albumJson: null });
  });
});

describe('parseBoot: convert and album pages', () => {
  const NOW = 1_800_000_000_000;
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
      expect(state.album.totalSize).toBe(2468);
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
    ['an expired album', JSON.stringify({ ...album, expires_at: NOW - 1 })],
    ['only expired items', JSON.stringify({ ...album, items: [{ ...file, expiresAt: NOW - 1 }] })],
  ])('treats an album with %s as missing', (_label, albumJson) => {
    expect(parseBoot({ page: 'album', albumJson }, NOW)).toEqual({ page: 'missing' });
  });
});

describe('parseAlbumData', () => {
  const NOW = Date.UTC(2026, 10, 24);
  const base = { vanity: 'v', items: [{ ...file, position: 0 }] };

  it('drops expired items but keeps the rest', () => {
    const parsed = parseAlbumData(
      { ...base, items: [{ ...file, expiresAt: NOW - 1 }, { ...file, filename: 'ok.png', expiresAt: NOW + 1 }] },
      NOW,
    );
    expect(parsed?.items.map((i) => i.filename)).toEqual(['ok.png']);
  });

  it('accepts camelCase and snake_case, ISO and ms timestamps', () => {
    const iso = new Date(NOW + 60_000).toISOString();
    expect(parseAlbumData({ ...base, expires_at: iso }, NOW)?.expiresAt).toBe(NOW + 60_000);
    expect(parseAlbumData({ ...base, expiresAt: NOW + 5 }, NOW)?.expiresAt).toBe(NOW + 5);
    expect(parseAlbumData({ ...base, total_size: 99, next_cursor: 'c2' }, NOW)).toMatchObject({ totalSize: 99, nextCursor: 'c2' });
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
            media: { duration: '4000', tags: { title: 'Song', artist: 'Band', track: 2 }, pages: 0, playable: true },
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

describe('parseTimestamp', () => {
  it('accepts ms numbers, numeric strings and ISO strings', () => {
    expect(parseTimestamp(5)).toBe(5);
    expect(parseTimestamp('5')).toBe(5);
    expect(parseTimestamp('2026-11-24T00:00:00Z')).toBe(Date.UTC(2026, 10, 24));
    expect(parseTimestamp('nope')).toBeUndefined();
    expect(parseTimestamp(null)).toBeUndefined();
  });
});
