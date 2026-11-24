import { createElement, Suspense } from 'react';

import { getRenderer } from '../renderers';
import type { FileData } from '../types';
import { FileFooter } from './FileFooter';
import { RendererFallback } from './RendererFallback';

export function FileCard({ file }: { file: FileData }) {
  return (
    <article className="viewer-card" aria-label={file.filename}>
      <Suspense fallback={<RendererFallback file={file} />}>{createElement(getRenderer(file.kind), { file })}</Suspense>
      <FileFooter file={file} />
    </article>
  );
}
