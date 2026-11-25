import type { Report } from '../../lib/api';

const ALBUM_PARTS = { whole: '', title: ' (title)', description: ' (description)', captions: ' (captions)' } as const;

/** What was reported, without the uploader or filename (§7.5). */
export function reportTargetLabel(report: Pick<Report, 'target'>): string {
  const { target } = report;
  switch (target.type) {
    case 'file':
      return target.url ? target.url.replace(/^https?:\/\//, '') : `files.gg/${target.vanity ?? ''}`;
    case 'album':
      return `${target.url ? target.url.replace(/^https?:\/\//, '') : `files.gg/a/${target.vanity ?? ''}`}${target.part ? ALBUM_PARTS[target.part] : ''}`;
    case 'user':
      return 'An account';
    default:
      return 'Bug report';
  }
}
