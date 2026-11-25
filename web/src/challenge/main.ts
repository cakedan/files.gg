/**
 * `files.gg/challenge` (milestone-6 §10.10): Turnstile for custom domains, in a frame.
 * No React and no API calls: it renders the widget and posts each token to the one
 * parent origin it was served for. See frame.ts for the checks.
 */

import { TURNSTILE_SITE_KEY } from '../lib/config';
import { loadTurnstile } from '../lib/turnstile';
import { parentAllowed, readChallengeConfig, turnstileOptions } from './frame';
import { MSG_ERROR, type ChallengeMessage } from './protocol';

function say(text: string) {
  const status = document.getElementById('status');
  if (!status) return;
  status.textContent = text;
  status.hidden = false;
}

function start() {
  const config = readChallengeConfig({
    json: document.getElementById('challenge-data')?.textContent ?? null,
    search: location.search,
    dev: import.meta.env.DEV,
    mainHost: location.hostname,
    protocol: location.protocol,
  });
  if (!config || !parentAllowed(config, window.parent !== window, location.ancestorOrigins)) {
    say('This check only runs inside a page hosted with files.gg.');
    return;
  }
  const post = (message: ChallengeMessage) => window.parent.postMessage(message, config.targetOrigin);
  if (import.meta.env.DEV && config.simulate === 'error') return post({ type: MSG_ERROR, code: 'simulated' });
  if (import.meta.env.DEV && config.simulate === 'silent') return;

  const container = document.getElementById('widget');
  if (!container) return;
  loadTurnstile()
    .then((api) => {
      const widget: string | undefined = api.render(
        container,
        turnstileOptions(config, TURNSTILE_SITE_KEY, post, () => api.reset(widget)),
      );
    })
    .catch(() => post({ type: MSG_ERROR, code: 'load-failed' }));
}

start();
