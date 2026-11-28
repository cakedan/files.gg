import { FileUp, FolderOpen, Images, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import type { OwnerAlbumSummary, OwnerFile } from '../../lib/api';
import { AlbumPicker, LibraryPicker } from './SourcePickers';

/**
 * §13.1 step 1: drop or paste a file anywhere on the page, or choose one; signed in,
 * pick one from the library or an album.
 */
export function SourceStep({
  signedIn,
  onFile,
  onLibraryFile,
  onAlbum,
}: {
  signedIn: boolean;
  onFile: (file: File) => void;
  onLibraryFile: (file: OwnerFile) => void;
  onAlbum: (album: OwnerAlbumSummary) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<'library' | 'album' | null>(null);
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  });

  // Drop anywhere on the page, and paste (the Upload page's rules): one file is the source.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file) onFileRef.current(file);
    };
    const onPaste = (event: ClipboardEvent) => {
      const file = event.clipboardData?.files[0];
      if (!file) return;
      event.preventDefault();
      onFileRef.current(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  return (
    <section aria-label="Source" className={`flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-10 text-center transition-colors ${dragging ? 'border-gg bg-gg/5' : 'border-line'}`}>
      <FileUp aria-hidden className="size-10 text-gg" strokeWidth={1.5} />
      <p className="text-sm">Drop a file anywhere on this page, paste it, or choose one.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => inputRef.current?.click()}>
          <Upload aria-hidden className="size-4" />
          Choose a file
        </Button>
        {signedIn && (
          <>
            <Button onClick={() => setDialog('library')}>
              <FolderOpen aria-hidden className="size-4" />
              From your files
            </Button>
            <Button onClick={() => setDialog('album')}>
              <Images aria-hidden className="size-4" />
              From an album
            </Button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        aria-label="Choose a file to convert"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      {dialog === 'library' && (
        <LibraryPicker
          onClose={() => setDialog(null)}
          onPick={(file) => {
            setDialog(null);
            onLibraryFile(file);
          }}
        />
      )}
      {dialog === 'album' && (
        <AlbumPicker
          onClose={() => setDialog(null)}
          onPick={(album) => {
            setDialog(null);
            onAlbum(album);
          }}
        />
      )}
    </section>
  );
}
