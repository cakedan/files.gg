import type { FileKind, OwnerFile, Visibility } from '../../lib/api';

export const KIND_LABELS: Record<FileKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  pdf: 'PDF',
  file: 'File',
};

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  link: 'Anyone with the link',
  password: 'Password',
  private: 'Only me',
};

export const SHORT_VISIBILITY_LABELS: Record<Visibility, string> = {
  link: 'Link',
  password: 'Password',
  private: 'Only me',
};

export const typeLabel = (file: Pick<OwnerFile, 'kind' | 'extension'>) =>
  file.kind === 'file' && file.extension ? file.extension.toUpperCase() : KIND_LABELS[file.kind];

/** "3:07" or "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export const pluralize = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
