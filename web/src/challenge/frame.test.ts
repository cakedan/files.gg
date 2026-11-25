import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTurnstile } from '../test/turnstile';
import { cDataFor, parentAllowed, readChallengeConfig, turnstileOptions, validParentHost } from './frame';
import { challengeUrl, MSG_ERROR, MSG_EXPIRED, MSG_TOKEN, parseChallengeMessage } from './protocol';

const prod = { search: '', dev: false, mainHost: 'files.gg', protocol: 'https:' };
const data = (host: unknown, action: unknown = 'unlock') => JSON.stringify({ host, action });

describe('readChallengeConfig (production)', () => {
  it('reads #challenge-data and answers only https://<host>', () => {
    expect(readChallengeConfig({ ...prod, json: data('I.Example.com', 'report') })).toEqual({
      host: 'i.example.com',
      action: 'report',
      targetOrigin: 'https://i.example.com',
    });
  });

  it('accepts action view, for opening view-limited files (milestone-6 §19.7)', () => {
    expect(readChallengeConfig({ ...prod, json: data('i.example.com', 'view') })).toEqual({
      host: 'i.example.com',
      action: 'view',
      targetOrigin: 'https://i.example.com',
    });
  });

  it('ignores the query string: only the Worker (after its domain lookup) names the parent', () => {
    expect(readChallengeConfig({ ...prod, json: null, search: '?host=evil.example&action=unlock' })).toBeNull();
    expect(readChallengeConfig({ ...prod, json: data('i.example.com'), search: '?host=evil.example&simulate=error' })).toEqual({
      host: 'i.example.com',
      action: 'unlock',
      targetOrigin: 'https://i.example.com',
    });
  });

  it.each([
    ['files.gg'],
    ['cdn.files.gg'],
    ['x.files.gg'],
    ['192.0.2.1'],
    ['localhost'],
    ['i.example.com:8443'],
    ['-bad.example.com'],
    ['i.example.com/path'],
    ['https://i.example.com'],
    [''],
    [42],
  ])('refuses the parent host %o', (host) => {
    expect(readChallengeConfig({ ...prod, json: data(host) })).toBeNull();
  });

  it('refuses unknown actions and malformed data', () => {
    expect(readChallengeConfig({ ...prod, json: data('i.example.com', 'login') })).toBeNull();
    expect(readChallengeConfig({ ...prod, json: '{oops' })).toBeNull();
    expect(readChallengeConfig({ ...prod, json: 'null' })).toBeNull();
  });
});

describe('readChallengeConfig (development)', () => {
  it('reads the query (no Worker), allows a port and targets the dev protocol', () => {
    expect(
      readChallengeConfig({ json: null, search: '?host=localhost:5173&action=unlock&simulate=silent', dev: true, mainHost: 'localhost', protocol: 'http:' }),
    ).toEqual({ host: 'localhost:5173', action: 'unlock', targetOrigin: 'http://localhost:5173', simulate: 'silent' });
  });
});

describe('validParentHost', () => {
  it('accepts customer subdomains, not files.gg', () => {
    expect(validParentHost('i.example.com', 'files.gg', false)).toBe(true);
    expect(validParentHost('xn--bcher-kva.example.com', 'files.gg', false)).toBe(true);
    expect(validParentHost('files.gg', 'files.gg', false)).toBe(false);
    expect(validParentHost('a.b.files.gg', 'files.gg', false)).toBe(false);
  });
});

describe('parentAllowed', () => {
  const config = { host: 'i.example.com', action: 'unlock' as const, targetOrigin: 'https://i.example.com' };

  it('must be framed', () => {
    expect(parentAllowed(config, false, undefined)).toBe(false);
  });

  it('where the browser exposes ancestorOrigins, the parent must be https://<host>', () => {
    expect(parentAllowed(config, true, ['https://i.example.com'])).toBe(true);
    expect(parentAllowed(config, true, ['https://evil.example'])).toBe(false);
    expect(parentAllowed(config, true, ['http://i.example.com'])).toBe(false);
    expect(parentAllowed(config, true, ['https://i.example.com.evil.example'])).toBe(false);
  });

  it('a masked ("null") or missing ancestor list leaves it to postMessage\'s targetOrigin', () => {
    expect(parentAllowed(config, true, ['null'])).toBe(true);
    expect(parentAllowed(config, true, undefined)).toBe(true);
    expect(parentAllowed(config, true, [])).toBe(true);
  });
});

describe('turnstileOptions', () => {
  it('managed, shown, action and cData from the config; callbacks post the protocol messages', () => {
    const post = vi.fn();
    const onTimeout = vi.fn();
    const options = turnstileOptions({ host: 'i.example.com', action: 'report', targetOrigin: 'https://i.example.com' }, 'site-key', post, onTimeout);
    expect(options).toMatchObject({ sitekey: 'site-key', action: 'report', cData: 'i_example_com', appearance: 'always', theme: 'dark' });
    options.callback?.('tok-1');
    options['error-callback']?.('110200');
    options['expired-callback']?.();
    options['timeout-callback']?.();
    expect(post.mock.calls).toEqual([[{ type: MSG_TOKEN, token: 'tok-1' }], [{ type: MSG_ERROR, code: '110200' }], [{ type: MSG_EXPIRED }]]);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('cData keeps only Turnstile\'s allowed characters', () => {
    expect(cDataFor('a-b.example.co.uk')).toBe('a-b_example_co_uk');
    expect(cDataFor('localhost:5173')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('protocol', () => {
  it('builds the frame URL', () => {
    expect(challengeUrl('https://files.gg', 'i.example.com', 'unlock')).toBe('https://files.gg/challenge?host=i.example.com&action=unlock');
  });

  it('parses only well-formed messages', () => {
    expect(parseChallengeMessage({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' })).toEqual({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' });
    expect(parseChallengeMessage({ type: MSG_TOKEN, token: '' })).toBeNull();
    expect(parseChallengeMessage({ type: MSG_TOKEN, token: 'x'.repeat(2049) })).toBeNull();
    expect(parseChallengeMessage({ type: MSG_TOKEN, token: 42 })).toBeNull();
    expect(parseChallengeMessage({ type: MSG_ERROR })).toEqual({ type: MSG_ERROR, code: 'unknown' });
    expect(parseChallengeMessage({ type: 'filesgg:other', token: 'x' })).toBeNull();
    expect(parseChallengeMessage('filesgg:turnstile')).toBeNull();
    expect(parseChallengeMessage(null)).toBeNull();
  });
});

describe('the frame page (main.ts)', () => {
  const parentWindow = window.parent;

  afterEach(() => {
    Object.defineProperty(window, 'parent', { value: parentWindow, configurable: true });
    document.body.replaceChildren();
    delete window.turnstile;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const page = (json: string | null) => {
    document.body.innerHTML = '<div id="widget"></div><p id="status" hidden></p>';
    if (json !== null) {
      const script = document.createElement('script');
      script.id = 'challenge-data';
      script.type = 'application/json';
      script.textContent = json;
      document.body.append(script);
    }
  };

  it('posts each token to the one parent origin it was served for, with Turnstile action and cData', async () => {
    vi.stubEnv('DEV', false);
    page(data('i.example.com', 'unlock'));
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true });
    const { api } = installTurnstile();
    await import('./main');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(postMessage).toHaveBeenCalledWith({ type: MSG_TOKEN, token: 'XXXX.DUMMY.TOKEN.XXXX' }, 'https://i.example.com');
    expect(api.render).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ action: 'unlock', cData: 'i_example_com' }));
  });

  it('answers nobody and loads nothing when it isn\'t framed', async () => {
    vi.stubEnv('DEV', false);
    page(data('i.example.com', 'unlock'));
    const { api } = installTurnstile();
    await import('./main');
    expect(document.getElementById('status')).toHaveTextContent('This check only runs inside a page hosted with files.gg.');
    expect(document.getElementById('status')).toBeVisible();
    expect(api.render).not.toHaveBeenCalled();
  });

  it('answers nobody when the data names a subdomain of its own host (jsdom serves it from localhost)', async () => {
    vi.stubEnv('DEV', false);
    page(data('cdn.localhost', 'unlock'));
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true });
    const { api } = installTurnstile();
    await import('./main');
    expect(api.render).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('reports a Turnstile failure to the parent instead of going quiet', async () => {
    vi.stubEnv('DEV', false);
    page(data('i.example.com', 'report'));
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', { value: { postMessage }, configurable: true });
    installTurnstile({ fail: true });
    await import('./main');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(postMessage).toHaveBeenCalledWith({ type: MSG_ERROR, code: '110200' }, 'https://i.example.com');
  });
});

describe('challenge.html', () => {
  it('has no element with id "turnstile" (it would become window.turnstile and shadow the API)', async () => {
    const { default: html } = await import('../../challenge.html?raw');
    expect(html).not.toMatch(/id=["']turnstile["']/);
    expect(html).toMatch(/id="widget"/);
  });
});
