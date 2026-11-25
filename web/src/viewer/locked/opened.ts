import type { OpenResponse } from '../../lib/api';
import { parseFileData } from '../boot';
import type { FileData } from '../types';

/** A file opened through `/access/open/files/<vanity>`: the payload with signed URLs, and when they stop working. */
export interface OpenedFile {
  file: FileData;
  /** Epoch seconds. */
  expiresAt: number;
}

/** Turns an open response into something to render, or null when it can't be shown. */
export function openedFrom(response: OpenResponse | undefined): OpenedFile | null {
  const file = parseFileData(response?.file);
  const expiresAt = response?.expires_at;
  if (!file || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { file, expiresAt };
}
