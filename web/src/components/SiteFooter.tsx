/**
 * The site footer (milestone-5 §19.2): Changelog · Terms · Privacy · Report abuse · Contact, on
 * the home page, the public pages, the auth pages and the bottom of the dashboard sidebar. Plain
 * links, since these pages live outside the dashboard's router (and outside the viewer).
 */

export const CHANGELOG_PATH = '/changelog';
export const TERMS_PATH = '/legal/terms';
export const PRIVACY_PATH = '/legal/privacy';
export const REPORT_PATH = '/report';
/** support@ is routed to staff (PLAN.md §4 item 14). */
export const CONTACT_HREF = 'mailto:support@files.gg';

export function SiteFooter({ changelogDot = false, className = '' }: { changelogDot?: boolean; className?: string }) {
  const links = [
    { href: CHANGELOG_PATH, label: 'Changelog', dot: changelogDot },
    { href: TERMS_PATH, label: 'Terms' },
    { href: PRIVACY_PATH, label: 'Privacy' },
    { href: REPORT_PATH, label: 'Report abuse' },
    { href: CONTACT_HREF, label: 'Contact' },
  ];
  return (
    <footer className={`site-footer text-xs text-muted ${className}`}>
      {/* Plain links between separators. */}
      <nav aria-label="files.gg" className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
        {links.map(({ href, label, dot }, index) => (
          <span key={href} className="flex items-center gap-1">
            {index > 0 && (
              <span aria-hidden className="opacity-50">
                ·
              </span>
            )}
            <a href={href} className="inline-flex items-center gap-1 rounded-sm px-0.5 hover:text-text hover:underline">
              {label}
              {dot && (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-gg" data-testid="changelog-dot" />
                  <span className="sr-only"> (new)</span>
                </>
              )}
            </a>
          </span>
        ))}
      </nav>
    </footer>
  );
}
