import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ExternalLinkDialog } from './ExternalLinkDialog';

describe('ExternalLinkDialog', () => {
  it("shows \"You're leaving files.gg\" with the full URL", () => {
    render(<ExternalLinkDialog url="https://example.com/very/long/path?x=1" onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: "You're leaving files.gg" })).toBeInTheDocument();
    expect(screen.getByTestId('external-url')).toHaveTextContent('https://example.com/very/long/path?x=1');
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('Continue opens the link in a new tab without an opener, then closes', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onClose = vi.fn();
    render(<ExternalLinkDialog url="https://example.com/" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
    expect(onClose).toHaveBeenCalled();
  });

  it('Cancel, Escape and the backdrop close without opening', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onClose = vi.fn();
    render(<ExternalLinkDialog url="https://example.com/" onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses to open javascript: links and says why', () => {
    render(<ExternalLinkDialog url="javascript:alert(1)" onClose={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByText(/can't open this kind of link/i)).toBeInTheDocument();
  });

  it('warns when the link was flagged', () => {
    render(<ExternalLinkDialog url="https://example.com/" onClose={() => undefined} flagged />);
    expect(screen.getByText(/flagged as possibly unsafe/i)).toBeInTheDocument();
  });
});
