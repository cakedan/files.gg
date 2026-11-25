/**
 * Player keyboard shortcuts (contract §7, Appendix A): Space or `k` play/pause,
 * ← / → seek 5 s, `m` mute, `f` fullscreen. Pure, so it's testable without media.
 */

export type PlayerKeyAction = 'toggle' | 'back' | 'forward' | 'mute' | 'fullscreen';

export const SEEK_STEP_S = 5;

export interface KeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface KeyTarget {
  /** Focus is on a button (Space activates it natively instead). */
  onButton: boolean;
  /** Focus is on a slider that uses the arrows itself (volume). */
  onSlider: boolean;
  /** Focus is in a text field anywhere. */
  editable: boolean;
  fullscreen: boolean;
}

export function playerKeyAction(event: KeyLike, target: KeyTarget): PlayerKeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey || target.editable) return null;
  switch (event.key) {
    case ' ':
    case 'Spacebar':
      return target.onButton ? null : 'toggle';
    case 'k':
    case 'K':
      return 'toggle';
    case 'ArrowLeft':
      return target.onSlider ? null : 'back';
    case 'ArrowRight':
      return target.onSlider ? null : 'forward';
    case 'm':
    case 'M':
      return 'mute';
    case 'f':
    case 'F':
      return target.fullscreen ? 'fullscreen' : null;
    default:
      return null;
  }
}

/**
 * Whether a key event belongs to this player: focus is inside it, or (on a single-file
 * page only) nothing else has focus.
 */
export function ownsKeyEvent(root: Element | null, target: EventTarget | null, globalKeys: boolean, doc: Document = document): boolean {
  if (!root) return false;
  if (target instanceof Node && root.contains(target)) return true;
  if (!globalKeys) return false;
  return target === null || target === doc.body || target === doc.documentElement;
}
