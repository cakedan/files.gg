import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../lib/queryClient';
import { ME, NO_BADGES, renderDashboard, signIn, stubApi } from '../../test/apiStub';
import { installTurnstile } from '../../test/turnstile';
import UploadPage from '../pages/UploadPage';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const anonymousLimits = {
  storage: { used: 0, limit: null },
  max_file_size_single: 25_000_000,
  max_file_size_chunked: 25_000_000,
  max_expiry: 21 * 86400,
  allow_no_expiry: false,
  anonymous: true,
};

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <UploadPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installTurnstile();
  localStorage.setItem('filesgg.guest', 'fp1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (String(url).endsWith('/users/@me/limits') ? json(anonymousLimits) : json({}, 404))),
  );
});
afterEach(() => {
  localStorage.clear();
  delete window.turnstile;
});

describe('UploadPage (anonymous)', () => {
  it('shows the anonymous expiry choices with the note, and disables "Only me"', async () => {
    renderPage();
    const expiry = await screen.findByLabelText('Expires');
    await waitFor(() => expect(expiry).toHaveValue(String(21 * 86400)));
    expect(within(expiry).queryByRole('option', { name: 'Never' })).not.toBeInTheDocument();
    expect(screen.getByText(/Anonymous uploads are deleted after at most 21 days/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /only me/i })).toBeDisabled();
  });

  it('rejects a too-large file before uploading, with the typed message', async () => {
    renderPage();
    await screen.findByText(/Up to 25 MB per file/);
    const big = new File(['x'], 'huge.bin');
    Object.defineProperty(big, 'size', { value: 30_000_000 });
    fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files: [big] } });
    expect(await screen.findByText('This file is too large. The limit is 25 MB.')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => /\/files$|\/uploads$/.test(String(url)))).toBe(false);
  });

  it('password access shows the password fields and Generate', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: /password/i }));
    expect(screen.getByLabelText('Stay unlocked for')).toHaveValue('3600');
    expect(screen.getByLabelText('Password works until')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByText('Each file gets its own generated password, shown once.')).toBeInTheDocument();
  });
});

describe('UploadPage (signed in, milestone-5 §21)', () => {
  it('starts from the account’s upload defaults', async () => {
    signIn({ ...ME, settings: { ...ME.settings, upload_defaults: { expires_in: 7 * 86400, visibility: 'password', nsfw: true } } });
    stubApi({
      'GET /users/@me/limits': () => ({ ...anonymousLimits, anonymous: false, max_expiry: null, allow_no_expiry: true, nsfw_allowed: true }),
      'GET /users/@me/badges': () => NO_BADGES,
    });
    renderDashboard('/upload');
    const options = await screen.findByRole('region', { name: 'Upload options' });
    await waitFor(() => expect(within(options).getByLabelText('Adult content (NSFW)', { exact: false })).toBeChecked());
    expect(within(options).getByLabelText('Expires')).toHaveValue(String(7 * 86400));
    expect(within(options).getByRole('radio', { name: /password/i })).toBeChecked();
    expect(within(options).getByRole('button', { name: 'Type my own instead' })).toHaveAttribute('aria-pressed', 'true');
  });
});
