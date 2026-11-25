/** Text preview limits (contract §7): over either, "Too large to preview". */
export const MAX_PREVIEW_BYTES = 1024 * 1024;
export const MAX_PREVIEW_LINES = 20_000;
/** Above this, the text shows plain (with line numbers) instead of highlighted, to stay fast. */
export const MAX_HIGHLIGHT_BYTES = 512 * 1024;

/** Known too large from the payload alone, before fetching anything. */
export function tooLargeFromPayload(file: { size: number; media?: { lines?: number | undefined } | undefined }): boolean {
  return file.size > MAX_PREVIEW_BYTES || (file.media?.lines ?? 0) > MAX_PREVIEW_LINES;
}

/** Lines as the viewer shows them: split on `\n` after normalising `\r\n` and `\r`. */
export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A final newline doesn't start another line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export type TextLoad =
  | { status: 'ready'; text: string; lines: string[] }
  /** `lines` is set when the line count is what's over the limit. */
  | { status: 'too-large'; lines?: number };

/**
 * Fetches the text from `cdn_url` as it is (already signed for protected files),
 * enforcing the limits on the `Content-Length`, the bytes and the line count.
 * Throws on network errors and non-2xx responses.
 */
export async function fetchText(url: string, signal?: AbortSignal): Promise<TextLoad> {
  const response = await fetch(url, { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`text: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_PREVIEW_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return { status: 'too-large' };
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PREVIEW_BYTES) return { status: 'too-large' };
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/g, '\n');
  const lines = splitLines(text);
  if (lines.length > MAX_PREVIEW_LINES) return { status: 'too-large', lines: lines.length };
  return { status: 'ready', text, lines };
}
