/**
 * Remembers open chunked-upload sessions across reloads, keyed by
 * `name + size + lastModified` (browsers can't keep a File, so the user re-picks it).
 * Only ids and sizes are stored: never passwords or other upload options, which the
 * server already holds on the session.
 */

import type { UploadSession } from '../api';
import { getItem, setItem } from '../storage';

export const RESUME_STORAGE_KEY = 'filesgg.uploads';

export interface ResumableUpload {
  key: string;
  name: string;
  size: number;
  lastModified: number;
  session: UploadSession;
}

export const fileKey = (file: Pick<File, 'name' | 'size' | 'lastModified'>): string =>
  `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

function readAll(): Record<string, ResumableUpload> {
  const raw = getItem(RESUME_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ResumableUpload>) : {};
  } catch {
    return {};
  }
}

function writeAll(entries: Record<string, ResumableUpload>): void {
  setItem(RESUME_STORAGE_KEY, JSON.stringify(entries));
}

/** Open sessions that haven't expired, oldest first. Expired ones are pruned. */
export function listResumable(nowMs: number = Date.now()): ResumableUpload[] {
  const all = readAll();
  const live = Object.values(all).filter((entry) => entry?.session?.expires_at * 1000 > nowMs);
  if (live.length !== Object.keys(all).length) writeAll(Object.fromEntries(live.map((entry) => [entry.key, entry])));
  return live;
}

export function findResumable(file: Pick<File, 'name' | 'size' | 'lastModified'>, nowMs: number = Date.now()): ResumableUpload | null {
  return listResumable(nowMs).find((entry) => entry.key === fileKey(file)) ?? null;
}

export function rememberUpload(file: Pick<File, 'name' | 'size' | 'lastModified'>, session: UploadSession): void {
  const all = readAll();
  const key = fileKey(file);
  all[key] = { key, name: file.name, size: file.size, lastModified: file.lastModified, session };
  writeAll(all);
}

export function forgetUpload(key: string): void {
  const all = readAll();
  if (key in all) {
    delete all[key];
    writeAll(all);
  }
}
