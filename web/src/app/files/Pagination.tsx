import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '../../components/Button';

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-2">
      <Button variant="ghost" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        <ChevronLeft aria-hidden className="size-4" />
        Previous
      </Button>
      <span className="text-sm text-muted" aria-current="page">
        Page {page} of {pages}
      </span>
      <Button variant="ghost" onClick={() => onPage(page + 1)} disabled={page >= pages}>
        Next
        <ChevronRight aria-hidden className="size-4" />
      </Button>
    </nav>
  );
}
