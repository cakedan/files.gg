import { Clock, Images, Infinity as InfinityIcon, Lock, Trash2, X } from 'lucide-react';

import { Button } from '../../components/Button';
import type { OwnerFile } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import type { FileHandlers } from './fileMenu';
import { pluralize } from './fileLabels';

/** "N selected · X MB" with the bulk actions. Sticks to the bottom on phones. */
export function BulkBar({ files, handlers, onClear }: { files: OwnerFile[]; handlers: FileHandlers; onClear: () => void }) {
  const size = files.reduce((sum, file) => sum + file.size, 0);
  return (
    <div
      role="region"
      aria-label="Selected files"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-card backdrop-blur sm:sticky sm:bottom-4 sm:rounded-lg sm:border sm:px-3 sm:py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm font-medium" aria-live="polite">
          {pluralize(files.length, 'file')} selected · {formatBytes(size)}
        </span>
        <div className="flex w-full flex-wrap gap-1 sm:w-auto">
          <Button variant="ghost" onClick={() => handlers.setExpiry(files)}>
            <Clock aria-hidden className="size-4" />
            Set expiry…
          </Button>
          {handlers.keepForever && (
            <Button variant="ghost" onClick={() => handlers.keepForever!(files)}>
              <InfinityIcon aria-hidden className="size-4" />
              Keep forever
            </Button>
          )}
          <Button variant="ghost" onClick={() => handlers.changeAccess(files)}>
            <Lock aria-hidden className="size-4" />
            Change access…
          </Button>
          <Button variant="ghost" onClick={() => handlers.addToAlbum(files)}>
            <Images aria-hidden className="size-4" />
            Add to album…
          </Button>
          <Button variant="danger" onClick={() => handlers.remove(files)}>
            <Trash2 aria-hidden className="size-4" />
            Delete
          </Button>
          <Button variant="ghost" onClick={onClear} aria-label="Clear selection" title="Clear selection">
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
