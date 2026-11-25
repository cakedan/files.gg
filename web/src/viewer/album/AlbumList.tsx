import { createElement, Suspense, type CSSProperties } from 'react';

import { RendererFallback } from '../components/RendererFallback';
import { rendererFor } from '../renderers';
import type { AlbumItem } from '../types';
import { LinkedText } from './LinkedText';

/** Lets each renderer use the full list width; tall images (comics) aren't height-capped. */
const listVars = {
  '--media-max-width': 'min(62.5rem, 100vw - 1.5rem)',
  '--media-max-height': '400vh',
  '--media-min-width': '0px',
  '--pdf-height': 'min(85dvh, 60rem)',
} as CSSProperties;

/** One item per row at full card width, each with its normal viewer renderer. */
export function AlbumList({ items, onOpen }: { items: AlbumItem[]; onOpen: (index: number) => void }) {
  return (
    <ol className="flex flex-col items-center gap-6" style={listVars}>
      {items.map((item, index) => (
        <li key={`${item.vanity ?? item.filename}-${index}`} className="flex w-full max-w-[62.5rem] flex-col gap-2">
          <div className="flex justify-center overflow-hidden rounded-lg border border-line bg-well">
            <Suspense fallback={<RendererFallback file={item} />}>
              {createElement(rendererFor(item), {
                file: item,
                context: 'list',
                onOpen: item.kind === 'image' ? () => onOpen(index) : undefined,
              })}
            </Suspense>
          </div>
          <div className="flex items-baseline justify-between gap-3 px-1 text-sm">
            <p className="min-w-0 break-words">{item.caption ? <LinkedText text={item.caption} /> : <span className="text-muted">{item.filename}</span>}</p>
            <button type="button" onClick={() => onOpen(index)} className="shrink-0 text-xs text-muted hover:text-text">
              {index + 1} / {items.length}
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}
