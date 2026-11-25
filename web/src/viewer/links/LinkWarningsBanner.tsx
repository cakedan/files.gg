import './links.css';

import { ChevronDown, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';

import { CopyButton } from '../../components/CopyButton';
import { WebRiskNotice } from './WebRiskNotice';

const SHOWN = 3;

/**
 * Above a file whose text contains links Web Risk flagged, or in the header of an
 * album whose title, description or captions do (milestone-4 §5.7): which links,
 * that files.gg won't open them, Copy for each, and Google's attribution.
 * A lazy chunk: almost nothing has `link_warnings`.
 */
export default function LinkWarningsBanner({ urls, kind = 'file' }: { urls: readonly string[]; kind?: 'file' | 'album' }) {
  const [all, setAll] = useState(false);
  const id = useId();
  const shown = all ? urls : urls.slice(0, SHOWN);
  const many = urls.length === 1 ? 'a link that' : `${urls.length} links that`;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="viewer-banner flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm"
    >
      <h2 id={`${id}-title`} className="flex items-start gap-2 font-medium text-text">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
        This {kind} contains {many} may be dangerous
      </h2>
      <p className="text-muted">
        {urls.length === 1 ? "It's" : "They're"} suspected of hosting malware, phishing or unwanted software, so files.gg won't open{' '}
        {urls.length === 1 ? 'it' : 'them'}.
      </p>
      <ul className="flex flex-col gap-1" aria-label="Flagged links">
        {shown.map((url) => (
          <li key={url} className="flex items-center gap-2 rounded-md bg-bg/60 py-1 pr-1 pl-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={url}>
              {url}
            </code>
            <CopyButton text={url} variant="ghost" className="h-7 px-2 text-xs" aria-label={`Copy ${url}`} />
          </li>
        ))}
      </ul>
      {urls.length > SHOWN && !all && (
        <button type="button" onClick={() => setAll(true)} className="inline-flex items-center gap-1 self-start text-xs text-gg hover:underline">
          <ChevronDown aria-hidden className="size-3.5" />
          Show all {urls.length}
        </button>
      )}
      <WebRiskNotice />
    </section>
  );
}
