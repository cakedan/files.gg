import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

/** The narrowest a visitor can make the card, and how far one arrow-key press moves it. */
const MIN_WIDTH = 280;
const KEY_STEP = 40;

/** As wide as `--media-max-width` allows (90% of the window, less the page's gutters). */
function maxWidth() {
  return Math.max(MIN_WIDTH, Math.min(window.innerWidth * 0.9, window.innerWidth - 24));
}

function clamp(width: number) {
  return Math.round(Math.min(Math.max(width, Math.min(MIN_WIDTH, maxWidth())), maxWidth()));
}

/**
 * The bottom-right corner grip that resizes an image, video or audio card, as the old files.gg viewer had.
 * Dragging sets the card's width (the media fills it, still within the window's height); the card is
 * centred, so the width grows by twice the pointer's movement to keep the corner under it. Arrow keys
 * resize too, and a double click or Escape goes back to the media's own size. Shown only with a mouse
 * or trackpad (`viewer-grip` in viewer.css), like the old one, which was off on phones.
 */
export function ResizeGrip({ card, onResize }: { card: RefObject<HTMLElement | null>; onResize: (width: number | null) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);

  const currentWidth = () => card.current?.getBoundingClientRect().width ?? MIN_WIDTH;

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: currentWidth() };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    onResize(clamp(drag.current.width + 2 * (event.clientX - drag.current.x)));
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? KEY_STEP : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -KEY_STEP : 0;
    if (step) {
      event.preventDefault();
      onResize(clamp(currentWidth() + step));
    } else if (event.key === 'Escape' || event.key === 'Home') {
      event.preventDefault();
      onResize(null);
    }
  };

  return (
    <button
      type="button"
      className="viewer-grip"
      aria-label="Resize. Drag, or use the arrow keys. Double-click or Escape to reset."
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onResize(null)}
      onKeyDown={onKeyDown}
    >
      <svg aria-hidden viewBox="0 0 12 12" className="size-3">
        <path d="M11 3 3 11M11 7 7 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    </button>
  );
}
