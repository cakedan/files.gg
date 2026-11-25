/**
 * Canned responses for report threads (milestone-4 §11.3: a static list; server-side
 * canned responses are a later step). Reporters see them from "files.gg staff".
 */
export const CANNED_RESPONSES: ReadonlyArray<{ label: string; body: string }> = [
  { label: 'Looking into it', body: 'Thanks for the report. We’re looking into it.' },
  { label: 'Need more detail', body: 'Thanks for the report. Can you tell us more about what’s wrong, and where you saw it?' },
  { label: 'Action taken', body: 'Thanks for the report. We’ve taken action.' },
  { label: 'Nothing found', body: 'Thanks for the report. We looked into it and didn’t find anything that breaks our Terms.' },
  { label: 'Duplicate', body: 'Thanks. We’re already handling this in an earlier report.' },
  { label: 'Copyright: need a full notice', body: 'To act on a copyright report we need a complete notice. Send a new report with every field of the copyright form filled in.' },
];

/** What signed-in reporters get when a case closes without a custom message (§9.2). */
export const CLOSE_MESSAGES = {
  actioned: 'Thanks for your report. We’ve taken action.',
  dismissed: 'Thanks for your report. We looked into it and didn’t find anything that breaks our Terms.',
} as const;
