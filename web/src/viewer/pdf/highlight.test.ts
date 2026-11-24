import { describe, expect, it } from 'vitest';

import { applyHighlights } from './highlight';
import { findInPage } from './pdfState';

function layer(strings: string[]) {
  const textDivs = strings.map((s) => {
    const span = document.createElement('span');
    span.textContent = s;
    return span;
  });
  return { textDivs, textContentItemsStr: strings };
}

describe('applyHighlights', () => {
  it('wraps matches, marks the selected one, and resets on the next call', () => {
    const l = layer(['Hello world', 'world again']);
    const touched = new Set<number>();
    const matches = findInPage(l.textContentItemsStr.map((str) => ({ str })), 'world');
    const selected = applyHighlights(l, matches, 1, touched);
    expect(l.textDivs[0]!.innerHTML).toBe('Hello <span class="highlight appended">world</span>');
    expect(l.textDivs[1]!.innerHTML).toBe('<span class="highlight appended selected">world</span> again');
    expect(selected?.textContent).toBe('world');

    applyHighlights(l, [], -1, touched);
    expect(l.textDivs[0]!.innerHTML).toBe('Hello world');
    expect(touched.size).toBe(0);
  });

  it('highlights a match that spans two items', () => {
    const l = layer(['brown', 'fox']);
    const matches = findInPage([{ str: 'brown', hasEOL: true }, { str: 'fox' }], 'brown fox');
    applyHighlights(l, matches, 0, new Set());
    expect(l.textDivs[0]!.querySelector('.highlight')?.textContent).toBe('brown');
    expect(l.textDivs[1]!.querySelector('.highlight')?.textContent).toBe('fox');
  });
});
