import './text.css';

import { Check, Copy, Download, ExternalLink, FileWarning, RefreshCw, WrapText, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';

import { Button, LinkButton } from '../../components/Button';
import { useCopyState } from '../../components/useCopyState';
import { formatBytes } from '../../lib/format';
import type { RendererProps } from '../renderers/types';
import type { FileData } from '../types';
import { downloadUrl } from '../urls';
import type { Token } from './highlight';
import { LANGUAGE_NAMES, resolveLanguage } from './languages';
import { clampRange, formatLineHash, parseLineHash, selectLine, type LineRange } from './lineAnchors';
import { fetchText, MAX_HIGHLIGHT_BYTES, MAX_PREVIEW_BYTES, MAX_PREVIEW_LINES, tooLargeFromPayload } from './limits';

type Load =
  | { status: 'too-large'; lines?: number }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; text: string; lines: string[] };

const frame = 'flex w-[min(75rem,var(--media-max-width))] flex-col bg-well';

function Fallback({ file, title, detail, onRetry }: { file: FileData; title: string; detail: string; onRetry?: () => void }) {
  return (
    <div className={`${frame} items-center gap-3 px-6 py-10 text-center`}>
      <FileWarning aria-hidden className="size-10 text-muted" />
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold">{title}</p>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {onRetry && (
          <Button onClick={onRetry}>
            <RefreshCw aria-hidden className="size-4" />
            Retry
          </Button>
        )}
        <LinkButton href={downloadUrl(file.cdn_url)} download={file.filename}>
          <Download aria-hidden className="size-4" />
          Download
        </LinkButton>
        <LinkButton href={file.cdn_url} target="_blank" rel="noopener noreferrer">
          <ExternalLink aria-hidden className="size-4" />
          Raw
        </LinkButton>
      </div>
    </div>
  );
}

const fontStyle = (flags: number | undefined): CSSProperties | undefined => {
  if (!flags) return undefined;
  return {
    fontStyle: flags & 1 ? 'italic' : undefined,
    fontWeight: flags & 2 ? 600 : undefined,
    textDecoration: flags & 4 ? 'underline' : undefined,
  };
};

const Line = memo(function Line({
  n,
  text,
  tokens,
  selected,
  withId,
}: {
  n: number;
  text: string;
  tokens: Token[] | undefined;
  selected: boolean;
  withId: boolean;
}) {
  return (
    <div className="text-line" data-line-row={n} data-selected={selected ? '' : undefined} id={withId ? `L${n}` : undefined}>
      <a href={`#L${n}`} data-line={n} tabIndex={-1} className="text-ln" aria-label={`Line ${n}`}>
        {n}
      </a>
      <span className="text-code">
        {tokens
          ? tokens.map((token, i) => (
              <span key={i} style={{ color: token.color, ...fontStyle(token.fontStyle) }}>
                {token.content}
              </span>
            ))
          : text}
      </span>
    </div>
  );
});

/**
 * Read-only text and code viewer (contract §7): Shiki highlighting, line numbers,
 * `#L5` / `#L5-L9` anchors (click and shift-click the numbers), wrap toggle and Copy. Over 1 MiB or 20,000 lines it shows "Too large to preview".
 */
export default function TextRenderer({ file, context = 'card' }: RendererProps) {
  const card = context === 'card';
  const tooLarge = tooLargeFromPayload(file);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>(tooLarge ? { status: 'too-large' } : { status: 'loading' });
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const [wrap, setWrap] = useState(false);
  const [selection, setSelection] = useState<LineRange | null>(() => (card ? parseLineHash(window.location.hash) : null));
  const anchor = useRef<number | null>(selection?.start ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState(0);
  const language = resolveLanguage(file);
  const { state: copyState, copy } = useCopyState();

  // Fetch the text, then highlight it in a second, lazy step.
  useEffect(() => {
    if (tooLarge) return;
    const controller = new AbortController();
    fetchText(file.cdn_url, controller.signal).then(
      (result) => {
        setLoad(result);
        if (result.status !== 'ready') return;
        setScrollTo((n) => n + 1);
        if (!language || result.text.length > MAX_HIGHLIGHT_BYTES) return;
        import('./highlight')
          .then(({ highlightLines }) => highlightLines(result.text, language))
          .then((lines) => {
            if (!controller.signal.aborted) setTokens(lines);
          })
          .catch(() => undefined); // Stays plain text.
      },
      () => {
        if (!controller.signal.aborted) setLoad({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, [file.cdn_url, tooLarge, language, attempt]);

  // Editing the hash by hand (or Back/Forward) moves the selection.
  useEffect(() => {
    if (!card) return;
    const onHash = () => {
      const range = parseLineHash(window.location.hash);
      if (!range) return;
      setSelection(range);
      anchor.current = range.start;
      setScrollTo((n) => n + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [card]);

  const lineCount = load.status === 'ready' ? load.lines.length : 0;
  const shown = clampRange(selection, lineCount);

  // Centre the selection once the text is in, and after hash changes.
  useEffect(() => {
    if (!scrollTo || !shown) return;
    const row = scrollRef.current?.querySelector(`[data-line-row="${shown.start}"]`);
    row?.scrollIntoView?.({ block: 'center' });
    // Only when asked: clicking a line shouldn't scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo]);

  const onGutterClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const link = (event.target as Element).closest?.('a[data-line]');
      if (!link) return;
      event.preventDefault();
      const n = Number(link.getAttribute('data-line'));
      const range = selectLine(n, anchor.current, event.shiftKey);
      if (!event.shiftKey) anchor.current = n;
      setSelection(range);
      if (card) {
        const { pathname, search } = window.location;
        window.history.replaceState(window.history.state, '', `${pathname}${search}${formatLineHash(range)}`);
      }
    },
    [card],
  );

  const rows = useMemo(() => {
    if (load.status !== 'ready') return null;
    return load.lines.map((text, i) => {
      const n = i + 1;
      const selected = shown !== null && n >= shown.start && n <= shown.end;
      return <Line key={n} n={n} text={text} tokens={tokens?.[i]} selected={selected} withId={card} />;
    });
  }, [load, tokens, shown, card]);

  if (load.status === 'too-large') {
    const knownLines = load.lines ?? file.media?.lines;
    return (
      <Fallback
        file={file}
        title="Too large to preview"
        detail={`Previews are limited to ${formatBytes(MAX_PREVIEW_BYTES)} and ${MAX_PREVIEW_LINES.toLocaleString('en-US')} lines. This file is ${formatBytes(file.size)}${
          knownLines ? ` with ${knownLines.toLocaleString('en-US')} lines` : ''
        }.`}
      />
    );
  }
  if (load.status === 'error') {
    return (
      <Fallback
        file={file}
        title="Couldn't load this file"
        detail="The preview didn't load. Try again, or download the file."
        onRetry={() => {
          setLoad({ status: 'loading' });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  const label = language ? LANGUAGE_NAMES[language] : 'Plain text';
  const gutter = { '--gutter': `${Math.max(2, String(lineCount).length) + 1}ch` } as CSSProperties;

  return (
    <div className={`${frame} max-h-[var(--media-max-height)] min-h-48`} data-testid="text-viewer">
      <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1.5 text-xs text-muted">
        <span className="font-medium text-text">{label}</span>
        {load.status === 'ready' && (
          <span>
            {lineCount.toLocaleString('en-US')} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setWrap(!wrap)}
          aria-pressed={wrap}
          className={`inline-flex h-7 items-center gap-1.5 rounded px-2 hover:bg-surface-2 hover:text-text ${wrap ? 'text-gg' : ''}`}
        >
          <WrapText aria-hidden className="size-4" />
          Wrap
        </button>
        <button
          type="button"
          disabled={load.status !== 'ready'}
          onClick={() => load.status === 'ready' && void copy(load.text)}
          className="inline-flex h-7 items-center gap-1.5 rounded px-2 hover:bg-surface-2 hover:text-text disabled:opacity-50"
        >
          {copyState === 'copied' ? (
            <Check aria-hidden className="size-4 text-gg" />
          ) : copyState === 'failed' ? (
            <X aria-hidden className="size-4 text-danger" />
          ) : (
            <Copy aria-hidden className="size-4" />
          )}
          <span aria-live="polite">{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? "Couldn't copy" : 'Copy'}</span>
        </button>
      </div>
      <div
        ref={scrollRef}
        className={`text-scroll min-h-0 flex-1 overflow-auto ${wrap ? 'text-wrap-on' : ''}`}
        style={gutter}
        onClick={onGutterClick}
        onMouseDown={(event) => {
          // Shift-click on a number extends the line range, not the text selection.
          if (event.shiftKey && (event.target as Element).closest?.('a[data-line]')) event.preventDefault();
        }}
        tabIndex={0}
        role="region"
        aria-label={file.filename}
        aria-busy={load.status === 'loading'}
        data-own-keys=""
        data-no-swipe=""
      >
        {load.status === 'loading' ? (
          <p className="px-4 py-6 text-sm text-muted">Loading…</p>
        ) : (
          <div className="text-lines font-mono">
            {rows}
          </div>
        )}
      </div>
    </div>
  );
}
