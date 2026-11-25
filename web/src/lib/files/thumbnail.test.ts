import { describe, expect, it } from 'vitest';

import { ownerFile } from '../../test/ownerFiles';
import { thumbnailView } from './thumbnail';

const asset = (kind: string, ext = 'webp') => ({ url: `https://cdn.files.gg/previews/${kind}/abc.${ext}?v=1` });
const signed = (kind: string) => ({ url: `https://cdn.files.gg/previews/${kind}/abc.webp?v=1&expires=1795603600&sig=s1g-${kind}` });

describe('thumbnailView', () => {
  it('images use thumb with thumb-2x in srcset', () => {
    const file = ownerFile({ assets: { thumb: asset('thumb'), 'thumb-2x': asset('thumb-2x') } });
    expect(thumbnailView(file)).toEqual({
      type: 'image',
      src: 'https://cdn.files.gg/previews/thumb/abc.webp?v=1',
      srcSet: 'https://cdn.files.gg/previews/thumb/abc.webp?v=1 1x, https://cdn.files.gg/previews/thumb-2x/abc.webp?v=1 2x',
      hover: undefined,
    });
  });

  it('small images without a thumb show the original', () => {
    expect(thumbnailView(ownerFile({ size: 9000 }))).toMatchObject({ type: 'image', src: expect.stringContaining('cdn.files.gg/files/') });
  });

  it('videos show the poster, a play badge and the hover clip', () => {
    const file = ownerFile({ kind: 'video', assets: { poster: asset('poster') }, hover_url: 'https://cdn.files.gg/previews/hover/abc.mp4?v=1' });
    expect(thumbnailView(file)).toMatchObject({ type: 'image', src: expect.stringContaining('/previews/poster/'), badge: 'play', hover: expect.stringContaining('/previews/hover/') });
  });

  it('audio shows the cover, else a music icon', () => {
    expect(thumbnailView(ownerFile({ kind: 'audio', assets: { cover: asset('cover') } }))).toMatchObject({ type: 'image' });
    expect(thumbnailView(ownerFile({ kind: 'audio', assets: { waveform: asset('waveform') } }))).toEqual({ type: 'icon', music: true });
  });

  it('PDFs show page 1, text its snippet, other files a type icon', () => {
    expect(thumbnailView(ownerFile({ kind: 'pdf', assets: { thumb: asset('thumb') } }))).toMatchObject({ type: 'image' });
    expect(thumbnailView(ownerFile({ kind: 'text', media: { snippet: 'print(1)' } }))).toEqual({ type: 'snippet', text: 'print(1)' });
    expect(thumbnailView(ownerFile({ kind: 'file', size: 10 ** 9 }))).toEqual({ type: 'icon' });
  });

  it('processing files show the placeholder', () => {
    expect(thumbnailView(ownerFile({ processing: true, size: 10 ** 9 }))).toEqual({ type: 'processing' });
  });

  it('protected files use the owner payload\'s signed URLs exactly as they are', () => {
    const hover = 'https://cdn.files.gg/previews/hover/abc.mp4?v=1&expires=1795603600&sig=h0v';
    const file = ownerFile({ visibility: 'password', assets: { thumb: signed('thumb'), 'thumb-2x': signed('thumb-2x') }, hover_url: hover });
    expect(thumbnailView(file)).toEqual({
      type: 'image',
      src: signed('thumb').url,
      srcSet: `${signed('thumb').url} 1x, ${signed('thumb-2x').url} 2x`,
      hover,
    });
    const original = 'https://cdn.files.gg/files/abc.png?expires=1795603600&sig=or1g';
    expect(thumbnailView(ownerFile({ visibility: 'private', size: 9000, cdn_url: original }))).toEqual({ type: 'image', src: original });
  });
});
