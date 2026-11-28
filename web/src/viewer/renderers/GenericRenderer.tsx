import { lazy, Suspense } from 'react';

import { documentLabel } from '../../lib/convertKinds';
import { formatBytes } from '../../lib/format';
import { FileTypeIcon } from './FileTypeIcon';
import type { RendererProps } from './types';

/** Milestone 5 §9.2: only documents without a preview load it. */
const DocumentConvert = lazy(() => import('../convert/DocumentConvert'));

/**
 * Fallback for any kind without a dedicated renderer: a type icon, the type and size, and for a
 * document, Convert. Download lives in the footer: one per card (DESIGN.md, one green action).
 */
export function GenericRenderer({ file }: RendererProps) {
  const document = documentLabel(file.mimetype);
  return (
    <div className="viewer-well w-[min(28rem,var(--media-max-width))] min-w-full flex-col gap-3 px-6 py-10 text-center">
      {/* Amber under a scanner warning: green would say "go" (DESIGN.md, Green Means Go). */}
      <FileTypeIcon
        kind={file.kind}
        mimetype={file.mimetype}
        strokeWidth={1.5}
        className={`size-16 ${file.warnings?.length ? 'text-warn' : 'text-gg'}`}
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium uppercase tracking-wide text-muted">
          {file.extension ? `.${file.extension}` : 'File'} · {formatBytes(file.size)}
        </span>
        <span className="text-xs text-muted">{document ? `${document} · no preview yet` : 'No preview available for this file type.'}</span>
      </div>
      {document && (
        <div className="flex flex-wrap justify-center gap-2">
          <Suspense fallback={null}>
            <DocumentConvert file={file} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
