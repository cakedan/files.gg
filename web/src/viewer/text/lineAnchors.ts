/** Line anchors (contract §7): `#L5` and `#L5-L9`, kept with `replaceState`. */

export interface LineRange {
  start: number;
  end: number;
}

/**
 * `#L5`, `#L5-L9` (also `#L5-9`, and a reversed range). A trailing `=` is accepted,
 * since a URLSearchParams round trip (lib/access fragment stripping) adds one.
 */
export function parseLineHash(hash: string): LineRange | null {
  const match = /^#?L(\d+)(?:-L?(\d+))?=?$/i.exec(hash.trim());
  if (!match) return null;
  const a = Number(match[1]);
  const b = match[2] ? Number(match[2]) : a;
  if (!(a >= 1) || !(b >= 1)) return null;
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

export function formatLineHash(range: LineRange): string {
  return range.start === range.end ? `#L${range.start}` : `#L${range.start}-L${range.end}`;
}

/** The range limited to `lineCount`, or null when it starts past the end. */
export function clampRange(range: LineRange | null, lineCount: number): LineRange | null {
  if (!range || range.start > lineCount) return null;
  return { start: range.start, end: Math.min(range.end, lineCount) };
}

/** Click (or shift-click, from `anchor`) on line `line`. */
export function selectLine(line: number, anchor: number | null, extend: boolean): LineRange {
  if (extend && anchor !== null) return { start: Math.min(anchor, line), end: Math.max(anchor, line) };
  return { start: line, end: line };
}
