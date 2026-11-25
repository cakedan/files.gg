import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ME, NO_BADGES, renderDashboard, stubApi, signIn } from '../../test/apiStub';
import { installTurnstile } from '../../test/turnstile';

const limits = (anonymous: boolean, extra: object = {}) => ({
  storage: { used: 0, limit: anonymous ? null : 1e10 },
  max_file_size_single: 25 * 1024 * 1024,
  max_file_size_chunked: 25 * 1024 * 1024,
  max_expiry: anonymous ? 21 * 86400 : null,
  allow_no_expiry: !anonymous,
  anonymous,
  nsfw_allowed: !anonymous,
  ...extra,
});

afterEach(() => {
  localStorage.clear();
  delete window.turnstile;
});

describe('Upload page safety (milestone-4 §4.3, §11.2)', () => {
  it('signed in: an "Adult content (NSFW)" checkbox', async () => {
    signIn();
    stubApi({ 'GET /users/@me': () => ME, 'GET /users/@me/badges': () => NO_BADGES, 'GET /users/@me/limits': () => limits(false) });
    renderDashboard('/upload');
    const box = await screen.findByRole('checkbox', { name: /Adult content \(NSFW\)/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.queryByText('Sign in to upload sensitive media.')).not.toBeInTheDocument();
  });

  it('signed out: no checkbox, and the hint to sign in', async () => {
    installTurnstile();
    localStorage.setItem('filesgg.fingerprint', 'fp1');
    stubApi({ 'GET /users/@me/limits': () => limits(true) });
    renderDashboard('/upload');
    expect(await screen.findByText('Sign in to upload sensitive media.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Adult content/ })).not.toBeInTheDocument();
  });

  it('restricted: explains until when and disables the dropzone', async () => {
    signIn();
    const until = Math.floor(new Date('2030-01-15T12:00:00Z').getTime() / 1000);
    stubApi({
      'GET /users/@me': () => ME,
      'GET /users/@me/badges': () => ({ ...NO_BADGES, restrictions: [{ kind: 'uploads', until, notice_id: 'n1' }] }),
      'GET /users/@me/limits': () => limits(false, { nsfw_allowed: false }),
    });
    renderDashboard('/upload');
    expect(await screen.findByText(/^Uploads are restricted until January 1[45], 2030$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeDisabled();
    expect(screen.getByLabelText('Choose files to upload')).toBeDisabled();
    expect(screen.getByRole('link', { name: 'See why' })).toHaveAttribute('href', '/notices/n1');
    expect(screen.queryByRole('checkbox', { name: /Adult content/ })).not.toBeInTheDocument();
  });
});
