import { Download } from 'lucide-react';

import { LinkButton } from '../../components/Button';
import { formatBytes } from '../../lib/format';
import { downloadUrl } from '../urls';
import { FileTypeIcon } from './FileTypeIcon';
import type { RendererProps } from './types';

/** Fallback for any kind without a dedicated renderer: a type icon and a download button. */
export function GenericRenderer({ file }: RendererProps) {
  return (
    <div className="viewer-well w-[min(28rem,var(--media-max-width))] flex-col gap-3 px-6 py-10 text-center">
      <FileTypeIcon kind={file.kind} mimetype={file.mimetype} strokeWidth={1.5} className="size-16 text-gg" />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium uppercase tracking-wide text-muted">
          {file.extension ? `.${file.extension}` : 'File'} · {formatBytes(file.size)}
        </span>
        <span className="text-xs text-muted">No preview available for this file type.</span>
      </div>
      <LinkButton href={downloadUrl(file.cdn_url)} variant="primary" download={file.filename}>
        <Download aria-hidden className="size-4" />
        Download
      </LinkButton>
    </div>
  );
}
