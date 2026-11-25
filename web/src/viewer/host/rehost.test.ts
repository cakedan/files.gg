import { describe, expect, it } from 'vitest';

import { rehost, rehostPayload, rehostToHost } from './rehost';

const SOURCES = ['https://cdn.files.gg', 'https://files.gg'];
const HOST = 'i.example.com';

describe('rehost (milestone-6 §16.5 vectors, host i.example.com)', () => {
  it.each([
    ['https://cdn.files.gg/files/abc123.png', 'https://i.example.com/files/abc123.png'],
    [
      'https://cdn.files.gg/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8',
      'https://i.example.com/files/abc123.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8',
    ],
    ['https://cdn.files.gg/previews/thumb/abc123.webp?v=5', 'https://i.example.com/previews/thumb/abc123.webp?v=5'],
    ['https://files.gg/abc123', 'https://i.example.com/abc123'],
    ['https://files.gg/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet', 'https://i.example.com/a/Ab3dE6gH#pw=amber-tunnel-oxide-violet'],
    ['https://cdn.discordapp.com/avatars/1/a.png', 'https://cdn.discordapp.com/avatars/1/a.png'],
    ['https://cdn.files.gg.evil.example/files/x.png', 'https://cdn.files.gg.evil.example/files/x.png'],
    // Rehosted; the custom host then refuses it (staff URLs work only on cdn.files.gg).
    [
      'https://cdn.files.gg/files/abc123.png?staff=555555555555555555&expires=1795603600&sig=xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk',
      'https://i.example.com/files/abc123.png?staff=555555555555555555&expires=1795603600&sig=xiVcxS-CKUyTa08OK9uv9cS5hV8KR-wKF0bHEPvDLJk',
    ],
  ])('%s', (input, output) => {
    expect(rehostToHost(input, HOST, SOURCES)).toBe(output);
  });

  it('keeps everything after the origin byte for byte, so the path-only signature still matches', () => {
    const tails = [
      '/files/a%2Fb%20c.png?expires=1795603600&sig=AbC-_d',
      '/files/%E2%9C%93.png?sig=x&expires=1&v=2',
      '/previews/thumb/abc.webp?v=5&expires=1795603600&sig=s1#frag',
      '/files/UPPER.PNG?x=%2e%2E',
      '?only=query',
      '#only-fragment',
      '',
    ];
    for (const tail of tails) {
      const out = rehostToHost(`https://cdn.files.gg${tail}`, HOST, SOURCES);
      expect(out).toBe(`https://i.example.com${tail}`);
      expect(out.slice('https://i.example.com'.length)).toBe(tail);
    }
  });

  it('compares origins exactly: ports, userinfo, other schemes and look-alikes stay unchanged', () => {
    for (const url of [
      'https://cdn.files.gg:8443/files/x.png',
      'https://cdn.files.gg@evil.example/files/x.png',
      'http://cdn.files.gg/files/x.png',
      'https://files.ggx/abc',
      'https://www.files.gg/abc',
      'https://api.files.gg/access/view/files/abc',
      '/files/x.png',
      'not a url',
    ]) {
      expect(rehostToHost(url, HOST, SOURCES)).toBe(url);
    }
  });

  it('rehosts onto any target origin (the dev server is plain http)', () => {
    expect(rehost('https://cdn.files.gg/files/x.png?sig=1', 'http://localhost:5173', SOURCES)).toBe('http://localhost:5173/files/x.png?sig=1');
  });
});

describe('rehostPayload', () => {
  const SIGNED = 'https://cdn.files.gg/files/abc.png?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';

  it('rehosts url and *_url values at any depth and nothing else', () => {
    const response = {
      token: 'tok',
      expires_at: 1795603600,
      file: {
        filename: 'https://cdn.files.gg/files/not-a-url-field.png',
        url: 'https://files.gg/abc',
        cdn_url: SIGNED,
        hover_url: 'https://cdn.files.gg/previews/hover/abc.webp?v=1&expires=1&sig=h',
        thumbnail: { url: 'https://cdn.files.gg/previews/thumb/abc.webp?v=1&expires=1&sig=t', type: 'thumb' },
        assets: { poster: { url: 'https://cdn.files.gg/previews/poster/abc.webp?v=1&expires=1&sig=p', width: 10 } },
        link_warnings: ['https://files.gg/flagged'],
        caption: 'see https://files.gg/abc',
      },
      album: { items: [{ cdn_url: 'https://cdn.files.gg/files/x.png' }], download_url: 'https://cdn.files.gg/albums/download/Ab3.zip?expires=1&sig=z' },
    };
    const out = rehostPayload(response, 'https://i.example.com', SOURCES);
    expect(out.file.url).toBe('https://i.example.com/abc');
    expect(out.file.cdn_url).toBe(SIGNED.replace('https://cdn.files.gg', 'https://i.example.com'));
    expect(out.file.hover_url).toBe('https://i.example.com/previews/hover/abc.webp?v=1&expires=1&sig=h');
    expect(out.file.thumbnail.url).toBe('https://i.example.com/previews/thumb/abc.webp?v=1&expires=1&sig=t');
    expect(out.file.assets.poster).toEqual({ url: 'https://i.example.com/previews/poster/abc.webp?v=1&expires=1&sig=p', width: 10 });
    expect(out.album.items[0]!.cdn_url).toBe('https://i.example.com/files/x.png');
    expect(out.album.download_url).toBe('https://i.example.com/albums/download/Ab3.zip?expires=1&sig=z');
    // Not URL fields: untouched.
    expect(out.file.filename).toBe('https://cdn.files.gg/files/not-a-url-field.png');
    expect(out.file.link_warnings).toEqual(['https://files.gg/flagged']);
    expect(out.file.caption).toBe('see https://files.gg/abc');
    expect(out.token).toBe('tok');
    expect(out.expires_at).toBe(1795603600);
    // A copy: the response itself is unchanged.
    expect(response.file.cdn_url).toBe(SIGNED);
  });
});
