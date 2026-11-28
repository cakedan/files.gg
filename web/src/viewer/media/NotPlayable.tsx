import { Music, VideoOff, Wand2 } from 'lucide-react';

import { LinkButton } from '../../components/Button';
import { convertPath } from '../../lib/convertKinds';
import { fileReportTarget } from '../components/reportPath';
import { hostContext, mainUrl } from '../host/context';
import type { FileData } from '../types';

/**
 * "This video can't play in the browser" (contract §7), and for a video "Convert to MP4 to
 * play in browser" (milestone-5 §13.2), which starts the `play_everywhere` preset on files.gg
 * (in a new tab from a custom domain). No player. Download is the footer's.
 * Secondary, so Copy link stays the card's one green action.
 */
export function NotPlayable({ file, kind }: { file: FileData; kind: 'video' | 'audio' }) {
  const Icon = kind === 'video' ? VideoOff : Music;
  const target = kind === 'video' && !file.view_limit ? fileReportTarget(file) : null;
  const convert = target?.type === 'file' ? mainUrl(convertPath(target.vanity, { preset: 'play_everywhere' })) : null;
  return (
    <div className="relative flex flex-col items-center gap-3 p-6 text-center">
      <Icon aria-hidden className="size-10 text-muted" />
      <p className="text-sm font-medium">This {kind} can't play in the browser</p>
      {convert && (
        <LinkButton href={convert} {...(hostContext().custom ? { target: '_blank', rel: 'noopener' } : {})}>
          <Wand2 aria-hidden className="size-4" />
          Convert to MP4 to play in browser
        </LinkButton>
      )}
    </div>
  );
}
