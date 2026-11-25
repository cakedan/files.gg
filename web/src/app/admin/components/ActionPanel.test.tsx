import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StaffInfo } from '../../../lib/api';
import { createQueryClient } from '../../../lib/queryClient';
import { calls, stubApi, signIn } from '../../../test/apiStub';
import { userActions } from '../permissions';
import { StaffContext } from '../staffContext';
import { ActionPanel } from './ActionPanel';

const DAY = 86400;
const ADMIN: StaffInfo = { role: 'admin', child_safety: false };

function renderPanel() {
  const fetchMock = stubApi({
    'POST /admin/actions': ({ body }) => ({ action: { id: 'a1', action: body.action }, notice_ids: [] }),
  });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <StaffContext.Provider value={ADMIN}>
        <ActionPanel target={{ type: 'user', id: '77' }} options={userActions(ADMIN, { restricted: false, suspended: false, csamSuspension: false })} />
      </StaffContext.Provider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const sentBody = async (fetchMock: ReturnType<typeof stubApi>) => {
  await waitFor(() => expect(calls(fetchMock).some((call) => call.path === '/admin/actions')).toBe(true));
  return calls(fetchMock).find((call) => call.path === '/admin/actions')!.body;
};

beforeEach(() => signIn());
afterEach(() => localStorage.clear());

describe('action panel durations (milestone-4 §9.3)', () => {
  it('sends the duration it shows after switching from “Until lifted” to an upload restriction', async () => {
    const fetchMock = renderPanel();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'suspend_user' } });
    fireEvent.change(screen.getByLabelText('For'), { target: { value: '0' } });
    expect(screen.getByLabelText<HTMLSelectElement>('For').value).toBe('0');

    // Restricting uploads has no “Until lifted”: the panel falls back to 30 days and says so.
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'restrict_uploads' } });
    const shown = screen.getByLabelText<HTMLSelectElement>('For');
    expect(shown.value).toBe(String(30 * DAY));
    expect(shown.selectedOptions[0]!.textContent).toBe('30 days');

    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'spam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Restrict uploads' }));
    expect(await sentBody(fetchMock)).toMatchObject({ action: 'restrict_uploads', duration: 30 * DAY });
  });

  it('keeps a length both actions offer, and sends no duration for a suspension until lifted', async () => {
    const fetchMock = renderPanel();
    fireEvent.change(screen.getByLabelText('For'), { target: { value: String(7 * DAY) } });
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'suspend_user' } });
    expect(screen.getByLabelText<HTMLSelectElement>('For').value).toBe(String(7 * DAY));

    fireEvent.change(screen.getByLabelText('For'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'spam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend the account' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Suspend the account' }));
    const body = await sentBody(fetchMock);
    expect(body).toMatchObject({ action: 'suspend_user' });
    expect(body).not.toHaveProperty('duration');
  });
});
