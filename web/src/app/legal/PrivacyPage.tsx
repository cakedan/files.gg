import html, { headings, placeholders, title, updated } from '../../content/legal/privacy.md?html';
import { DocPage } from './DocPage';

/** `files.gg/legal/privacy` (milestone-5 §19.1, §19.5). */
export default function PrivacyPage() {
  return <DocPage doc={{ html, title, updated, headings, placeholders }} />;
}
