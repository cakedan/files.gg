/** A page rendered from Markdown at build time (plugins/markdown.ts, milestone-5 §19.1). */
export interface Doc {
  html: string;
  title: string;
  updated: string | null;
  headings: { depth: number; id: string; text: string }[];
  placeholders: string[];
}

/** `2026-11-25` as "November 25, 2026", in UTC so the date never shifts. */
export function formatDocDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });
}
