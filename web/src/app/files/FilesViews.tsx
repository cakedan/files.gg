import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import type { OwnerFile } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { pageSelectionState, type Selection } from '../../lib/files/selection';
import { epochMs, formatFullDate, formatRelative } from '../../lib/time';
import { Menu } from '../components/Menu';
import { SafetyBadge } from '../safety/SafetyBadge';
import { AccessBadge } from './AccessBadge';
import { fileMenuItems, type FileHandlers } from './fileMenu';
import { FileThumb } from './FileThumb';
import { RenameField } from './RenameField';
import { typeLabel } from './fileLabels';

export interface FilesViewProps {
  files: OwnerFile[];
  selection: Selection;
  onToggle: (id: string, shift: boolean) => void;
  onToggleAll: () => void;
  onOpen: (file: OwnerFile) => void;
  renamingId: string | null;
  onRename: (file: OwnerFile, name: string) => void;
  onRenameCancel: () => void;
  handlers: FileHandlers;
  now: number;
}

const HOUR = 3600_000;

/** Clicks on controls inside a row don't open the drawer. */
const fromControl = (event: MouseEvent) =>
  (event.target as HTMLElement).closest('button, a, input, label, select, textarea, [role="menu"]') !== null;

function Expires({ file, now }: { file: OwnerFile; now: number }) {
  if (file.expires_at === null) return <span className="text-muted">Never</span>;
  const expiresAt = epochMs(file.expires_at);
  const soon = expiresAt - now < 24 * HOUR;
  return (
    <span className={soon ? 'text-warn' : 'text-muted'} title={formatFullDate(expiresAt)}>
      {expiresAt <= now ? 'Expired' : formatRelative(expiresAt, now)}
    </span>
  );
}

function RowCheckbox({ file, checked, onToggle }: { file: OwnerFile; checked: boolean; onToggle: FilesViewProps['onToggle'] }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={`Select ${file.filename}`}
      onChange={() => undefined}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(file.id, event.shiftKey);
      }}
      className="size-4 accent-gg"
    />
  );
}

function SelectAll({ files, selection, onToggleAll }: Pick<FilesViewProps, 'files' | 'selection' | 'onToggleAll'>) {
  const ref = useRef<HTMLInputElement>(null);
  const state = pageSelectionState(selection, files.map((file) => file.id));
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input ref={ref} type="checkbox" checked={state === 'all'} onChange={onToggleAll} aria-label="Select all on this page" className="size-4 accent-gg" />
  );
}

/** Hovered or focused, so the thumbnail can play its hover clip. */
function useActive() {
  const [active, setActive] = useState(false);
  return {
    active,
    bind: {
      onMouseEnter: () => setActive(true),
      onMouseLeave: () => setActive(false),
      onFocus: () => setActive(true),
      onBlur: (event: React.FocusEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setActive(false);
      },
    },
  };
}

function NameCell({ file, props }: { file: OwnerFile; props: FilesViewProps }) {
  if (props.renamingId === file.id) {
    return <RenameField file={file} onSave={(name) => props.onRename(file, name)} onCancel={props.onRenameCancel} />;
  }
  return (
    <button
      type="button"
      onClick={() => props.onOpen(file)}
      className="min-w-0 truncate text-left text-sm font-medium hover:text-gg hover:underline"
      title={file.filename}
    >
      {file.filename}
    </button>
  );
}

function TableRow({ file, props }: { file: OwnerFile; props: FilesViewProps }) {
  const { active, bind } = useActive();
  const selected = props.selection.ids.has(file.id);
  return (
    <tr
      {...bind}
      aria-selected={selected}
      onClick={(event) => {
        if (!fromControl(event)) props.onOpen(file);
      }}
      className={`cursor-pointer border-b border-line last:border-0 ${selected ? 'bg-gg/5' : 'hover:bg-surface-2/60'}`}
    >
      <td className="w-10 py-2 pr-1 pl-3">
        <RowCheckbox file={file} checked={selected} onToggle={props.onToggle} />
      </td>
      <td className="py-2 pr-3">
        <div className="flex min-w-0 items-center gap-3">
          <FileThumb file={file} active={active} />
          <NameCell file={file} props={props} />
          <SafetyBadge safety={file.safety} />
        </div>
      </td>
      <td className="px-3 py-2 text-sm whitespace-nowrap text-muted">{typeLabel(file)}</td>
      <td className="px-3 py-2 text-sm whitespace-nowrap text-muted">{formatBytes(file.size)}</td>
      <td className="px-3 py-2 text-sm whitespace-nowrap text-muted" title={formatFullDate(epochMs(file.uploaded_at))}>
        {formatRelative(epochMs(file.uploaded_at), props.now)}
      </td>
      <td className="px-3 py-2 text-sm whitespace-nowrap">
        <Expires file={file} now={props.now} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <AccessBadge visibility={file.visibility} />
      </td>
      <td className="w-10 py-2 pr-2">
        <Menu label={`Actions for ${file.filename}`} items={fileMenuItems(file, props.handlers)} />
      </td>
    </tr>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={`px-3 py-2 text-left text-xs font-medium text-muted ${className}`}>
      {children}
    </th>
  );
}

/** Desktop table: ☐, thumbnail + name, type, size, uploaded, expires, access, ⋯. */
export function FilesTable(props: FilesViewProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full min-w-[44rem] table-fixed">
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="w-24" />
          <col className="w-24" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-28" />
          <col className="w-12" />
        </colgroup>
        <thead className="border-b border-line">
          <tr>
            <th scope="col" className="py-2 pr-1 pl-3">
              <SelectAll {...props} />
            </th>
            <Th>Name</Th>
            <Th>Type</Th>
            <Th>Size</Th>
            <Th>Uploaded</Th>
            <Th>Expires</Th>
            <Th>Access</Th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.files.map((file) => (
            <TableRow key={file.id} file={file} props={props} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CardRow({ file, props }: { file: OwnerFile; props: FilesViewProps }) {
  const { active, bind } = useActive();
  const selected = props.selection.ids.has(file.id);
  return (
    <li
      {...bind}
      onClick={(event) => {
        if (!fromControl(event)) props.onOpen(file);
      }}
      className={`flex items-center gap-3 rounded-lg border p-2.5 ${selected ? 'border-gg/50 bg-gg/5' : 'border-line bg-surface'}`}
    >
      <RowCheckbox file={file} checked={selected} onToggle={props.onToggle} />
      <FileThumb file={file} active={active} className="size-12" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <NameCell file={file} props={props} />
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <SafetyBadge safety={file.safety} />
          <span>{formatBytes(file.size)}</span>
          <span>{formatRelative(epochMs(file.uploaded_at), props.now)}</span>
          {file.expires_at !== null && <Expires file={file} now={props.now} />}
          <AccessBadge visibility={file.visibility} compact />
        </span>
      </div>
      <Menu label={`Actions for ${file.filename}`} items={fileMenuItems(file, props.handlers)} />
    </li>
  );
}

/** Below ~640 px the table becomes a list of cards. */
export function FileCardList(props: FilesViewProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 px-1 text-sm text-muted">
        <SelectAll {...props} />
        Select all on this page
      </label>
      <ul className="flex flex-col gap-2">
        {props.files.map((file) => (
          <CardRow key={file.id} file={file} props={props} />
        ))}
      </ul>
    </div>
  );
}

function GridTile({ file, props }: { file: OwnerFile; props: FilesViewProps }) {
  const { active, bind } = useActive();
  const selected = props.selection.ids.has(file.id);
  return (
    <li
      {...bind}
      className={`group relative flex flex-col overflow-hidden rounded-lg border ${selected ? 'border-gg/70 ring-1 ring-gg/50' : 'border-line'} bg-surface`}
    >
      <button type="button" onClick={() => props.onOpen(file)} className="block" aria-label={`Open ${file.filename}`} tabIndex={-1}>
        <FileThumb file={file} active={active} size="lg" />
      </button>
      <span
        className={`absolute top-2 left-2 rounded bg-black/60 p-1 ${selected ? '' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}
      >
        <RowCheckbox file={file} checked={selected} onToggle={props.onToggle} />
      </span>
      <div className="flex items-start gap-1 p-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <NameCell file={file} props={props} />
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <SafetyBadge safety={file.safety} />
            {formatBytes(file.size)}
            <AccessBadge visibility={file.visibility} compact />
            {file.expires_at !== null && <Expires file={file} now={props.now} />}
          </span>
        </div>
        <Menu label={`Actions for ${file.filename}`} items={fileMenuItems(file, props.handlers)} />
      </div>
    </li>
  );
}

export function FilesGrid(props: FilesViewProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 px-1 text-sm text-muted">
        <SelectAll {...props} />
        Select all on this page
      </label>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {props.files.map((file) => (
          <GridTile key={file.id} file={file} props={props} />
        ))}
      </ul>
    </div>
  );
}
