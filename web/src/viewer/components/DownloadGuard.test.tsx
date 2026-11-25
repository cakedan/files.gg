import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DownloadGuard, DownloadLinksGuard } from './DownloadGuard';

const warned = { warnings: ['encrypted_archive' as const], cdn_url: 'https://cdn.files.gg/files/a.zip' };
const plain = { warnings: [], cdn_url: 'https://cdn.files.gg/files/b.zip' };

describe('DownloadGuard (security review W2)', () => {
  it('asks on a middle click as well as a click', () => {
    render(
      <DownloadGuard file={warned}>
        <a href="https://cdn.files.gg/files/a.zip?download=true">Download</a>
      </DownloadGuard>,
    );
    const link = screen.getByRole('link', { name: 'Download' });
    // fireEvent returns false when the default action was prevented
    expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false);
    expect(screen.getByRole('alertdialog', { name: 'Download this file?' })).toBeInTheDocument();
  });

  it('ignores other mouse buttons and links to other files', () => {
    render(
      <DownloadLinksGuard files={[warned, plain]}>
        <a href="https://cdn.files.gg/files/a.zip">Warned</a>
        <a href="https://cdn.files.gg/files/b.zip?download=true">Plain</a>
      </DownloadLinksGuard>,
    );
    const right = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 });
    screen.getByRole('link', { name: 'Warned' }).dispatchEvent(right);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByRole('link', { name: 'Plain' }).dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Warned' }));
    expect(screen.getByRole('alertdialog', { name: 'Download this file?' })).toBeInTheDocument();
  });

  it('renders its children untouched when nothing is warned', () => {
    const { container } = render(
      <DownloadLinksGuard files={[plain]}>
        <a href="https://cdn.files.gg/files/b.zip">Plain</a>
      </DownloadLinksGuard>,
    );
    expect(container.firstElementChild?.tagName).toBe('A');
  });
});
