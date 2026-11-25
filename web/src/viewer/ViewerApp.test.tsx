import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UnavailableCard } from './components/StateCards';
import { downloadUrl, shareUrl } from './urls';
import { ViewerApp } from './ViewerApp';
import type { FileData } from './types';

const NOW = Date.now();
const secs = (ms: number) => Math.floor(ms / 1000);

const image: FileData = {
  kind: 'image',
  filename: 'cat.png',
  mimetype: 'image/png',
  extension: 'png',
  size: 2048,
  width: 800,
  height: 600,
  cdn_url: 'https://cdn.files.gg/files/abc.png',
  url: 'https://files.gg/abc.png',
  uploaded_at: secs(NOW - 3 * 24 * 3600_000),
  expires_at: secs(NOW + 5 * 3600_000 + 30_000),
};

describe('ViewerApp', () => {
  it('renders the home card', () => {
    render(<ViewerApp state={{ page: 'home' }} />);
    expect(screen.getByAltText('files.gg')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /upload a file/i })).toHaveAttribute('href', '/app/upload');
  });

  it('renders the missing state', () => {
    render(<ViewerApp state={{ page: 'missing' }} />);
    expect(screen.getByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
  });

  it('renders a Retry button when unavailable', () => {
    const onRetry = vi.fn();
    render(<UnavailableCard onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders an image card with footer actions', () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    expect(screen.getByRole('heading', { name: 'cat.png' })).toBeInTheDocument();
    expect(screen.getByText('Uploaded 3 days ago')).toHaveAttribute('title');
    expect(screen.getByText('Expires in 5 hours')).toHaveClass('text-warn');
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${image.cdn_url}?download=true`);
    expect(screen.getByRole('link', { name: 'Raw' })).toHaveAttribute('target', '_blank');
    const img = screen.getByRole('img', { name: 'cat.png' });
    expect(img.style.getPropertyValue('--media-w')).toBe('800');
    expect(img).toHaveClass('viewer-media-sized');
  });

  it('shows "Expired" in red once past the expiry', () => {
    render(<ViewerApp state={{ page: 'file', file: { ...image, expires_at: secs(NOW) - 1 } }} />);
    expect(screen.getByText('Expired')).toHaveClass('text-danger');
  });

  it('opens the lightbox on click and closes it with Escape', () => {
    render(<ViewerApp state={{ page: 'file', file: image }} />);
    fireEvent.click(screen.getByRole('button', { name: /open cat.png full screen/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falls back to the generic card for kinds without a renderer', () => {
    render(
      <ViewerApp
        state={{ page: 'file', file: { ...image, kind: 'file', filename: 'a.zip', mimetype: 'application/zip', extension: 'zip' } }}
      />,
    );
    expect(screen.getByText(/no preview available/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'a.zip' })).not.toBeInTheDocument();
  });
});

describe('urls', () => {
  it('adds ?download=true, keeping existing params', () => {
    expect(downloadUrl('https://cdn.files.gg/files/a.png')).toBe('https://cdn.files.gg/files/a.png?download=true');
    expect(downloadUrl('https://cdn.files.gg/files/a.png?x=1')).toBe('https://cdn.files.gg/files/a.png?x=1&download=true');
  });

  it('leaves a signed URL untouched apart from download=true', () => {
    const signed = 'https://cdn.files.gg/files/abc.png?album=Ab3dE6gH&expires=1795603600&sig=qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68';
    expect(downloadUrl(signed)).toBe(`${signed}&download=true`);
  });

  it('prefers the canonical URL for sharing', () => {
    expect(shareUrl('https://files.gg/a.png')).toBe('https://files.gg/a.png');
    expect(shareUrl(undefined, { origin: 'https://files.gg', pathname: '/abc/xyz.png' })).toBe('https://files.gg/abc/xyz.png');
  });
});
