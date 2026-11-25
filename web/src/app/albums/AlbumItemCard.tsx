import { EyeOff, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import type { OwnerAlbum, OwnerAlbumItem } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { AccessBadge } from '../files/AccessBadge';
import { SafetyBadge } from '../safety/SafetyBadge';
import { FileThumb } from '../files/FileThumb';
import { hiddenNote } from './hiddenNote';

export const CAPTION_MAX = 500;

interface AlbumItemCardProps {
  item: OwnerAlbumItem;
  album: OwnerAlbum;
  index: number;
  handle: ReactNode;
  readOnly: boolean;
  onCaption: (caption: string) => void;
  onRemove: () => void;
}

/** One item in the editor: drag handle, thumbnail, inline caption, hidden note, remove. */
export function AlbumItemCard({ item, album, index, handle, readOnly, onCaption, onRemove }: AlbumItemCardProps) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const note = hiddenNote(item, album);
  const isCover = album.cover_file_id === item.id;

  return (
    <article
      aria-label={`${index + 1}. ${item.filename}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-surface ${note ? 'border-warn/50' : 'border-line'}`}
    >
      <div className="relative">
        <FileThumb file={item} size="lg" active={hover} className={note ? 'opacity-60' : ''} />
        <span className="absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-white">{index + 1}</span>
        {isCover && <span className="absolute bottom-2 left-2 rounded bg-gg px-1.5 py-0.5 text-xs font-semibold text-gg-ink">Cover</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2">
        <div className="flex items-center gap-1">
          {handle}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium" title={item.filename}>
              {item.filename}
            </span>
            <span className="flex items-center gap-2 text-xs text-muted">
              {formatBytes(item.size)}
              <AccessBadge visibility={item.visibility} compact />
              <SafetyBadge safety={item.safety} compact />
            </span>
          </div>
          {!readOnly && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${item.filename} from the album`}
              title="Remove from album"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-danger"
            >
              <X aria-hidden className="size-4" />
            </button>
          )}
        </div>
        {note && (
          <p className="flex items-start gap-1.5 rounded-md bg-warn/10 px-2 py-1.5 text-xs text-warn">
            <EyeOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {note}
          </p>
        )}
        <label htmlFor={`${id}-caption`} className="sr-only">
          Caption for {item.filename}
        </label>
        <CaptionField id={`${id}-caption`} key={item.caption} value={item.caption} readOnly={readOnly} onSave={onCaption} />
      </div>
    </article>
  );
}

/** Saves on blur (or ⌘/Ctrl+Enter) when changed. Keyed by the saved caption, so a server change resets it. */
function CaptionField({ id, value, readOnly, onSave }: { id: string; value: string; readOnly: boolean; onSave: (caption: string) => void }) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onSave(draft);
  };
  return (
    <div className="flex flex-col gap-0.5">
      <textarea
        id={id}
        value={draft}
        readOnly={readOnly}
        maxLength={CAPTION_MAX}
        rows={2}
        placeholder={readOnly ? '' : 'Add a caption'}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            setDraft(value);
          }
        }}
        className="min-h-14 w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 text-sm placeholder:text-muted/70"
      />
      {draft.length > CAPTION_MAX - 50 && (
        <span className="self-end text-xs text-muted">
          {draft.length}/{CAPTION_MAX}
        </span>
      )}
    </div>
  );
}
