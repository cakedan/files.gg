import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useAlbumLightbox } from './useAlbumLightbox';

const path = () => `${window.location.pathname}${window.location.search}`;

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('useAlbumLightbox', () => {
  it('starts closed on /a/<vanity>', () => {
    window.history.replaceState(null, '', '/a/v');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    expect(result.current.index).toBeNull();
  });

  it('opens item n from /a/<vanity>/<n>', () => {
    window.history.replaceState(null, '', '/a/v/3');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    expect(result.current.index).toBe(2);
  });

  it('drops an out-of-range n from the URL', () => {
    window.history.replaceState(null, '', '/a/v/9?fixture=x');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    expect(result.current.index).toBeNull();
    expect(path()).toBe('/a/v?fixture=x');
  });

  it('pushes on open, replaces while moving, and keeps the query string', () => {
    window.history.replaceState(null, '', '/a/v?fixture=album-grid');
    const before = window.history.length;
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    act(() => result.current.open(1));
    expect(result.current.index).toBe(1);
    expect(path()).toBe('/a/v/2?fixture=album-grid');
    expect(window.history.length).toBe(before + 1);
    act(() => result.current.go(3));
    expect(path()).toBe('/a/v/4?fixture=album-grid');
    expect(window.history.length).toBe(before + 1);
    act(() => result.current.go(99));
    expect(result.current.index).toBe(3);
  });

  it('follows Back (popstate) to close', () => {
    window.history.replaceState(null, '', '/a/v/2');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    act(() => {
      window.history.replaceState(null, '', '/a/v');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.index).toBeNull();
  });

  it('closing a deep-linked item rewrites the URL instead of going back', () => {
    window.history.replaceState(null, '', '/a/v/2');
    const { result } = renderHook(() => useAlbumLightbox('v', 5));
    act(() => result.current.close());
    expect(result.current.index).toBeNull();
    expect(path()).toBe('/a/v');
  });
});
