import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { FlaggedLinkDialog } from '../links/FlaggedLinkDialog';
import { isFlaggedLink, useLinkWarnings } from '../links/webRisk';
import { linkify } from './linkify';

const FLAGGED_LABEL = 'This link may be dangerous';

/** A flagged URL: plain text plus a warning icon that opens the Copy-only interstitial. */
function FlaggedUrl({ text, href, interactive }: { text: string; href: string; interactive: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="text-danger" data-flagged-link="">
      {text}
      {interactive ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setOpen(true);
          }}
          aria-label={FLAGGED_LABEL}
          title={FLAGGED_LABEL}
          className="ml-0.5 inline-flex rounded align-[-0.15em] hover:bg-danger/15"
        >
          <ShieldAlert aria-hidden className="size-[1.1em]" />
        </button>
      ) : (
        <ShieldAlert role="img" aria-label={FLAGGED_LABEL} className="ml-0.5 inline size-[1.1em] align-[-0.15em]" />
      )}
      {open && <FlaggedLinkDialog url={href} onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * Album text (description, captions) with its URLs: flagged ones (milestone-4 §11.1)
 * are never links, only text with a warning icon. Other URLs become links when
 * `links` is set (the description), and stay text otherwise (captions).
 * `interactive: false` is for text inside another control (the tracklist rows).
 */
export function LinkedText({ text, links = false, interactive = true }: { text: string; links?: boolean; interactive?: boolean }) {
  const flagged = useLinkWarnings();
  if (!links && flagged.length === 0) return <>{text}</>;
  return (
    <>
      {linkify(text).map((segment, index) => {
        if (segment.type === 'text') return <span key={index}>{segment.text}</span>;
        if (isFlaggedLink(segment.href, flagged)) {
          return <FlaggedUrl key={index} text={segment.text} href={segment.href} interactive={interactive} />;
        }
        if (!links) return <span key={index}>{segment.text}</span>;
        return (
          <a key={index} href={segment.href} target="_blank" rel="nofollow ugc noopener" className="text-gg underline-offset-2 hover:underline">
            {segment.text}
          </a>
        );
      })}
    </>
  );
}
