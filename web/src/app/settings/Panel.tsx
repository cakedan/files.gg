import type { ReactNode } from 'react';

/** A settings section: a heading, an optional description, its controls. */
export function Panel({ title, description, children, id, tone }: { title: string; description?: ReactNode; children: ReactNode; id?: string; tone?: 'danger' }) {
  const headingId = id ?? `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={headingId} className={`flex flex-col gap-4 rounded-lg border bg-surface p-4 sm:p-5 ${tone === 'danger' ? 'border-danger/40' : 'border-line'}`}>
      <header className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        {description && <div className="text-sm text-muted">{description}</div>}
      </header>
      {children}
    </section>
  );
}

/** A one-line result under a control. */
export function Result({ error, success }: { error?: string | null | undefined; success?: string | null | undefined }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p role="status" className="text-sm text-gg">
        {success}
      </p>
    );
  }
  return null;
}

/** The reason a locked control can't be used (suspension, §11.1). */
export function LockedNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-muted">{children}</p>;
}
