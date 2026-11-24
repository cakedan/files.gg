import { useEffect } from 'react';

interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  useEffect(() => {
    document.title = `${title} · files.gg`;
  }, [title]);

  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted">{description}</p>
      <p className="mt-4 rounded-lg border border-dashed border-line bg-surface px-4 py-6 text-sm text-muted">
        This section is coming in a later milestone.
      </p>
    </section>
  );
}
