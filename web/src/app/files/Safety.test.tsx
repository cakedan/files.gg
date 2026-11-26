import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnerFile, OwnerSafety } from '../../lib/api';
import { createQueryClient } from '../../lib/queryClient';
import { stubApi } from '../../test/apiStub';
import { ownerFile } from '../../test/ownerFiles';
import { hiddenNote } from '../albums/hiddenNote';
import { SHOW_SENSITIVE_KEY } from '../safety/sensitive';
import FileDrawer from './FileDrawer';
import { fileMenuItems, NSFW_LOCKED_HINT, type FileHandlers } from './fileMenu';
import { FileThumb } from './FileThumb';
import { FilesGrid } from './FilesViews';

const safety = (overrides: Partial<OwnerSafety> = {}): OwnerSafety => ({
  state: 'ok',
  reason: null,
  notice_id: null,
  nsfw_source: null,
  nsfw_locked: false,
  nsfw_review: 'none',
  ...overrides,
});

const withThumb = (overrides: Partial<OwnerFile> = {}) =>
  ownerFile({ assets: { thumb: { url: 'https://cdn.files.gg/previews/thumb/a.webp', width: 320, height: 240 } }, ...overrides });

function wrap(children: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const handlers = (extra: Partial<FileHandlers> = {}): FileHandlers => ({
  copyLink: vi.fn(),
  open: vi.fn(),
  openAsOwner: vi.fn(),
  setExpiry: vi.fn(),
  changeAccess: vi.fn(),
  addToAlbum: vi.fn(),
  remove: vi.fn(),
  setSensitive: vi.fn(),
  askReview: vi.fn(),
  ...extra,
});

afterEach(() => localStorage.clear());

describe('NSFW tiles (milestone-4 §4.6)', () => {
  it('blurs an NSFW thumbnail with an eye-off mark, and plays no hover clip', () => {
    wrap(<FileThumb file={withThumb({ nsfw: true, kind: 'video', hover_url: 'https://cdn.files.gg/previews/hover/a.mp4', assets: { poster: { url: 'https://cdn.files.gg/p.webp' } } })} active size="lg" />);
    const image = document.querySelector('img')!;
    expect(image).toHaveAttribute('data-sensitive', 'blurred');
    expect(image).toHaveStyle({ filter: 'blur(16px)' });
    expect(screen.getByTestId('sensitive-overlay')).toHaveTextContent('Sensitive content');
    expect(screen.queryByTestId('hover-clip')).not.toBeInTheDocument();
  });

  it('shows it plainly with "Always show sensitive media", and never blurs safe files', () => {
    localStorage.setItem(SHOW_SENSITIVE_KEY, '1');
    const { unmount } = wrap(<FileThumb file={withThumb({ nsfw: true })} />);
    expect(document.querySelector('img')).not.toHaveAttribute('data-sensitive');
    unmount();
    localStorage.clear();
    wrap(<FileThumb file={withThumb({ nsfw: false })} />);
    expect(document.querySelector('img')).not.toHaveAttribute('data-sensitive');
    expect(screen.queryByTestId('sensitive-overlay')).not.toBeInTheDocument();
  });

  it('shows the state instead of media for pending, hidden, removed and blocked files', () => {
    for (const state of ['pending', 'hidden', 'removed', 'blocked'] as const) {
      const { unmount } = wrap(<FileThumb file={withThumb({ safety: safety({ state }) })} />);
      expect(document.querySelector('img')).toBeNull();
      expect(screen.getByText({ pending: 'Checking…', hidden: 'Hidden', removed: 'Removed', blocked: 'Blocked' }[state])).toBeInTheDocument();
      unmount();
    }
  });

  it('badges tiles and links the badge to the notice; flagged files get no badge', () => {
    const files = [
      withThumb({ id: '1', name: 'one', safety: safety({ state: 'removed', reason: 'copyright', notice_id: 'n9' }) }),
      withThumb({ id: '2', name: 'two', safety: safety({ state: 'flagged', reason: 'unwanted_software' }) }),
    ];
    wrap(
      <FilesGrid
        files={files}
        selection={{ ids: new Set(), anchor: null }}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
        onOpen={vi.fn()}
        renamingId={null}
        onRename={vi.fn()}
        onRenameCancel={vi.fn()}
        handlers={handlers()}
        now={Date.now()}
      />,
    );
    expect(screen.getByRole('link', { name: 'Removed' })).toHaveAttribute('href', '/notices/n9');
    const second = screen.getByRole('button', { name: 'Open two.png' }).closest('li')!;
    expect(within(second).queryByText('Hidden')).not.toBeInTheDocument();
    expect(within(second).queryByTestId('safety-badge')).not.toBeInTheDocument();
  });
});

describe('owner NSFW actions (milestone-4 §4.5, §11.2)', () => {
  const labels = (file: OwnerFile, extra?: Partial<FileHandlers>) =>
    fileMenuItems(file, handlers(extra))
      .filter((item) => !item.hidden)
      .map((item) => [item.label, Boolean(item.disabled), item.hint ?? null]);

  it('offers Mark, Unmark (locked when files.gg marked it) and Ask for review', () => {
    expect(labels(ownerFile({ nsfw: false, safety: safety() }))).toContainEqual(['Mark as sensitive', false, null]);
    expect(labels(ownerFile({ nsfw: true, safety: safety({ nsfw_source: 'uploader' }) }))).toContainEqual(['Unmark as sensitive', false, null]);
    const auto = labels(ownerFile({ nsfw: true, safety: safety({ nsfw_source: 'auto', nsfw_locked: true }) }));
    expect(auto).toContainEqual(['Unmark as sensitive', true, NSFW_LOCKED_HINT]);
    expect(auto).toContainEqual(['Ask for review…', false, null]);
    expect(labels(ownerFile({ nsfw: true, safety: safety({ nsfw_source: 'auto', nsfw_locked: true, nsfw_review: 'open' }) })).map(([label]) => label)).not.toContain('Ask for review…');
    // Anonymous owners can't mark at all.
    expect(labels(ownerFile({ nsfw: false }), { setSensitive: undefined, askReview: undefined }).map(([label]) => label)).not.toContain('Mark as sensitive');
  });

  it('the drawer opens an NSFW file behind an interstitial, and mounts nothing before Show', async () => {
    stubApi({});
    const file = withThumb({ nsfw: true, kind: 'image', safety: safety({ nsfw_source: 'auto', nsfw_locked: true }) });
    wrap(<FileDrawer file={file} handlers={handlers()} onClose={vi.fn()} />);
    expect(screen.getByText('This file may contain sensitive content')).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
    expect(screen.getByText('files.gg’s classifier marked this file as sensitive.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unmark as sensitive' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Always show sensitive media'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show' })));
    expect(localStorage.getItem(SHOW_SENSITIVE_KEY)).toBe('1');
    expect(screen.queryByText('This file may contain sensitive content')).not.toBeInTheDocument();
  });

  it('from a blocked region (milestone-7 §11.4), Mark is disabled with the reason; Unmark still works', () => {
    const blocked = { adultRegionBlocked: true };
    expect(labels(ownerFile({ nsfw: false, safety: safety() }), blocked)).toContainEqual(['Mark as sensitive', true, "Adult content isn't available in your region."]);
    expect(labels(ownerFile({ nsfw: true, safety: safety({ nsfw_source: 'uploader' }) }), blocked)).toContainEqual(['Unmark as sensitive', false, null]);
  });

  it('the drawer from a blocked region: one line instead of Mark as sensitive; a marked file can still be unmarked', () => {
    const setSensitive = vi.fn();
    const view = wrap(<FileDrawer file={withThumb({ nsfw: false, safety: safety() })} handlers={handlers({ adultRegionBlocked: true, setSensitive })} onClose={vi.fn()} />);
    const section = screen.getByRole('region', { name: 'Sensitive content' });
    expect(within(section).getByText("Adult content isn't available in your region.")).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Mark as sensitive' })).toBeNull();
    view.unmount();

    wrap(<FileDrawer file={withThumb({ nsfw: true, safety: safety({ nsfw_source: 'uploader' }) })} handlers={handlers({ adultRegionBlocked: true, setSensitive })} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unmark as sensitive' }));
    expect(setSensitive).toHaveBeenCalledWith([expect.objectContaining({ nsfw: true })], false);
    expect(screen.queryByText("Adult content isn't available in your region.")).toBeNull();
  });

  it('the drawer explains a removed file and links its notice instead of showing it', () => {
    const file = withThumb({ safety: safety({ state: 'removed', reason: 'copyright', notice_id: 'n1' }) });
    wrap(<FileDrawer file={file} handlers={handlers()} onClose={vi.fn()} />);
    expect(screen.getByText('This file can’t be viewed.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the notice' })).toHaveAttribute('href', '/notices/n1');
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });
});

describe('album item notes (milestone-4 §6.2, §11.2)', () => {
  it('explains items that are checked, hidden, removed or blocked', () => {
    const album = { visibility: 'link' as const };
    const item = (state: OwnerSafety['state'], reason: string | null = null) => ({ shown: false, visibility: 'link' as const, safety: safety({ state, reason }) });
    expect(hiddenNote(item('pending'), album)).toBe('Not shown yet: this file is still being checked.');
    expect(hiddenNote(item('hidden', 'review'), album)).toBe('Hidden here: this file is hidden while it’s reviewed.');
    expect(hiddenNote(item('hidden', 'spam'), album)).toBe('Hidden here: the files.gg team hid this file.');
    expect(hiddenNote(item('removed'), album)).toBe('Hidden here: the files.gg team removed this file.');
    expect(hiddenNote(item('blocked'), album)).toBe('Hidden here: this file was blocked.');
    expect(hiddenNote({ ...item('ok'), shown: true }, album)).toBeNull();
  });
});
