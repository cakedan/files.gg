import type { CSSProperties } from 'react';

import type { FileData } from '../types';

/** Holds the media's space while a lazy renderer chunk loads, so the card doesn't jump. */
export function RendererFallback({ file }: { file: FileData }) {
  if (file.kind === 'pdf') {
    return (
      <div
        className="viewer-well min-h-[18rem]"
        style={{ width: 'min(62.5rem, var(--media-max-width))', height: 'var(--pdf-height, var(--media-max-height))' }}
        aria-busy="true"
      />
    );
  }
  if (file.kind === 'text') {
    return <div className="viewer-well h-[min(24rem,var(--media-max-height))] w-[min(75rem,var(--media-max-width))]" aria-busy="true" />;
  }
  if (file.kind === 'audio') {
    return <div className="viewer-well h-64 w-[min(35rem,var(--media-max-width))]" aria-busy="true" />;
  }
  if (file.width && file.height) {
    const style = { '--media-w': file.width, '--media-h': file.height } as CSSProperties;
    return <div className="viewer-well viewer-media-sized" style={style} aria-busy="true" />;
  }
  return <div className="viewer-well h-48 w-[min(28rem,var(--media-max-width))]" aria-busy="true" />;
}
