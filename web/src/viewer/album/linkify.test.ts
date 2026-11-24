import { describe, expect, it } from 'vitest';

import { linkify } from './linkify';

describe('linkify', () => {
  it('splits text and http(s) links, trimming sentence punctuation', () => {
    expect(linkify('See https://example.com/a, then go.')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { type: 'text', text: ', then go.' },
    ]);
  });

  it('keeps balanced parentheses in URLs', () => {
    const [, link] = linkify('(https://en.wikipedia.org/wiki/Foo_(bar))');
    expect(link).toMatchObject({ type: 'link', text: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
  });

  it('never links other schemes or HTML', () => {
    expect(linkify('javascript:alert(1) <b>hi</b>')).toEqual([{ type: 'text', text: 'javascript:alert(1) <b>hi</b>' }]);
    expect(linkify('')).toEqual([]);
  });
});
