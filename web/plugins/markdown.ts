/**
 * Markdown pages at build time (milestone-5 §19.1): `import html, { title, updated, headings,
 * placeholders } from '…/terms.md?html'`, or the same without the HTML from `?meta`. The changelog,
 * Terms and Privacy Policy are the repo's own files, so no Markdown parser and no sanitiser ship to
 * browsers.
 *
 * - **Front matter** (optional): `---`, `key: value` lines, `---`. `updated` is the page's
 *   "last updated" date; without it, the newest dated heading (`## 2026-11-25: …`) is used.
 * - **The `# ` heading** is the page title. It's taken out of the HTML: the page renders its own header.
 * - **Headings** get stable ids: a dated heading's id is its date (`/changelog#2026-11-25`), any
 *   other's is its text as a slug, without a leading section number (`## 5. Acceptable use` is
 *   `#acceptable-use`), so renumbering sections never breaks a link. Each gets a `#` anchor link.
 * - **Placeholders** (`[OPERATOR]`, `[EU/UK REPRESENTATIVE, if needed]`) are listed in
 *   `placeholders` and highlighted with `<mark class="doc-placeholder">`.
 * - **HTML comments** are reviewers' notes and are left out of the page.
 *
 * §19.6: `vite build` fails while a `strict` file (the Terms and the Privacy Policy) still has a
 * placeholder, unless FILESGG_ALLOW_LEGAL_PLACEHOLDERS is set (e2e builds). The dev server and the
 * test runner never check.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { Marked, type Token, type Tokens } from 'marked';
import type { Plugin } from 'vite';

export interface DocHeading {
  depth: number;
  id: string;
  text: string;
}

export interface MarkdownDoc {
  html: string;
  title: string;
  /** `YYYY-MM-DD`, or null when the page has none. */
  updated: string | null;
  /** Every `##` and deeper heading, in order. */
  headings: DocHeading[];
  /** Placeholder tokens still in the text, each once, in order. */
  placeholders: string[];
}

export const ALLOW_PLACEHOLDERS_ENV = 'FILESGG_ALLOW_LEGAL_PLACEHOLDERS';

/**
 * A `[PLACEHOLDER]`-style token: capitals, digits, spaces, `/` and `-`, optionally followed by a
 * lower-case note after a comma (`[EU/UK REPRESENTATIVE, if needed]`). Never a Markdown link.
 */
export const PLACEHOLDER = /\[[A-Z][A-Z0-9/ -]*[A-Z0-9](?:, [a-z][a-z ]*[a-z])?\](?!\()/g;

const DATE_HEADING = /^(\d{4}-\d{2}-\d{2})\b/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function findPlaceholders(source: string): string[] {
  return [...new Set(source.match(PLACEHOLDER) ?? [])];
}

/** A heading's id: its date when it starts with one, else a slug of its text without a section number. */
export function headingSlug(text: string): string {
  const date = DATE_HEADING.exec(text);
  if (date?.[1]) return date[1];
  return (
    text
      .replace(/^\d+(\.\d+)*\.?\s+/, '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

function frontMatter(source: string): { data: Record<string, string>; body: string } {
  const match = FRONT_MATTER.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+):\s*(.*?)\s*$/.exec(line);
    if (pair?.[1]) data[pair[1]] = pair[2] ?? '';
  }
  return { data, body: source.slice(match[0].length) };
}

/** A heading's visible text, without Markdown. */
function plainText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if ('tokens' in token && Array.isArray(token.tokens) && token.tokens.length > 0) return plainText(token.tokens);
      return 'text' in token && typeof token.text === 'string' ? token.text : '';
    })
    .join('');
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Placeholders in text (never inside a tag) wrapped in `<mark>`, so reviewers can find them. */
function markPlaceholders(html: string): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : part.replace(PLACEHOLDER, (token) => `<mark class="doc-placeholder">${token}</mark>`)))
    .join('');
}

export function renderMarkdown(source: string): MarkdownDoc {
  const { data, body } = frontMatter(source);
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(body);

  let title = '';
  const headings: DocHeading[] = [];
  const ids = new Map<Tokens.Heading, string>();
  const used = new Map<string, number>();
  const kept: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      const text = plainText(heading.tokens).trim();
      if (heading.depth === 1 && !title) {
        title = text;
        continue;
      }
      const base = headingSlug(text);
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen + 1}`;
      ids.set(heading, id);
      headings.push({ depth: heading.depth, id, text });
    }
    kept.push(token);
  }

  marked.use({
    renderer: {
      heading(token) {
        const id = ids.get(token) ?? headingSlug(token.text);
        const inner = this.parser.parseInline(token.tokens);
        const label = escapeAttribute(`Link to this section: ${plainText(token.tokens).trim()}`);
        return `<h${token.depth} id="${id}">${inner}<a class="doc-anchor" href="#${id}" aria-label="${label}">#</a></h${token.depth}>\n`;
      },
    },
  });
  // HTML comments are notes for reviewers (the settings behind the Privacy Policy's numbers): not shipped.
  const html = markPlaceholders(marked.parser(kept).replace(/<!--[\s\S]*?-->/g, ''));
  const dated = headings.map((heading) => DATE_HEADING.exec(heading.text)?.[1]).find(Boolean);
  return {
    html,
    title,
    updated: data.updated || dated || null,
    headings,
    placeholders: findPlaceholders(body),
  };
}

/**
 * The module for `?html`: the HTML as the default export, the rest as named exports. `?meta` has only
 * the named exports, for code that needs a page's date without its text (the changelog dot).
 */
export function markdownModule(doc: MarkdownDoc, { html = true }: { html?: boolean } = {}): string {
  const { html: text, ...named } = doc;
  return [
    ...(html ? [`export default ${JSON.stringify(text)};`] : []),
    ...Object.entries(named).map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`),
  ].join('\n');
}

const truthy = (value: string | undefined) => value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';

/**
 * §19.6: throws when a strict file still has placeholders and FILESGG_ALLOW_LEGAL_PLACEHOLDERS isn't
 * set. Returns the placeholders it allowed (for the build's warning).
 */
export function checkPlaceholders(files: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  const found = files
    .map((file) => ({ file: relative(process.cwd(), file), tokens: findPlaceholders(readFileSync(file, 'utf8')) }))
    .filter((entry) => entry.tokens.length > 0);
  const lines = found.map((entry) => `  ${entry.file}: ${entry.tokens.join(', ')}`);
  if (found.length > 0 && !truthy(env[ALLOW_PLACEHOLDERS_ENV])) {
    throw new Error(
      `The legal pages still have placeholders, so this build would ship a draft:\n${lines.join('\n')}\n` +
        `Fill them in, or set ${ALLOW_PLACEHOLDERS_ENV}=1 for a test build.`,
    );
  }
  return lines;
}

export function markdown({ strict = [] }: { strict?: readonly string[] } = {}): Plugin {
  let command: 'build' | 'serve' = 'serve';
  return {
    name: 'filesgg:markdown',
    enforce: 'pre',
    configResolved(config) {
      command = config.command;
    },
    buildStart() {
      if (command !== 'build') return;
      for (const file of strict) this.addWatchFile(file);
      try {
        const allowed = checkPlaceholders(strict);
        if (allowed.length > 0) this.warn(`legal pages built as drafts (${ALLOW_PLACEHOLDERS_ENV} is set):\n${allowed.join('\n')}`);
      } catch (error) {
        this.error((error as Error).message);
      }
    },
    load(id) {
      // `?html` or `?meta`, which the dev server may turn into `?import&html`.
      const [file = '', query = ''] = id.split('?', 2);
      const params = new URLSearchParams(query);
      if (!file.endsWith('.md') || !(params.has('html') || params.has('meta'))) return null;
      this.addWatchFile(file);
      return markdownModule(renderMarkdown(readFileSync(file, 'utf8')), { html: params.has('html') });
    },
  };
}
