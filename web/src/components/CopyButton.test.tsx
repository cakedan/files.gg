import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';
import { COPY_FEEDBACK_MS } from './useCopyState';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function click() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
}

describe('CopyButton', () => {
  it('shows "Copied!" for 1500 ms, then resets', async () => {
    const copy = vi.fn(async () => true);
    render(<CopyButton text="https://files.gg/abc.png" copy={copy} />);
    expect(screen.getByRole('button')).toHaveTextContent('Copy link');

    await click();
    expect(copy).toHaveBeenCalledWith('https://files.gg/abc.png');
    expect(screen.getByRole('button')).toHaveTextContent('Copied!');

    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1));
    expect(screen.getByRole('button')).toHaveTextContent('Copied!');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button')).toHaveTextContent('Copy link');
  });

  it('shows "Copy Failed" when the copy fails or throws', async () => {
    const copy = vi.fn(async () => false);
    const { unmount } = render(<CopyButton text="x" copy={copy} />);
    await click();
    expect(screen.getByRole('button')).toHaveTextContent('Copy Failed');
    act(() => vi.advanceTimersByTime(COPY_FEEDBACK_MS));
    expect(screen.getByRole('button')).toHaveTextContent('Copy link');
    unmount();

    render(<CopyButton text="x" copy={() => Promise.reject(new Error('nope'))} />);
    await click();
    expect(screen.getByRole('button')).toHaveTextContent('Copy Failed');
  });

  it('restarts the timer on repeated clicks', async () => {
    render(<CopyButton text="x" copy={async () => true} />);
    await click();
    act(() => vi.advanceTimersByTime(1000));
    await click();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('button')).toHaveTextContent('Copied!');
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole('button')).toHaveTextContent('Copy link');
  });

  it('uses the Clipboard API by default', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyButton text="https://files.gg/x" />);
    await click();
    expect(writeText).toHaveBeenCalledWith('https://files.gg/x');
    expect(screen.getByRole('button')).toHaveTextContent('Copied!');
  });
});
