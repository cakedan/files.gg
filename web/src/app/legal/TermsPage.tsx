import html, { headings, placeholders, title, updated } from '../../content/legal/terms.md?html';
import { DocPage } from './DocPage';

/** `files.gg/legal/terms` (milestone-5 §19.1, §19.4). */
export default function TermsPage() {
  return <DocPage doc={{ html, title, updated, headings, placeholders }} />;
}
