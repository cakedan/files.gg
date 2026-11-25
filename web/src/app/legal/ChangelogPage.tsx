import html, { headings, placeholders, title, updated } from '../../../../CHANGELOG.md?html';
import { markChangelogSeen } from '../../lib/changelog';
import { DocPage } from './DocPage';

/** `files.gg/changelog` (milestone-5 §19.1, §19.3): `CHANGELOG.md`, newest first. Opening it clears the sidebar's dot. */
export default function ChangelogPage() {
  return <DocPage doc={{ html, title, updated, headings, placeholders }} onOpen={markChangelogSeen} />;
}
