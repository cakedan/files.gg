import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  /** Shown under the label, and as its tooltip: why a disabled item can't be used. */
  hint?: string;
}

interface MenuProps {
  /** Accessible name of the trigger, for example "Actions for cat.png". */
  label: string;
  items: MenuItem[];
  className?: string;
}

/**
 * An actions menu (WAI-ARIA menu button): ↑/↓, Home/End, Esc, and Tab closes it.
 * The list is portalled with fixed positioning, so scrolling tables don't clip it.
 */
export function Menu({ label, items, className = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const visible = items.filter((item) => !item.hidden);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const height = list.current?.offsetHeight ?? 0;
    setStyle({
      position: 'fixed',
      right: Math.max(8, window.innerWidth - rect.right),
      ...(below < height + 16 && rect.top > below ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const nodes = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => nodes[(to + nodes.length) % nodes.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(nodes.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text ${className}`}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            onClick={(event) => event.stopPropagation()}
            style={style}
            className="z-[55] flex min-w-48 flex-col rounded-lg border border-line bg-surface-2 p-1 shadow-card"
          >
            {visible.map(({ label: itemLabel, icon: Icon, onSelect, danger, disabled, hint }) => (
              <button
                key={itemLabel}
                type="button"
                role="menuitem"
                disabled={disabled}
                title={hint}
                tabIndex={-1}
                onClick={() => {
                  // Focus goes back to the trigger first, so a dialog opened here returns it there.
                  close();
                  onSelect();
                }}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-line focus-visible:bg-line focus-visible:outline-none disabled:opacity-50 ${
                  danger ? 'text-danger' : 'text-text'
                }`}
              >
                {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
                {hint ? (
                  <span className="flex flex-col">
                    {itemLabel}
                    <span className="text-xs text-muted">{hint}</span>
                  </span>
                ) : (
                  itemLabel
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
