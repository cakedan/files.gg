import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnerSafety, UploadedFile } from '../../lib/api';
import { createQueryClient } from '../../lib/queryClient';
import { jsonResponse, stubApi } from '../../test/apiStub';
import { ownerFile } from '../../test/ownerFiles';
import { UPLOAD_REJECTED_MESSAGES } from '../safety/labels';
import { UploadRow } from './UploadRow';
import { SCAN_POLL_FAST_FOR_MS, SCAN_POLL_SLOW_MS, scanPollDelay } from './useScanStatus';
import type { QueueItem } from './useUploadQueue';

const safety = (state: OwnerSafety['state'], extra: Partial<OwnerSafety> = {}): OwnerSafety => ({
  state,
  reason: null,
  notice_id: null,
  nsfw_source: null,
  nsfw_locked: false,
  nsfw_review: 'none',
  ...extra,
});

function item(result: UploadedFile): QueueItem {
  const file = new File(['x'], result.filename);
  return { id: 1, file, task: null, snapshot: { phase: 'done', loaded: 1, total: 1, chunked: false, resumed: false, result } };
}

function renderRow(result: UploadedFile) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ul>
          <UploadRow item={item(result)} onRemove={vi.fn()} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const uploaded = (state: OwnerSafety['state']) => ({ ...ownerFile({ id: '500', name: 'upload' }), safety: safety(state) }) as UploadedFile;

beforeEach(() => localStorage.setItem('filesgg.guest', 'fp1'));
afterEach(() => localStorage.clear());

describe('upload rows wait for the scan (milestone-4 §11.2)', () => {
  it('shows Checking… and no link, then the link once the file is ok', async () => {
    let polls = 0;
    stubApi({ 'GET /users/@me/files/:id': () => (++polls < 2 ? uploaded('pending') : uploaded('ok')) });
    renderRow(uploaded('pending'));
    expect(screen.getByText(/Checking…/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /files\.gg/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /files\.gg\/v500\.png/ }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/· Uploaded/)).toBeInTheDocument();
    expect(polls).toBe(2);
  });

  it.each(Object.entries(UPLOAD_REJECTED_MESSAGES))('shows the message for 410 UPLOAD_REJECTED %s', async (reason, message) => {
    stubApi({ 'GET /users/@me/files/:id': () => jsonResponse({ code: 'UPLOAD_REJECTED', message: 'Rejected.', status: 410, reason }, 410) });
    renderRow(uploaded('pending'));
    expect(await screen.findByText(message, {}, { timeout: 3000 })).toHaveAttribute('role', 'alert');
    expect(screen.getByText(/· Rejected/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
  });

  it('a signed-in upload that the scan blocks links to its notice', async () => {
    stubApi({ 'GET /users/@me/files/:id': () => ({ ...uploaded('blocked'), safety: safety('blocked', { reason: 'malware', notice_id: 'n5' }) }) });
    renderRow(uploaded('pending'));
    expect(await screen.findByText(/This file was blocked, so it can’t be shared\./, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the notice' })).toHaveAttribute('href', '/notices/n5');
  });

  it('a payload without safety (older API) shows the link at once', () => {
    stubApi({});
    renderRow(ownerFile({ id: '501', name: 'old' }) as UploadedFile);
    expect(screen.getByRole('link', { name: /files\.gg\/v501\.png/ })).toBeInTheDocument();
  });
});

describe('scan polling backs off and waits for a visible tab', () => {
  it('waits 1 s, 2 s, then 4 s during the first 30 s, then 5 s, with at most ±10% jitter', () => {
    const exact = () => 0.5;
    expect([0, 1, 2, 3, 4].map((attempt) => scanPollDelay(attempt, 0, exact))).toEqual([1000, 2000, 4000, 4000, 4000]);
    expect(scanPollDelay(9, SCAN_POLL_FAST_FOR_MS, exact)).toBe(SCAN_POLL_SLOW_MS);
    expect(scanPollDelay(1, 0, () => 0)).toBe(1800);
    expect(scanPollDelay(1, 0, () => 1)).toBe(2200);
  });

  it('asks nothing while the tab is hidden, and asks at once when it is visible again', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    vi.useFakeTimers();
    try {
      let polls = 0;
      stubApi({ 'GET /users/@me/files/:id': () => (++polls, uploaded('ok')) });
      renderRow(uploaded('pending'));
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(polls).toBe(0);
      visibility = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(polls).toBe(1);
      expect(screen.getByRole('link', { name: /files\.gg\/v500\.png/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      // Back to jsdom's own (Document.prototype) getter.
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});
