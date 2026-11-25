import type { ApiError, MyLimitsResponse } from '../api';
import { localError } from './errors';
import { CHUNKED_THRESHOLD } from './uploadTask';

/**
 * Checks a file against `/users/@me/limits` before uploading, so a too-big file
 * fails at once instead of after a long upload. `pendingBytes` is what's already
 * queued in this batch (it counts toward storage too).
 */
export function checkLimits(size: number, limits: MyLimitsResponse | null | undefined, pendingBytes = 0): ApiError | null {
  if (!limits) return null;
  const max = size > CHUNKED_THRESHOLD ? limits.max_file_size_chunked : limits.max_file_size_single;
  if (size > max) return localError('FILE_TOO_LARGE', { limit: max });
  const { used, limit } = limits.storage;
  if (limit !== null && used + pendingBytes + size > limit) {
    return localError('STORAGE_LIMIT_REACHED', { limit, used: used + pendingBytes });
  }
  return null;
}
