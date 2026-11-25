import { Download, Music, VideoOff } from 'lucide-react';

import { LinkButton } from '../../components/Button';
import type { FileData } from '../types';
import { downloadUrl } from '../urls';

/** "This video can't play in the browser" (contract §7), with Download. No player. */
export function NotPlayable({ file, kind }: { file: FileData; kind: 'video' | 'audio' }) {
  const Icon = kind === 'video' ? VideoOff : Music;
  return (
    <div className="relative flex flex-col items-center gap-3 p-6 text-center">
      <Icon aria-hidden className="size-10 text-muted" />
      <p className="text-sm font-medium">This {kind} can't play in the browser</p>
      <LinkButton href={downloadUrl(file.cdn_url)} download={file.filename} variant="primary">
        <Download aria-hidden className="size-4" />
        Download
      </LinkButton>
    </div>
  );
}
