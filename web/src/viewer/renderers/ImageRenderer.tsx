import { useCallback, useState, type CSSProperties } from 'react';

import { GenericRenderer } from './GenericRenderer';
import { Lightbox } from './Lightbox';
import type { RendererProps } from './types';

/**
 * Images: checkerboard behind transparency, sized from width/height before load
 * (Appendix A media-width formula).
 * - card: click opens the full-screen lightbox, Esc closes it;
 * - list (albums): click opens the album carousel via `onOpen`;
 * - lightbox (album carousel): click toggles between fit and actual size.
 * Animated-image decoding and derived previews come in a later milestone.
 */
export function ImageRenderer({ file, context = 'card', onOpen }: RendererProps) {
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (failed) {
    return <GenericRenderer file={file} />;
  }

  const sized = Boolean(file.width && file.height);
  const style = sized ? ({ '--media-w': file.width, '--media-h': file.height } as CSSProperties) : undefined;

  if (context === 'lightbox') {
    return (
      <div
        className={zoomed ? 'max-h-[var(--media-max-height)] max-w-[var(--media-max-width)] overflow-auto' : 'viewer-well bg-transparent'}
        data-no-swipe={zoomed ? '' : undefined}
      >
        <img
          src={file.cdnUrl}
          alt={file.filename}
          width={file.width}
          height={file.height}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          onClick={() => setZoomed(!zoomed)}
          style={zoomed ? { width: file.width ? `${file.width}px` : 'auto', maxWidth: 'none' } : style}
          className={`checkerboard block h-auto ${zoomed ? 'cursor-zoom-out' : `cursor-zoom-in ${sized ? 'viewer-media-sized' : 'viewer-media-free w-auto'}`}`}
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="viewer-well cursor-zoom-in"
        onClick={() => (onOpen ? onOpen() : setOpen(true))}
        aria-label={`Open ${file.filename} full screen`}
      >
        <img
          src={file.cdnUrl}
          alt={file.filename}
          width={file.width}
          height={file.height}
          decoding="async"
          loading={context === 'list' ? 'lazy' : undefined}
          draggable={false}
          onError={() => setFailed(true)}
          style={style}
          className={sized ? 'viewer-media-sized checkerboard block h-auto' : 'viewer-media-free checkerboard block h-auto w-auto'}
        />
      </button>
      {open && <Lightbox src={file.cdnUrl} alt={file.filename} onClose={close} />}
    </>
  );
}
