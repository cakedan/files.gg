import './doc.css';

import { FileWarning, List } from 'lucide-react';
import { useEffect } from 'react';

import { Lockup } from '../../components/Brand';
import { SiteFooter } from '../../components/SiteFooter';
import { formatDocDate, type Doc } from './doc';


/** The `##` sections: folded above the text on phones, beside it on wide screens. */
function Contents({ headings, folded }: { headings: Doc['headings']; folded: boolean }) {
  const sections = headings.filter((heading) => heading.depth === 2);
  if (sections.length < 2) return null;
  const list = (
    <ol className="flex flex-col gap-1.5 text-sm">
      {sections.map((heading) => (
        <li key={heading.id}>
          <a href={`#${heading.id}`} className="text-muted hover:text-text hover:underline">
            {heading.text}
          </a>
        </li>
      ))}
    </ol>
  );
  if (folded) {
    return (
      <nav aria-label="Contents" className="doc-toc mt-5 lg:hidden">
        <details className="rounded-2xl border border-line bg-surface px-4 py-3">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
            <List aria-hidden className="size-4" />
            Contents
          </summary>
          <div className="mt-3">{list}</div>
        </details>
      </nav>
    );
  }
  return (
    <nav aria-label="Contents" className="doc-toc sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto">
      <p className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Contents</p>
      {list}
    </nav>
  );
}

/**
 * The changelog, Terms and Privacy pages (milestone-5 §19.1): public, readable signed out, with
 * contents, heading anchors, the "last updated" date, and a draft banner while placeholders remain.
 * The HTML comes from the repo's own Markdown, rendered at build time (plugins/markdown.ts).
 */
export function DocPage({ doc, onOpen }: { doc: Doc; onOpen?: () => void }) {
  useEffect(() => {
    document.title = `${doc.title} · files.gg`;
    onOpen?.();
    // The text renders after the lazy chunk loads, so the browser's own jump to `#anchor` came too early.
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [doc.title, onOpen]);

  const draft = doc.placeholders.length > 0;
  return (
    <div className="doc-page flex min-h-dvh flex-col bg-bg text-text">
      <header className="doc-header mx-auto flex w-full max-w-6xl items-center px-4 pt-6 sm:px-6">
        <a href="/" aria-label="files.gg home" className="rounded-sm">
          {/* These pages also have a light theme (doc.css), which needs the dark-text lockup. */}
          <picture>
            <source srcSet="/assets/brand/filesgg-lockup-light.svg" media="(prefers-color-scheme: light)" />
            <Lockup className="h-8 w-auto" />
          </picture>
        </a>
      </header>
      <div className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-12">
        <aside className="hidden lg:block">
          <Contents headings={doc.headings} folded={false} />
        </aside>
        <main className="min-w-0 max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight">{doc.title}</h1>
          {doc.updated && (
            <p className="mt-2 text-sm text-muted">
              Last updated <time dateTime={doc.updated}>{formatDocDate(doc.updated)}</time>
            </p>
          )}
          {draft && (
            <div role="note" className="doc-banner mt-5 flex gap-3 rounded-2xl border border-warn/50 bg-warn/10 px-4 py-3 text-sm">
              <FileWarning aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
              <p>
                <strong className="font-semibold">Draft: pending legal review.</strong> Text in{' '}
                <mark className="doc-placeholder">[BRACKETS]</mark> is still to be filled in.
              </p>
            </div>
          )}
          <Contents headings={doc.headings} folded />
          <article className="doc-prose mt-6" dangerouslySetInnerHTML={{ __html: doc.html }} />
        </main>
      </div>
      <SiteFooter className="border-t border-line px-4 py-6" />
    </div>
  );
}
