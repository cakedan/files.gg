export type TextSegment = { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
/** Punctuation that usually ends a sentence rather than belonging to the URL. */
const TRAILING = /[.,;:!?)\]}'"]$/;

/**
 * Splits plain user text into text and http(s) link segments. Nothing is parsed
 * as HTML: callers render text segments as text, and links with
 * rel="nofollow ugc noopener" (PLAN.md "Albums: Trust & safety").
 */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    // Trim trailing punctuation one character at a time, keeping a ')' that closes
    // a '(' inside the URL (Wikipedia style).
    while (TRAILING.test(url)) {
      const last = url.at(-1);
      if (last === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
      url = url.slice(0, -1);
    }
    const start = match.index;
    if (start > last) segments.push({ type: 'text', text: text.slice(last, start) });
    let href: string | null;
    try {
      href = new URL(url).href;
    } catch {
      href = null;
    }
    segments.push(href ? { type: 'link', text: url, href } : { type: 'text', text: url });
    last = start + url.length;
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) });
  return segments;
}
