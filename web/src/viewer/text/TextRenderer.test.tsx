import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileData } from '../types';
import TextRenderer from './TextRenderer';

const CDN = 'https://cdn.files.gg/files/notes.txt?expires=1795603600&sig=2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8';

const textFile = (extra: Partial<FileData> = {}): FileData => ({
  kind: 'text',
  filename: 'notes.txt',
  mimetype: 'text/plain',
  extension: 'txt',
  size: 100,
  cdn_url: CDN,
  uploaded_at: 0,
  expires_at: null,
  ...extra,
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
let fetchMock: ReturnType<typeof vi.fn>;
const scrolled: Element[] = [];

beforeEach(() => {
  window.history.replaceState(null, '', '/notes.txt');
  fetchMock = vi.fn(async () => new Response(lines(30)));
  vi.stubGlobal('fetch', fetchMock);
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const row = (n: number) => document.querySelector(`[data-line-row="${n}"]`)!;
const selectedRows = () => [...document.querySelectorAll('[data-selected]')].map((el) => Number(el.getAttribute('data-line-row')));

describe('TextRenderer', () => {
  it('fetches the text from cdn_url (signed, untouched) and shows numbered lines', async () => {
    render(<TextRenderer file={textFile()} />);
    expect(await screen.findByText('line 30')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(CDN, expect.anything());
    expect(screen.getByRole('link', { name: 'Line 1' })).toHaveAttribute('href', '#L1');
    expect(screen.getByText('Plain text')).toBeInTheDocument();
    expect(screen.getByText('30 lines')).toBeInTheDocument();
  });

  it('highlights #L5 and #L5-L9 on load and scrolls to them', async () => {
    window.history.replaceState(null, '', '/notes.txt#L5-L9');
    render(<TextRenderer file={textFile()} />);
    await screen.findByText('line 30');
    expect(selectedRows()).toEqual([5, 6, 7, 8, 9]);
    expect(scrolled).toContain(row(5));
    expect(row(5)).toHaveAttribute('id', 'L5');
  });

  it('leaves an old ?line=N alone (no redirect)', async () => {
    window.history.replaceState(null, '', '/notes.txt?line=12');
    render(<TextRenderer file={textFile()} />);
    await screen.findByText('line 30');
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/notes.txt?line=12');
    expect(selectedRows()).toEqual([]);
  });

  it('sets #L on click and #L…-L… on shift-click with replaceState, without scrolling', async () => {
    render(<TextRenderer file={textFile()} />);
    await screen.findByText('line 30');
    const push = vi.spyOn(window.history, 'pushState');
    scrolled.length = 0;
    fireEvent.click(screen.getByRole('link', { name: 'Line 3' }));
    expect(window.location.hash).toBe('#L3');
    expect(selectedRows()).toEqual([3]);
    fireEvent.click(screen.getByRole('link', { name: 'Line 6' }), { shiftKey: true });
    expect(window.location.hash).toBe('#L3-L6');
    expect(selectedRows()).toEqual([3, 4, 5, 6]);
    fireEvent.click(screen.getByRole('link', { name: 'Line 1' }), { shiftKey: true });
    expect(window.location.hash).toBe('#L1-L3');
    expect(push).not.toHaveBeenCalled();
    expect(scrolled).toEqual([]);
  });

  it('follows hash changes', async () => {
    render(<TextRenderer file={textFile()} />);
    await screen.findByText('line 30');
    act(() => {
      window.history.replaceState(null, '', '/notes.txt#L20');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(selectedRows()).toEqual([20]);
    expect(scrolled).toContain(row(20));
  });

  it('keeps line clicks local in an album (no URL changes)', async () => {
    render(<TextRenderer file={textFile()} context="lightbox" />);
    await screen.findByText('line 30');
    fireEvent.click(screen.getByRole('link', { name: 'Line 4' }));
    expect(window.location.hash).toBe('');
    expect(selectedRows()).toEqual([4]);
    expect(row(4)).not.toHaveAttribute('id');
  });

  it('shows "Too large to preview" from the payload without fetching', () => {
    render(<TextRenderer file={textFile({ size: 2 * 1024 * 1024 })} />);
    expect(screen.getByText('Too large to preview')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', `${CDN}&download=true`);
    expect(screen.getByRole('link', { name: /raw/i })).toHaveAttribute('href', CDN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows "Too large to preview" when the fetched text has over 20,000 lines', async () => {
    fetchMock.mockResolvedValueOnce(new Response(lines(20_001)));
    render(<TextRenderer file={textFile()} />);
    expect(await screen.findByText('Too large to preview')).toBeInTheDocument();
    expect(screen.getByText(/with 20,001 lines\./)).toBeInTheDocument();
  });

  it('offers Retry, Download and Raw when the fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    render(<TextRenderer file={textFile()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('line 30')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('toggles wrapping and copies the text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<TextRenderer file={textFile()} />);
    await screen.findByText('line 30');
    const wrap = screen.getByRole('button', { name: 'Wrap' });
    expect(wrap).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(wrap);
    expect(wrap).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'notes.txt' })).toHaveClass('text-wrap-on');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(lines(30)));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('highlights with Shiki for a known language (media.language, then the extension)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('def greet(name):\n    return f"hi {name}"  # comment\n'));
    render(<TextRenderer file={textFile({ filename: 'greet.txt', media: { language: 'python' } })} />);
    expect(screen.getByText('Python')).toBeInTheDocument();
    await waitFor(() => expect(row(1).querySelectorAll('.text-code span[style]').length).toBeGreaterThan(1), { timeout: 5000 });
    const colours = new Set([...document.querySelectorAll<HTMLElement>('.text-code span[style]')].map((s) => s.style.color));
    expect(colours.size).toBeGreaterThan(2);
    expect(row(2).textContent).toContain('return f"hi {name}"  # comment');
  });
});
