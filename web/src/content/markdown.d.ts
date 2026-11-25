/** Markdown pages rendered at build time by plugins/markdown.ts (milestone-5 §19.1). */
declare module '*.md?html' {
  /** The page's HTML, without its `# ` title. */
  const html: string;
  export default html;
  /** The `# ` heading. */
  export const title: string;
  /** `YYYY-MM-DD`: the front matter's `updated`, else the newest dated heading. */
  export const updated: string | null;
  /** Every `##` and deeper heading, with its stable id. */
  export const headings: { depth: number; id: string; text: string }[];
  /** `[PLACEHOLDER]` tokens still in the text. */
  export const placeholders: string[];
}

/** `?meta`: the same as `?html`, without the HTML (plugins/markdown.ts). */
declare module '*.md?meta' {
  export const title: string;
  export const updated: string | null;
  export const headings: { depth: number; id: string; text: string }[];
  export const placeholders: string[];
}
