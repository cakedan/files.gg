import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTurnstile } from '../test/turnstile';
import { ViewerApp } from './ViewerApp';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => installTurnstile());
afterEach(() => {
  delete window.turnstile;
  window.history.replaceState(null, '', '/');
});

describe('ViewerApp: protected pages', () => {
  it('renders the lazy lock screen for a locked shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    render(<ViewerApp state={{ page: 'locked', target: { kind: 'file', vanity: 'abc', passwordExpired: false } }} />);
    expect(await screen.findByRole('heading', { name: 'This file is password protected' })).toBeInTheDocument();
  });

  it('a missing shell with #t= tries the owner pass for the path vanity before saying "doesn\'t exist"', async () => {
    window.history.replaceState(null, '', '/private123');
    const fetch = vi.fn(async () => json({ code: 'UNKNOWN_FILE', message: 'x', status: 404 }, 404));
    vi.stubGlobal('fetch', fetch);
    render(<ViewerApp state={{ page: 'missing' }} secrets={{ ownerPass: 'pass', rest: '' }} />);
    expect(await screen.findByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
    expect(String((fetch.mock.calls[0] as unknown as [string])[0])).toMatch(/\/files\/private123\/view$/);
  });

  it('a missing shell without #t= makes no request', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<ViewerApp state={{ page: 'missing' }} />);
    expect(screen.getByRole('heading', { name: "This file doesn't exist or has expired." })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
