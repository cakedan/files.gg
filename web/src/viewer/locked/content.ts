import type { AccessKind, UnlockResponse, ViewResponse } from '../../lib/api';
import { parseAlbumData, parseFileData } from '../boot';
import type { AlbumData, FileData } from '../types';

export type Content = { kind: 'file'; file: FileData } | { kind: 'album'; album: AlbumData };

/** Turns an unlock or view response into viewer content, or null when it can't be shown. */
export function contentFrom(kind: AccessKind, response: UnlockResponse | ViewResponse): Content | null {
  if (kind === 'album') {
    const album = parseAlbumData(response.album);
    return album ? { kind: 'album', album } : null;
  }
  const file = parseFileData(response.file);
  return file ? { kind: 'file', file } : null;
}

