import type { FileData } from '../types';

/** "Artist: Title" when both tags exist, else the title alone (contract §7). */
export function tagLine(file: Pick<FileData, 'media'>): string | null {
  const tags = file.media?.tags;
  if (!tags?.title) return null;
  return tags.artist ? `${tags.artist}: ${tags.title}` : tags.title;
}
