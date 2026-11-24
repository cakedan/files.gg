import type { PageMatch } from './pdfState';

interface TextLayerLike {
  readonly textDivs: HTMLElement[];
  readonly textContentItemsStr: string[];
}

interface Segment {
  start: number;
  end: number;
  selected: boolean;
}

/**
 * Wraps search matches inside the text layer's spans in `<span class="highlight">`,
 * the way pdf.js's TextHighlighter does. Resets previously highlighted spans first.
 * Returns the selected highlight element, if it is on this page.
 */
export function applyHighlights(
  layer: TextLayerLike,
  matches: readonly PageMatch[],
  selected: number,
  touched: Set<number>,
): HTMLElement | null {
  const { textDivs, textContentItemsStr } = layer;
  for (const index of touched) {
    const div = textDivs[index];
    if (div) div.textContent = textContentItemsStr[index] ?? '';
  }
  touched.clear();

  const segments = new Map<number, Segment[]>();
  matches.forEach((match, matchIndex) => {
    const lastItem = match.end.offset === 0 && match.end.item > match.begin.item ? match.end.item - 1 : match.end.item;
    for (let item = match.begin.item; item <= lastItem; item++) {
      const text = textContentItemsStr[item] ?? '';
      const start = item === match.begin.item ? match.begin.offset : 0;
      const end = item === match.end.item ? match.end.offset : text.length;
      if (end <= start) continue;
      const list = segments.get(item) ?? [];
      list.push({ start, end, selected: matchIndex === selected });
      segments.set(item, list);
    }
  });

  let selectedElement: HTMLElement | null = null;
  for (const [item, list] of segments) {
    const div = textDivs[item];
    const text = textContentItemsStr[item];
    if (!div || text === undefined) continue;
    touched.add(item);
    list.sort((a, b) => a.start - b.start);
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const segment of list) {
      if (segment.start < cursor) continue;
      if (segment.start > cursor) fragment.append(text.slice(cursor, segment.start));
      const mark = document.createElement('span');
      mark.className = segment.selected ? 'highlight appended selected' : 'highlight appended';
      mark.textContent = text.slice(segment.start, segment.end);
      fragment.append(mark);
      if (segment.selected && !selectedElement) selectedElement = mark;
      cursor = segment.end;
    }
    if (cursor < text.length) fragment.append(text.slice(cursor));
    div.replaceChildren(fragment);
  }
  return selectedElement;
}
