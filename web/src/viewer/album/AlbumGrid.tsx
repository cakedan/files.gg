import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { AlbumItem } from '../types';
import { AlbumTile } from './AlbumTile';
import { itemAspect, justifyRows, targetRowHeight } from './layout';

const GAP = 8;

/** Justified rows of tiles at each item's aspect ratio, captions under the items. */
export function AlbumGrid({ items, onOpen }: { items: AlbumItem[]; onOpen: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(
    () =>
      justifyRows(items.map(itemAspect), {
        containerWidth: width,
        targetHeight: targetRowHeight(width),
        gap: GAP,
      }),
    [items, width],
  );

  return (
    <div ref={ref} className="flex w-full flex-col" style={{ gap: GAP * 1.5 }}>
      {rows.map((row, r) => (
        <ul key={r} className="flex items-start" style={{ gap: GAP }}>
          {row.tiles.map((tile) => {
            const item = items[tile.index]!;
            return (
              <li key={tile.index} className="flex shrink-0 flex-col gap-1" style={{ width: tile.width }}>
                <AlbumTile
                  item={item}
                  index={tile.index}
                  count={items.length}
                  width={tile.width}
                  height={tile.height}
                  onOpen={onOpen}
                />
                {item.caption && <p className="line-clamp-2 text-xs break-words text-muted">{item.caption}</p>}
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}
