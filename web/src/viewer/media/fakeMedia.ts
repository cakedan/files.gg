/**
 * Test helper: jsdom has no media playback, so this gives a `<video>`/`<audio>` element
 * working `paused`, `currentTime`, `duration`, `volume`, `muted`, `playbackRate` and
 * `preservesPitch`, firing the events the player listens to. Test-only.
 */
export function fakeMedia(element: HTMLMediaElement, { duration = 60 }: { duration?: number } = {}) {
  const values = { paused: true, currentTime: 0, volume: 1, muted: false, playbackRate: 1, preservesPitch: true };
  const fire = (type: string) => element.dispatchEvent(new Event(type));
  const prop = <K extends keyof typeof values>(key: K, event?: string) =>
    Object.defineProperty(element, key, {
      configurable: true,
      get: () => values[key],
      set: (value: (typeof values)[K]) => {
        values[key] = value;
        if (event) fire(event);
      },
    });
  prop('currentTime', 'timeupdate');
  prop('volume', 'volumechange');
  prop('muted', 'volumechange');
  prop('playbackRate', 'ratechange');
  prop('preservesPitch');
  Object.defineProperty(element, 'paused', { configurable: true, get: () => values.paused });
  Object.defineProperty(element, 'ended', { configurable: true, get: () => false });
  Object.defineProperty(element, 'duration', { configurable: true, get: () => duration });
  Object.defineProperty(element, 'buffered', {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => Math.min(duration, values.currentTime + 10) }),
  });
  element.play = () => {
    values.paused = false;
    fire('play');
    return Promise.resolve();
  };
  element.pause = () => {
    values.paused = true;
    fire('pause');
  };
  fire('durationchange');
  return values;
}
