import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type UploadedFile } from '../../lib/api';
import { createQueryClient } from '../../lib/queryClient';
import { UploadTask } from '../../lib/upload/uploadTask';
import { defaultPickerState, parseViewLimit, resolvePickers, viewLimitActionChoices, type PickerContext, type PickerState } from '../../lib/upload/options';
import { errorMessage } from '../../lib/errors';
import { UploadOptions } from './UploadOptions';

/** Milestone 6 §19.3, §19.7: the upload page's view limit. */

const DAY = 86400;
const anon: PickerContext = { anonymous: true, limits: { max_expiry: 21 * DAY, allow_no_expiry: false } };
const user: PickerContext = { anonymous: false, limits: { max_expiry: null, allow_no_expiry: true } };

function Harness({ context, onState }: { context: PickerContext; onState?: (state: PickerState) => void }) {
  const [state, setState] = useState(() => defaultPickerState(context));
  const { errors } = resolvePickers(state, context);
  onState?.(state);
  return (
    <QueryClientProvider client={createQueryClient()}>
      <UploadOptions state={state} context={context} errors={errors} onChange={(patch) => setState((current) => ({ ...current, ...patch }))} />
    </QueryClientProvider>
  );
}

afterEach(() => localStorage.clear());

describe('view limit pickers', () => {
  it('parses off, 1–1000, and refuses anything else', () => {
    expect(parseViewLimit('')).toEqual({ value: null });
    expect(parseViewLimit('  ')).toEqual({ value: null });
    expect(parseViewLimit('1')).toEqual({ value: 1 });
    expect(parseViewLimit('1000')).toEqual({ value: 1000 });
    for (const bad of ['0', '1001', '2.5', '-3', 'ten']) expect(parseViewLimit(bad)).toEqual({ error: 'Use a whole number from 1 to 1,000.' });
  });

  it('is off by default and sends nothing', () => {
    expect(resolvePickers(defaultPickerState(user), user).params).not.toHaveProperty('view_limit');
  });

  it('sends view_limit and view_limit_action (expire by default)', () => {
    const state = { ...defaultPickerState(user), viewLimit: '5' };
    expect(resolvePickers(state, user).params).toMatchObject({ view_limit: 5, view_limit_action: 'expire' });
    expect(resolvePickers({ ...state, viewLimitAction: 'private' }, user).params).toMatchObject({ view_limit: 5, view_limit_action: 'private' });
    expect(resolvePickers({ ...state, viewLimit: '0' }, user).errors.viewLimit).toBe('Use a whole number from 1 to 1,000.');
  });

  it('anonymous uploads can set a limit, but never "Make it private"', () => {
    const state = { ...defaultPickerState(anon), viewLimit: '3' };
    expect(resolvePickers(state, anon).params).toMatchObject({ view_limit: 3, view_limit_action: 'expire' });
    const privateState = resolvePickers({ ...state, viewLimitAction: 'private' }, anon);
    expect(privateState.errors.viewLimitAction).toBe('Sign in to make files private.');
    expect(privateState.params).not.toHaveProperty('view_limit');
    expect(viewLimitActionChoices(anon).find((choice) => choice.value === 'private')?.disabled).toBe(true);
  });
});

describe('UploadOptions: View limit', () => {
  it('signed in: an off-by-default control next to expiry, then "When the limit is reached"', () => {
    render(<Harness context={user} />);
    const limit = screen.getByLabelText('View limit');
    expect(limit).toHaveValue(null);
    expect(limit).toHaveAttribute('placeholder', 'Off');
    expect(screen.queryByLabelText('When the limit is reached')).toBeNull();

    fireEvent.change(limit, { target: { value: '10' } });
    const action = screen.getByLabelText('When the limit is reached');
    expect(action).toHaveValue('expire');
    expect(within(action).getByRole('option', { name: 'Expire the file' })).toBeEnabled();
    expect(within(action).getByRole('option', { name: 'Make it private' })).toBeEnabled();
    expect(screen.getByText('Counts unique viewers. You never use up a view yourself.')).toBeInTheDocument();
  });

  it('anonymous: "Make it private" is disabled, with the reason', () => {
    render(<Harness context={anon} />);
    fireEvent.change(screen.getByLabelText('View limit'), { target: { value: '2' } });
    const action = screen.getByLabelText('When the limit is reached');
    expect(within(action).getByRole('option', { name: 'Make it private' })).toBeDisabled();
    expect(screen.getByText('Sign in to make files private instead.')).toBeInTheDocument();
  });

  it('shows the range error', () => {
    render(<Harness context={user} />);
    fireEvent.change(screen.getByLabelText('View limit'), { target: { value: '5000' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Use a whole number from 1 to 1,000.');
  });

  it('PRIVATE_REQUIRES_ACCOUNT from the API reads as a sign-in hint', () => {
    expect(errorMessage(new ApiError(400, 'PRIVATE_REQUIRES_ACCOUNT', 'x'))).toBe('Sign in to keep files private.');
  });
});

describe('UploadTask sends the view limit', () => {
  const result = { id: '1', url: 'https://files.gg/x.bin', cdn_url: 'https://cdn.files.gg/files/x.bin' } as UploadedFile;

  it('on a single POST /files', async () => {
    const send = vi.fn(async () => result);
    const task = new UploadTask(new File(['hi'], 'a.txt'), { view_limit: 3, view_limit_action: 'expire' }, { send: send as never, getTurnstileToken: async () => 't' }, () => undefined);
    await task.start();
    const body = (send.mock.calls[0] as unknown as [{ body: FormData }])[0].body;
    expect(body.get('view_limit')).toBe('3');
    expect(body.get('view_limit_action')).toBe('expire');
  });

  it('on a chunked POST /uploads', async () => {
    const MB = 1024 * 1024;
    const file = new File(['x'], 'big.bin', { lastModified: 1 });
    Object.defineProperty(file, 'size', { value: 25 * MB });
    const api = {
      createUpload: vi.fn(async () => ({ upload_id: 'u1', chunk_size: 10 * MB, chunk_count: 3, expires_at: Date.now() / 1000 + 86400 })),
      uploadStatus: vi.fn(async () => ({ status: 'complete' as const, received: [0, 1, 2], size: 25 * MB, file: result })),
      completeUpload: vi.fn(async () => ({ status: 'processing' as const })),
      abortUpload: vi.fn(async () => undefined),
    };
    const task = new UploadTask(file, { view_limit: 7, view_limit_action: 'private' }, { api, send: vi.fn(async () => undefined) as never, sleep: async () => undefined }, () => undefined);
    await task.start();
    expect(api.createUpload).toHaveBeenCalledWith(expect.objectContaining({ view_limit: 7, view_limit_action: 'private' }));
  });
});
