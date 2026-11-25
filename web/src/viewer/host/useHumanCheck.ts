import { useTurnstile } from '../../components/useTurnstile';
import type { ChallengeAction } from '../../challenge/protocol';
import { hostContext } from './context';
import { useChallengeFrame } from './useChallengeFrame';

/**
 * Turnstile for the lock screen and the report form: the widget itself on files.gg,
 * the `files.gg/challenge` frame on a custom domain (milestone-6 §10.10), whose hostname
 * a Turnstile widget can't list. Both hooks are always called; only one is enabled.
 * `framed` tells the page to offer "Open on files.gg to continue" when the check fails.
 */
export function useHumanCheck(action: ChallengeAction, enabled = true) {
  const framed = hostContext().custom;
  const direct = useTurnstile(action, enabled && !framed);
  const frame = useChallengeFrame(action, enabled && framed);
  const { mount, status, take, retry } = framed ? frame : direct;
  return { mount, status, take, retry, framed };
}
