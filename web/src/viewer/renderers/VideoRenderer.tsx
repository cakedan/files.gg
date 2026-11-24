import { Download, VideoOff } from 'lucide-react';
import { useState, type CSSProperties } from 'react';

import { LinkButton } from '../../components/Button';
import { downloadUrl } from '../urls';
import type { RendererProps } from './types';

/** Native video for now (the custom player is a later milestone). */
export default function VideoRenderer({ file }: RendererProps) {
  const [failed, setFailed] = useState(false);
  const poster = file.thumbnail?.url;
  const sized = Boolean(file.width && file.height);
  const style = (sized ? { '--media-w': file.width, '--media-h': file.height } : {}) as CSSProperties;

  if (failed || file.media?.playable === false) {
    return (
      <div
        className={`viewer-well relative ${sized ? 'viewer-media-sized' : 'w-[min(36rem,var(--media-max-width))] aspect-video'}`}
        style={style}
      >
        {poster && <img src={poster} alt="" className="absolute inset-0 size-full object-cover opacity-40" />}
        <div className="relative flex flex-col items-center gap-3 p-6 text-center">
          <VideoOff aria-hidden className="size-10 text-muted" />
          <p className="text-sm font-medium">Can't play this video in the browser</p>
          <LinkButton href={downloadUrl(file.cdnUrl)} download={file.filename} variant="primary">
            <Download aria-hidden className="size-4" />
            Download
          </LinkButton>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-well">
      <video
        src={file.cdnUrl}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        style={style}
        className={sized ? 'viewer-media-sized block bg-black' : 'viewer-media-free block bg-black'}
      />
    </div>
  );
}
