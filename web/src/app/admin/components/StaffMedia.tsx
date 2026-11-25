import { Eye, EyeOff, FileQuestion, ShieldOff } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import { Button } from '../../../components/Button';
import type { FileKind } from '../../../lib/api';
import type { StaffUrls } from '../adminApi';

/** §11.3: every image, video and poster is blurred and greyscale until Reveal. */
const STAFF_SAFE_FILTER: CSSProperties = { filter: 'blur(24px) grayscale(1)' };

interface StaffMediaProps {
  kind: FileKind;
  label: string;
  urls: StaffUrls | undefined;
  /** Hash-matched CSAM: a placeholder, and no URL is ever requested. */
  hashMatched?: boolean;
  /** Why there are no URLs (a child-safety case without the capability). */
  unavailableReason?: string;
  size?: 'sm' | 'lg';
}

/**
 * Staff previews (milestone-4 §11.3): blurred and greyscale by default, with no hover
 * playback and no autoplay; Reveal is per item and resets when the page is left.
 */
export function StaffMedia({ kind, label, urls, hashMatched = false, unavailableReason, size = 'lg' }: StaffMediaProps) {
  const [revealed, setRevealed] = useState(false);
  const frame = `relative flex items-center justify-center overflow-hidden rounded-md bg-well ${size === 'lg' ? 'aspect-video w-full' : 'aspect-square w-full'}`;

  if (hashMatched) {
    return (
      <div className={`${frame} flex-col gap-2 p-4 text-center`} data-testid="not-displayable">
        <ShieldOff aria-hidden className="size-8 text-danger" />
        <p className="text-sm font-semibold">Not displayable</p>
        <p className="text-xs text-muted">Hash-matched content is never shown, to anyone.</p>
      </div>
    );
  }
  if (!urls) {
    return (
      <div className={`${frame} flex-col gap-2 p-4 text-center`}>
        <EyeOff aria-hidden className="size-6 text-muted" />
        <p className="text-xs text-muted">{unavailableReason ?? 'No preview is available.'}</p>
      </div>
    );
  }

  const poster = urls.previews.poster ?? urls.previews['thumb-2x'] ?? urls.previews.thumb ?? urls.previews.cover ?? urls.previews.display;
  const style = revealed ? undefined : STAFF_SAFE_FILTER;
  let media;
  if (kind === 'image') {
    media = <img src={urls.previews.display ?? urls.content} alt="" style={style} data-safe={revealed ? undefined : 'blurred'} className="size-full object-contain" />;
  } else if (kind === 'video') {
    media = (
      // No autoplay; controls only after Reveal, so nothing plays while blurred.
      <video src={urls.content} poster={poster} controls={revealed} preload="metadata" playsInline style={style} data-safe={revealed ? undefined : 'blurred'} className="size-full object-contain" />
    );
  } else if (poster) {
    media = <img src={poster} alt="" style={style} data-safe={revealed ? undefined : 'blurred'} className="size-full object-contain" />;
  } else {
    media = <FileQuestion aria-hidden className="size-10 text-muted" />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className={frame}>{media}</div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setRevealed(!revealed)} aria-label={`${revealed ? 'Blur' : 'Reveal'} ${label}`}>
          {revealed ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
          {revealed ? 'Blur again' : 'Reveal'}
        </Button>
        {kind === 'audio' && revealed && <audio src={urls.content} controls preload="none" className="h-9 max-w-full" />}
        {revealed && (
          <a href={urls.content} target="_blank" rel="noopener noreferrer" className="text-sm text-gg hover:underline">
            Open the file
          </a>
        )}
        <span className="text-xs text-muted">Staff links last 10 minutes.</span>
      </div>
    </div>
  );
}
