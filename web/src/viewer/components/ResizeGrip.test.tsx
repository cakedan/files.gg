import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FileData } from '../types';
import { FileCard } from './FileCard';

const image: FileData = {
  kind: 'image',
  filename: 'cat.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 1024,
  vanity: 'abc',
  cdn_url: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  uploaded_at: 0,
  expires_at: null,
  width: 800,
  height: 600,
};

const grip = () => screen.queryByRole('button', { name: /^Resize/ });
const card = () => screen.getByRole('article');

describe('the corner resize grip (as the old viewer had)', () => {
  it.each(['image', 'video', 'audio'] as const)('is on %s cards', (kind) => {
    render(<FileCard file={{ ...image, kind }} />);
    expect(grip()).toBeInTheDocument();
  });

  it('is not on PDFs, text, downloads or document previews', () => {
    const { unmount } = render(<FileCard file={{ ...image, kind: 'pdf', mimetype: 'application/pdf' }} />);
    expect(grip()).not.toBeInTheDocument();
    unmount();
    const second = render(<FileCard file={{ ...image, kind: 'file', mimetype: 'application/zip' }} />);
    expect(grip()).not.toBeInTheDocument();
    second.unmount();
    render(<FileCard file={{ ...image, kind: 'file', assets: { document: { url: 'https://cdn.files.gg/previews/document/abc.pdf?v=1', size: 1, pages: 1 } } } as FileData} />);
    expect(grip()).not.toBeInTheDocument();
  });

  it('resizes with the arrow keys within the window, and Escape or a double click goes back', () => {
    render(<FileCard file={image} />);
    expect(card()).not.toHaveAttribute('data-resized');
    fireEvent.keyDown(grip()!, { key: 'ArrowRight' });
    expect(card()).toHaveAttribute('data-resized');
    // jsdom lays nothing out (width 0), so the first step lands on the minimum width
    expect(card().style.getPropertyValue('--viewer-user-width')).toBe('280px');
    fireEvent.keyDown(grip()!, { key: 'Escape' });
    expect(card()).not.toHaveAttribute('data-resized');
    fireEvent.keyDown(grip()!, { key: 'ArrowUp' });
    fireEvent.doubleClick(grip()!);
    expect(card()).not.toHaveAttribute('data-resized');
  });

  it('follows a drag at twice the pointer movement (the card is centred), capped at 90% of the window', () => {
    render(<FileCard file={image} />);
    const handle = grip()!;
    handle.setPointerCapture = () => {};
    handle.hasPointerCapture = () => false;
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(card().style.getPropertyValue('--viewer-user-width')).toBe('400px');
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(card().style.getPropertyValue('--viewer-user-width')).toBe(`${Math.round(Math.min(window.innerWidth * 0.9, window.innerWidth - 24))}px`);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    expect(card().style.getPropertyValue('--viewer-user-width')).not.toBe('280px');
  });
});
