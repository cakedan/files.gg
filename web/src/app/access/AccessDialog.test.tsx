import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../lib/queryClient';
import { json, ownerFile } from '../../test/ownerFiles';
import { Toaster } from '../components/Toaster';
import { AccessDialog, type AccessDialogTarget } from './AccessDialog';

const writeText = vi.fn(async () => undefined);

function renderDialog(target: AccessDialogTarget, onClose = vi.fn()) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Toaster>
        <AccessDialog target={target} anonymous={false} onClose={onClose} />
      </Toaster>
    </QueryClientProvider>,
  );
  return onClose;
}

const sent = () => {
  const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  return { path: new URL(String(url)).pathname, method: init?.method, body: JSON.parse(String(init?.body)) };
};

beforeEach(() => {
  localStorage.setItem('filesgg.token', 'tok');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
});
afterEach(() => localStorage.clear());

describe('AccessDialog', () => {
  it('moves focus into the dialog and validates the password before saving', async () => {
    const file = ownerFile({ id: '5', name: 'cat' });
    vi.stubGlobal('fetch', vi.fn(async () => json(file)));
    renderDialog({ kind: 'file', file });
    const dialog = screen.getByRole('dialog', { name: 'Change access' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.queryByText(/breaks existing password links/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /password/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a password, or generate one.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Password', { selector: 'input:not([type=radio])' }), { target: { value: 'abc' } });
    expect(screen.getByText('Use at least 6 characters.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Password', { selector: 'input:not([type=radio])' }), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show the name on the lock screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(sent()).toEqual({
      path: '/users/@me/files/5',
      method: 'PATCH',
      body: { visibility: 'password', password: 'correct horse', unlock_ttl: 3600, password_expires_at: null, show_name_when_locked: true },
    });
    expect(await screen.findByText('Access updated for cat.png.')).toBeInTheDocument();
  });

  it('shows a generated password once, with Copy and Copy link with password', async () => {
    const file = ownerFile({ id: '5', name: 'cat', visibility: 'password' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...file, password: 'amber-tunnel-oxide-violet', url_with_password: 'x' })));
    renderDialog({ kind: 'file', file });
    expect(screen.getByLabelText('Password', { selector: 'input:not([type=radio])' })).toHaveAttribute('placeholder', 'Keep the current password');
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByText(/breaks existing password links/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('dialog', { name: 'Password set' })).toBeInTheDocument();
    expect(sent().body).toEqual({ visibility: 'password', generate_password: true, show_name_when_locked: false });
    expect(screen.getByText('amber-tunnel-oxide-violet')).toBeInTheDocument();
    expect(screen.getByText(/Shown once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link with password' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${file.url}#pw=amber-tunnel-oxide-violet`));
    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('amber-tunnel-oxide-violet'));
  });

  it('bulk: one call for the selection, and one password for all of them', async () => {
    const files = [ownerFile({ id: '1' }), ownerFile({ id: '2' })];
    vi.stubGlobal('fetch', vi.fn(async () => json({ items: files.map((f) => ({ ...f, visibility: 'password' })), password: 'one-for-all' })));
    renderDialog({ kind: 'files', files });
    expect(screen.getByText('2 files')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /password/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(screen.getByText('One passphrase for all 2 files, shown once after saving.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('one-for-all');
    expect(sent()).toMatchObject({ path: '/users/@me/files/access', method: 'POST', body: { file_ids: ['1', '2'], visibility: 'password', generate_password: true } });
    expect(sent().body).not.toHaveProperty('password_expires_at');
    fireEvent.click(screen.getByRole('button', { name: 'Copy links with password' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(files.map((f) => `${f.url}#pw=one-for-all`).join('\n')));
  });

  it('shows the server error and stays open', async () => {
    const file = ownerFile({ id: '5' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'PRIVATE_REQUIRES_ACCOUNT', message: 'x' }, 400)));
    const onClose = renderDialog({ kind: 'file', file });
    fireEvent.click(screen.getByRole('radio', { name: /only me/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Sign in to keep files private.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
