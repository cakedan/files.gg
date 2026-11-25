import { Sparkles } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../../components/Button';
import type { OwnerAlbum } from '../../lib/api';
import { Dialog } from '../components/Dialog';
import { FileThumb } from '../files/FileThumb';

/** Cover picker: automatic (the first visual item), or any item. */
export function CoverDialog({ album, onSave, onClose }: { album: OwnerAlbum; onSave: (fileId: string | null) => void; onClose: () => void }) {
  const id = useId();
  const [choice, setChoice] = useState<string | null>(album.cover_file_id);
  const candidates = album.items.filter((item) => item.kind !== 'file' && item.kind !== 'text');

  return (
    <Dialog
      title="Album cover"
      description="Shown on the album card and the shared link preview."
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(choice);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="sr-only">Cover</legend>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <li>
            <label className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-md border ${choice === null ? 'border-gg ring-1 ring-gg' : 'border-line'}`}>
              <span className="flex aspect-[4/3] items-center justify-center bg-well">
                <Sparkles aria-hidden className="size-8 text-gg" strokeWidth={1.5} />
              </span>
              <span className="flex items-center gap-1.5 p-1.5 text-xs">
                <input type="radio" name={`${id}-cover`} checked={choice === null} onChange={() => setChoice(null)} className="accent-gg" />
                Automatic
              </span>
            </label>
          </li>
          {candidates.map((item) => (
            <li key={item.id}>
              <label className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-md border ${choice === item.id ? 'border-gg ring-1 ring-gg' : 'border-line'}`}>
                <FileThumb file={item} size="lg" />
                <span className="flex min-w-0 items-center gap-1.5 p-1.5 text-xs">
                  <input type="radio" name={`${id}-cover`} checked={choice === item.id} onChange={() => setChoice(item.id)} className="accent-gg" />
                  <span className="truncate">{item.filename}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </Dialog>
  );
}
