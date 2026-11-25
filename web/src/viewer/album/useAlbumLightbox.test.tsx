import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useAlbumLightbox } from './useAlbumLightbox';

const url = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

/** Milestone 6 §20.2: the lightbox item is `?item=<n>`; opening adds one history entry, so Back closes it. */
describe('useAlbumLightbox', () => {
  it('starts closed on /a/<vanity>', () => {
    window.history.replaceState(null, '', '/a/v');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    expect(result.current.index).toBeNull();
  });

  it('opens item n from /a/<vanity>?item=<n>, with a #pw= or #t= fragment alongside', () => {
    for (const hash of ['', '#pw=amber-tunnel-oxide-violet', '#t=owner-token']) {
      window.history.replaceState(null, '', `/a/v?item=3${hash}`);
      const { result, unmount } = renderHook(() => useAlbumLightbox('v', 5));
      expect(result.current.index).toBe(2);
      expect(url()).toBe(`/a/v?item=3${hash}`);
      unmount();
    }
  });

  it('drops an out-of-range or unusable item from the URL, keeping the rest', () => {
    for (const item of ['9', '0', 'x']) {
      window.history.replaceState(null, '', `/a/v?fixture=x&item=${item}#pw=p`);
      const { result, unmount } = renderHook(() => useAlbumLightbox('v', 5));
      expect(result.current.index).toBeNull();
      expect(url()).toBe('/a/v?fixture=x#pw=p');
      unmount();
    }
  });

  it('opening adds one history entry, moving adds none, and closing goes back to it', async () => {
    window.history.replaceState(null, '', '/a/v?fixture=album-grid#pw=p');
    const before = window.history.length;
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    act(() => result.current.open(1));
    expect(result.current.index).toBe(1);
    expect(url()).toBe('/a/v?fixture=album-grid&item=2#pw=p');
    expect(window.history.length).toBe(before + 1);
    act(() => result.current.go(3));
    expect(url()).toBe('/a/v?fixture=album-grid&item=4#pw=p');
    act(() => result.current.go(99));
    expect(result.current.index).toBe(3);
    expect(window.history.length).toBe(before + 1);
    // the close button goes back to the entry before the lightbox, like Back would
    act(() => result.current.close());
    await waitFor(() => expect(result.current.index).toBeNull());
    expect(url()).toBe('/a/v?fixture=album-grid#pw=p');
  });

  it("the browser's Back button closes the lightbox", async () => {
    window.history.replaceState(null, '', '/a/v');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    act(() => result.current.open(2));
    expect(url()).toBe('/a/v?item=3');
    act(() => window.history.back());
    await waitFor(() => expect(result.current.index).toBeNull());
    expect(url()).toBe('/a/v');
  });

  it('a page opened at ?item= closes in place, without leaving the page', () => {
    window.history.replaceState(null, '', '/a/v?item=2#t=x');
    const before = window.history.length;
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    expect(result.current.index).toBe(1);
    act(() => result.current.close());
    expect(result.current.index).toBeNull();
    expect(url()).toBe('/a/v#t=x');
    expect(window.history.length).toBe(before);
    // and a reload of an item URL opens the same item
    act(() => result.current.open(4));
    const { result: reloaded } = renderHook(() => useAlbumLightbox('v', 5));
    expect(reloaded.current.index).toBe(4);
  });

  it('follows popstate to another entry of the page', () => {
    window.history.replaceState(null, '', '/a/v?item=2');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    expect(result.current.index).toBe(1);
    act(() => {
      window.history.replaceState(null, '', '/a/v');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.index).toBeNull();
  });

  it('closing a deep-linked item rewrites the URL to the album', () => {
    window.history.replaceState(null, '', '/a/v?item=2');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    act(() => result.current.close());
    expect(result.current.index).toBeNull();
    expect(url()).toBe('/a/v');
  });
});
