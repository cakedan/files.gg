/**
 * Shiki, fine-grained: the core, the JavaScript regex engine (no wasm), one theme and
 * only the grammar a file needs. Its own lazy chunk, loaded by the text renderer after
 * the plain text is already on screen.
 */

import type { HighlighterCore, LanguageRegistration } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import { GRAMMARS, type LanguageId } from './languages';
import { filesggDark, THEME_NAME } from './theme';

/** One coloured run of text. */
export interface Token {
  content: string;
  color?: string | undefined;
  /** Shiki's FontStyle bit flags: 1 italic, 2 bold, 4 underline. */
  fontStyle?: number | undefined;
}

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [filesggDark],
    langs: [],
    // `forgiving`: a pattern the JS engine can't translate is skipped, not fatal.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((error: unknown) => {
    highlighter = null;
    throw error;
  });
  return highlighter;
}

/** Tokenises `text` line by line (lines split on `\n`, as the renderer splits them). */
export async function highlightLines(text: string, language: LanguageId): Promise<Token[][]> {
  const core = await getHighlighter();
  if (!core.getLoadedLanguages().includes(language)) {
    const grammar = (await GRAMMARS[language]()).default as LanguageRegistration[];
    await core.loadLanguage(grammar);
  }
  const { tokens } = core.codeToTokens(text, { lang: language, theme: THEME_NAME });
  return tokens.map((line) => line.map(({ content, color, fontStyle }) => ({ content, color, fontStyle })));
}
