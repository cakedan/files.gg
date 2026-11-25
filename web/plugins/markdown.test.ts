// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';

import { ALLOW_PLACEHOLDERS_ENV, checkPlaceholders, findPlaceholders, headingSlug, markdown, markdownModule, renderMarkdown } from './markdown';

const LEGAL = ['terms.md', 'privacy.md'].map((name) => fileURLToPath(new URL(`../src/content/legal/${name}`, import.meta.url)));

describe('renderMarkdown', () => {
  const doc = renderMarkdown(`---
updated: 2026-11-25
---

# Terms of Service

Intro with [OPERATOR] and a [link](/legal/privacy).

## 1. Who runs files.gg

Text.

## 5. Acceptable use

### Adult **content**

## Acceptable use

<!-- ABUSE_IP_KEEP_DAYS = 30 -->
Kept for 30 days<!-- a setting -->.
`);

  it('takes the title and the date out of the page', () => {
    expect(doc.title).toBe('Terms of Service');
    expect(doc.updated).toBe('2026-11-25');
    expect(doc.html).not.toContain('<h1');
    expect(doc.html).not.toContain('updated:');
  });

  it('gives headings stable ids without section numbers, deduplicated, with anchor links', () => {
    expect(doc.headings).toEqual([
      { depth: 2, id: 'who-runs-files-gg', text: '1. Who runs files.gg' },
      { depth: 2, id: 'acceptable-use', text: '5. Acceptable use' },
      { depth: 3, id: 'adult-content', text: 'Adult content' },
      { depth: 2, id: 'acceptable-use-2', text: 'Acceptable use' },
    ]);
    expect(doc.html).toContain('<h3 id="adult-content">Adult <strong>content</strong><a class="doc-anchor" href="#adult-content" aria-label="Link to this section: Adult content">#</a></h3>');
  });

  it('lists placeholders, highlights them in text only, and drops HTML comments', () => {
    expect(doc.placeholders).toEqual(['[OPERATOR]']);
    expect(doc.html).toContain('<mark class="doc-placeholder">[OPERATOR]</mark>');
    expect(doc.html).toContain('<a href="/legal/privacy">link</a>');
    expect(doc.html).not.toContain('<!--');
    expect(doc.html).toContain('Kept for 30 days.');
  });

  it('a dated heading is its own anchor, and the newest one is the date', () => {
    const changelog = renderMarkdown('# Changelog\n\n## 2026-12-01: Later\n\n- a\n\n## 2026-11-25: The new files.gg\n\n- b\n');
    expect(changelog.headings.map((heading) => heading.id)).toEqual(['2026-12-01', '2026-11-25']);
    expect(changelog.updated).toBe('2026-12-01');
    expect(changelog.placeholders).toEqual([]);
  });

  it('becomes a module with the HTML as its default export', () => {
    const module = markdownModule(renderMarkdown('# T\n\n## A\n'));
    expect(module).toContain('export default "<h2 id=\\"a\\">');
    expect(module).toContain('export const title = "T";');
    expect(module).toContain('export const headings = [{"depth":2,"id":"a","text":"A"}];');
    expect(module).toContain('export const placeholders = [];');
    const meta = markdownModule(renderMarkdown('# T\n\n## A\n'), { html: false });
    expect(meta).not.toContain('export default');
    expect(meta).toContain('export const title = "T";');
  });
});

describe('placeholders (milestone-5 §19.6)', () => {
  it('finds bracketed capitals, notes included, but never links or checkboxes', () => {
    expect(findPlaceholders('[OPERATOR], [OPERATOR ADDRESS], [EU/UK REPRESENTATIVE, if needed] and [OPERATOR] again')).toEqual([
      '[OPERATOR]',
      '[OPERATOR ADDRESS]',
      '[EU/UK REPRESENTATIVE, if needed]',
    ]);
    expect(findPlaceholders('[Terms](/legal/terms), [DMCA](/report), [x], [ ], [a]')).toEqual([]);
  });

  it('slugs', () => {
    expect(headingSlug('12. Ending, changes, law and contact')).toBe('ending-changes-law-and-contact');
    expect(headingSlug('2026-11-25: The new files.gg')).toBe('2026-11-25');
    expect(headingSlug('Café & más')).toBe('cafe-mas');
  });

  describe('checkPlaceholders', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });
    const files = (...texts: string[]) => {
      dir = mkdtempSync(join(tmpdir(), 'filesgg-md-'));
      return texts.map((text, index) => {
        const path = join(dir as string, `${index}.md`);
        writeFileSync(path, text);
        return path;
      });
    };

    it('fails while a file has placeholders, naming them', () => {
      expect(() => checkPlaceholders(files('Run by [OPERATOR].', 'Nothing here.'), {})).toThrow(/0\.md: \[OPERATOR\]/);
      expect(() => checkPlaceholders(files('[CONTACT EMAIL]'), { [ALLOW_PLACEHOLDERS_ENV]: '0' })).toThrow(ALLOW_PLACEHOLDERS_ENV);
    });

    it('passes with FILESGG_ALLOW_LEGAL_PLACEHOLDERS, or without placeholders', () => {
      expect(checkPlaceholders(files('Run by [OPERATOR].'), { [ALLOW_PLACEHOLDERS_ENV]: '1' })).toEqual([expect.stringContaining('[OPERATOR]')]);
      expect(checkPlaceholders(files('Run by files.gg Ltd.'), {})).toEqual([]);
    });
  });

  describe('the plugin', () => {
    type Hooks = {
      configResolved: (config: { command: 'build' | 'serve' }) => void;
      buildStart: (this: unknown) => void;
    };
    const run = (command: 'build' | 'serve', env: string | undefined) => {
      const previous = process.env[ALLOW_PLACEHOLDERS_ENV];
      if (env === undefined) delete process.env[ALLOW_PLACEHOLDERS_ENV];
      else process.env[ALLOW_PLACEHOLDERS_ENV] = env;
      const plugin = markdown({ strict: LEGAL }) as Plugin & Hooks;
      const context = {
        addWatchFile: () => {},
        warn: () => {},
        error: (message: string) => {
          throw new Error(message);
        },
      };
      try {
        plugin.configResolved({ command });
        plugin.buildStart.call(context);
      } finally {
        if (previous === undefined) delete process.env[ALLOW_PLACEHOLDERS_ENV];
        else process.env[ALLOW_PLACEHOLDERS_ENV] = previous;
      }
    };

    it('fails a production build of the draft legal pages without the variable', () => {
      expect(() => run('build', undefined)).toThrow(/legal pages still have placeholders/);
    });

    it('passes the build with the variable, and never checks the dev server or tests', () => {
      expect(() => run('build', '1')).not.toThrow();
      expect(() => run('serve', undefined)).not.toThrow();
    });
  });
});
