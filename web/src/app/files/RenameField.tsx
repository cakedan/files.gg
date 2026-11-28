import { useEffect, useRef, useState } from 'react';

import type { OwnerFile } from '../../lib/api';

interface RenameFieldProps {
  file: OwnerFile;
  onSave: (name: string) => void;
  onCancel: () => void;
}

/** Inline rename: the name only; the extension stays (contract §6). Enter saves, Esc cancels. */
export function RenameField({ file, onSave, onCancel }: RenameFieldProps) {
  const [value, setValue] = useState(file.name);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (save && name && name !== file.name) onSave(name);
    else onCancel();
  };

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <input
        ref={ref}
        value={value}
        maxLength={200}
        aria-label={`New name for ${file.filename}`}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className="h-8 min-w-0 flex-1 rounded-xl border border-gg/60 bg-bg px-2 text-sm"
      />
      {file.extension && <span className="shrink-0 text-sm text-muted">.{file.extension}</span>}
    </span>
  );
}
