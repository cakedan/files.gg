/**
 * "Download all" (contract §3): the Worker streams a ZIP from the payload's
 * `download_url` (used as it is, signed for a protected album), but over 2 GiB it answers
 * `413 ZIP_TOO_LARGE` with a JSON body, which a plain link would save as the download.
 * So the page checks first and offers per-item downloads instead.
 */

/** The Worker's cap on the visible items' total size. */
export const ZIP_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export type ZipCheck = 'ok' | 'too-large';

/**
 * `HEAD` the ZIP URL. Only a `413` means too large; anything else (including a
 * network or CORS failure) lets the normal download go ahead.
 */
export async function checkZip(url: string, totalSize: number, fetchImpl: typeof fetch = fetch): Promise<ZipCheck> {
  if (totalSize > ZIP_LIMIT_BYTES) return 'too-large';
  try {
    const response = await fetchImpl(url, { method: 'HEAD', credentials: 'omit', cache: 'no-store' });
    return response.status === 413 ? 'too-large' : 'ok';
  } catch {
    return 'ok';
  }
}

/** Navigation, behind an object so tests can replace it. */
export const browser = {
  download(url: string) {
    window.location.assign(url);
  },
};
