import html, { headings, placeholders, title, updated } from '../../content/help/link-warnings.md?html';
import { DocPage } from './DocPage';

/**
 * `files.gg/help/link-warnings` (milestone-7 §7): what each Web Risk threat type means and what to do,
 * one section per type. The viewer's link warnings link to its anchors (`viewer/links/webRisk.ts`).
 */
export default function LinkWarningsPage() {
  return <DocPage doc={{ html, title, updated, headings, placeholders }} />;
}
