import type { Domain, DomainStatus } from '../../lib/accountApi';
import { epochMs, formatRelative } from '../../lib/time';

/** §13.4 status words: "Waiting for DNS" → "Issuing certificate" → "Active". */
export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  pending_dns: 'Waiting for DNS',
  pending_cert: 'Issuing certificate',
  active: 'Active',
  failing: 'Failing',
  failed: 'Failed',
  paused: 'Paused',
  disabled: 'Disabled by files.gg',
};

/** What's going on, in a sentence, for each status and reason (§10.3). */
export function domainStatusText(domain: Domain, now = Date.now()): string {
  switch (domain.status) {
    case 'pending_dns':
      return 'Add both records below. We check them automatically; it usually takes a few minutes, and can take up to an hour.';
    case 'pending_cert':
      return 'Your records are right. Cloudflare is issuing the certificate.';
    case 'active':
      return domain.serving ? 'Serving your files.' : 'Active, but not serving right now.';
    case 'failing':
      return `A check has been failing${domain.failing_since ? ` since ${formatRelative(epochMs(domain.failing_since), now)}` : ''}. Your links still work; fix the records within 3 days or the domain stops.`;
    case 'failed':
      return domain.status_reason === 'dns_timeout'
        ? 'We didn’t see the records within 72 hours, so we stopped. Fix them and retry.'
        : domain.status_reason === 'dns_changed'
          ? 'The records stopped pointing at files.gg for 3 days, so we stopped. Fix them and retry.'
          : domain.status_reason === 'premium_ended'
            ? 'Premium ended more than 30 days ago, so the domain was removed from Cloudflare.'
            : 'We gave up on this domain. Fix the records and retry.';
    case 'paused':
      return 'Paused because premium ended. It comes back when premium does.';
    case 'disabled':
      return 'files.gg staff disabled this domain, so it can’t be used or removed.';
  }
}

const count = (n: number, noun: string) => `${n.toLocaleString('en')} ${noun}${n === 1 ? '' : 's'}`;

/** §10.6: "142 files have files.gg links that will stop working, including links already shared in Discord". */
export function domainOnlyWarning(files: number, albums: number): string {
  const subject = albums > 0 ? `${count(files, 'file')} and ${count(albums, 'album')}` : count(files, 'file');
  const verb = files + albums === 1 ? 'has a files.gg link' : 'have files.gg links';
  return `${subject} ${verb} that will stop working, including links already shared in Discord.`;
}

