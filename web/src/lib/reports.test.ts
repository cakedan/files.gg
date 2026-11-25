import { afterEach, describe, expect, it } from 'vitest';

import { clearAccess, saveAccess } from './access';
import { albumItemAccessHeaders } from './reports';

const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('albumItemAccessHeaders', () => {
  afterEach(() => {
    clearAccess('album', 'Ab3dE6gH');
  });

  it('sends the stored album token for an item URL of an unlocked album', () => {
    saveAccess('album', 'Ab3dE6gH', { token: 'album-token', expires_at: future() });
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Ab3dE6gH?item=3' })).toEqual({ 'X-Filesgg-Access': 'album-token' });
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Ab3dE6gH/?item=3#pw=x' })).toEqual({ 'X-Filesgg-Access': 'album-token' });
  });

  it('sends nothing without a stored token, for the album itself, or for other targets', () => {
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Ab3dE6gH?item=3' })).toBeUndefined();
    saveAccess('album', 'Ab3dE6gH', { token: 'album-token', expires_at: future() });
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Ab3dE6gH' })).toBeUndefined();
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Ab3dE6gH?item=0' })).toBeUndefined();
    // milestone-6 §20.2: the old item path is no item
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Ab3dE6gH/3' })).toBeUndefined();
    expect(albumItemAccessHeaders({ type: 'url', url: 'https://files.gg/a/Other123?item=3' })).toBeUndefined();
    expect(albumItemAccessHeaders({ type: 'album', vanity: 'Ab3dE6gH', part: 'album' as never })).toBeUndefined();
    expect(albumItemAccessHeaders({ type: 'url', url: 'not a url %%' })).toBeUndefined();
  });
});
