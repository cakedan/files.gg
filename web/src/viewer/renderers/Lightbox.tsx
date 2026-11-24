import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface LightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/** Full-screen image view. Esc, the close button or a click anywhere closes it. */
export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/90 p-2 sm:p-6"
      onClick={onClose}
    >
      <img src={src} alt={alt} className="checkerboard max-h-full max-w-full object-contain" />
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-3 right-3 rounded-full bg-surface/80 p-2 text-text hover:bg-surface-2"
      >
        <X aria-hidden className="size-5" />
      </button>
    </div>,
    document.body,
  );
}
