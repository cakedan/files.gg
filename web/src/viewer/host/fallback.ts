import { hostContext } from './context';

const encodeVanity = (vanity: string) => vanity.split('/').map(encodeURIComponent).join('/');

export type FallbackTarget =
  | { type: 'file' | 'album'; vanity: string; report?: boolean }
  | { type: 'any' };

/**
 * Where "Open on files.gg to continue" goes when the challenge frame fails: the same
 * file or album on files.gg (its report page, for a report), or files.gg's report page.
 */
export function fallbackUrl(target: FallbackTarget, mainOrigin: string = hostContext().mainOrigin): string {
  if (target.type === 'any') return `${mainOrigin}/report`;
  const path = target.type === 'album' ? `/a/${encodeVanity(target.vanity)}` : `/${encodeVanity(target.vanity)}`;
  return `${mainOrigin}${path}${target.report ? '/report' : ''}`;
}
