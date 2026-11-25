import { createElement, Suspense, useRef, useState, type CSSProperties } from 'react';

import { rendererFor } from '../renderers';
import type { FileData } from '../types';
import { FileFooter } from './FileFooter';
import { RendererFallback } from './RendererFallback';
import { ResizeGrip } from './ResizeGrip';

/** Kinds whose card can be resized from its corner (not documents shown as a PDF, text or downloads). */
const RESIZABLE = new Set(['image', 'video', 'audio']);

export function FileCard({ file }: { file: FileData }) {
  const card = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const resizable = RESIZABLE.has(file.kind) && !file.assets?.document;
  const style = width === null ? undefined : ({ '--viewer-user-width': `${width}px` } as CSSProperties);
  return (
    <article ref={card} className="viewer-card relative" aria-label={file.filename} data-resized={width === null ? undefined : ''} style={style}>
      <Suspense fallback={<RendererFallback file={file} />}>{createElement(rendererFor(file), { file })}</Suspense>
      <FileFooter file={file} />
      {resizable && <ResizeGrip card={card} onResize={setWidth} />}
    </article>
  );
}
