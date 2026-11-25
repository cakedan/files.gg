import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG_ERROR, MSG_EXPIRED, MSG_TOKEN } from '../../challenge/protocol';
import { resetHostContext } from './context';
import { enterCustomHost } from './testing';
import { acceptChallengeMessage, CHALLENGE_TIMEOUT_MS, useChallengeFrame } from './useChallengeFrame';

const MAIN = 'https://files.gg';
const token = (value = 'XXXX.DUMMY.TOKEN.XXXX') => ({ type: MSG_TOKEN, token: value });

describe('acceptChallengeMessage: the parent accepts only https://files.gg, from its own frame', () => {
  const frame = {} as MessageEventSource;
  const other = {} as MessageEventSource;

  it('accepts a token from the main origin and its own frame', () => {
    expect(acceptChallengeMessage({ origin: MAIN, source: frame, data: token() }, MAIN, frame)).toEqual(token());
  });

  it.each([
    ['another origin', { origin: 'https://evil.example', source: frame, data: token() }],
    ['a look-alike origin', { origin: 'https://files.gg.evil.example', source: frame, data: token() }],
    ['plain http', { origin: 'http://files.gg', source: frame, data: token() }],
    ['the CDN (same site, other origin)', { origin: 'https://cdn.files.gg', source: frame, data: token() }],
    ['the page itself', { origin: 'https://i.example.com', source: frame, data: token() }],
    ['a null origin', { origin: 'null', source: frame, data: token() }],
    ['another frame on files.gg', { origin: MAIN, source: other, data: token() }],
    ['no source', { origin: MAIN, source: null, data: token() }],
    ['the wrong type', { origin: MAIN, source: frame, data: { type: 'filesgg:something', token: 'x' } }],
    ['a string', { origin: MAIN, source: frame, data: 'XXXX.DUMMY.TOKEN.XXXX' }],
    ['an empty token', { origin: MAIN, source: frame, data: { type: MSG_TOKEN, token: '' } }],
  ])('rejects %s', (_name, event) => {
    expect(acceptChallengeMessage(event, MAIN, frame)).toBeNull();
  });

  it('rejects everything before the frame exists', () => {
    expect(acceptChallengeMessage({ origin: MAIN, source: frame, data: token() }, MAIN, null)).toBeNull();
  });
});

describe('useChallengeFrame', () => {
  beforeEach(() => {
    enterCustomHost();
  });
  afterEach(() => {
    resetHostContext();
    vi.useRealTimers();
  });

  /** Renders the hook with its container mounted, like the lock screen does. */
  function setup(action: 'unlock' | 'report' = 'unlock') {
    const hook = renderHook(() => useChallengeFrame(action));
    const container = document.createElement('div');
    document.body.append(container);
    act(() => hook.result.current.mount(container));
    const frame = () => container.querySelector('iframe')!;
    const post = (data: unknown, origin = MAIN, source: MessageEventSource | null = frame().contentWindow) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
      });
    return { hook, container, frame, post };
  }

  it('embeds files.gg/challenge for this host and action, sending only the origin as referrer', () => {
    const { frame } = setup('report');
    expect(frame().src).toBe('https://files.gg/challenge?host=i.example.com&action=report');
    expect(frame().referrerPolicy).toBe('origin');
    expect(frame().title).toBe('Human check');
  });

  it('a token from files.gg resolves take(); the spent token loads a fresh frame', async () => {
    const { hook, frame, post } = setup();
    const first = frame();
    post(token('tok-1'));
    expect(hook.result.current.status).toBe('ready');
    let taken = '';
    await act(async () => {
      taken = await hook.result.current.take();
    });
    expect(taken).toBe('tok-1');
    expect(frame()).not.toBe(first);
  });

  it('take() before the token waits for it', async () => {
    const { hook, post } = setup();
    let taken: Promise<string> = Promise.resolve('');
    act(() => {
      taken = hook.result.current.take();
    });
    post(token('tok-2'));
    await expect(taken).resolves.toBe('tok-2');
  });

  it('ignores tokens from any other origin or window', async () => {
    const { hook, post, frame } = setup();
    post(token('forged'), 'https://evil.example');
    post(token('forged'), 'https://i.example.com');
    post(token('forged'), MAIN, window);
    expect(hook.result.current.status).toBe('loading');
    post(token('real'), MAIN, frame().contentWindow);
    await act(async () => {
      await expect(hook.result.current.take()).resolves.toBe('real');
    });
  });

  it('an expired token is dropped', () => {
    const { hook, post } = setup();
    post(token('old'));
    post({ type: MSG_EXPIRED });
    let settled = false;
    act(() => {
      void hook.result.current.take().then(() => (settled = true));
    });
    expect(settled).toBe(false);
  });

  it('an error from the frame fails waiting take() calls and later ones at once', async () => {
    const { hook, post } = setup();
    let waiting: Promise<string> = Promise.resolve('');
    act(() => {
      waiting = hook.result.current.take();
    });
    post({ type: MSG_ERROR, code: '110200' });
    await expect(waiting).rejects.toThrow('turnstile-frame-110200');
    expect(hook.result.current.status).toBe('error');
    await expect(hook.result.current.take()).rejects.toThrow('turnstile-frame-failed');
  });

  it('a frame that never answers fails after the timeout instead of hanging; a late token still counts; retry starts over', async () => {
    vi.useFakeTimers();
    const { hook, post, frame } = setup();
    let waiting: Promise<string> = Promise.resolve('');
    act(() => {
      waiting = hook.result.current.take();
    });
    const rejected = expect(waiting).rejects.toThrow('turnstile-frame-timeout');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHALLENGE_TIMEOUT_MS);
    });
    await rejected;
    expect(hook.result.current.status).toBe('error');

    post(token('late'));
    expect(hook.result.current.status).toBe('ready');

    const before = frame();
    act(() => hook.result.current.retry());
    expect(hook.result.current.status).toBe('loading');
    expect(frame()).not.toBe(before);
  });

  it('disabled: no frame at all', () => {
    const hook = renderHook(() => useChallengeFrame('unlock', false));
    const { container } = render(<div />);
    act(() => hook.result.current.mount(container as HTMLDivElement));
    expect(container.querySelector('iframe')).toBeNull();
  });
});
