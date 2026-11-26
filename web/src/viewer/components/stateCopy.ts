import type { FileWarning, RemovedReason, StateTarget } from '../types';

/** Where the removed cards' "Terms" link goes. */
export const TERMS_URL = '/legal/terms';

/** Milestone 7 §11.4: the region card's link, to the Terms' adult-content rules. */
export const ADULT_TERMS_URL = '/legal/terms#adult-content';

/** §11.1's sentences, per public reason. Albums say "album" instead of "file". */
export function removedMessage(kind: StateTarget['kind'], reason: RemovedReason): string {
  switch (reason) {
    case 'review':
      return `This ${kind} is unavailable while it's reviewed.`;
    case 'copyright':
      return `This ${kind} was removed after a copyright notice.`;
    case 'malware':
      return `This ${kind} was removed because it could harm your device.`;
    case 'terms':
      return `This ${kind} was removed for violating the Terms.`;
  }
}

/** §11.1 banner text per `warnings` code. Two codes share one sentence. */
export const WARNING_MESSAGES: Record<FileWarning, string> = {
  unwanted_software: "files.gg's scanner flagged this file as potentially unwanted software.",
  encrypted_archive: "This archive is encrypted and couldn't be scanned. Only download files from people you trust.",
  encrypted_pdf: "This PDF is password-protected and couldn't be scanned. Only download files from people you trust.",
  archive_partially_scanned: 'This file was too large to scan completely.',
  too_large_to_scan: 'This file was too large to scan completely.',
};

/** The banner's lines: one per distinct sentence, in FILE_WARNINGS order. */
export const warningLines = (warnings: readonly FileWarning[] | undefined): string[] => [
  ...new Set((warnings ?? []).map((code) => WARNING_MESSAGES[code])),
];

/** With these, Download asks for confirmation first (§11.1). */
export const confirmDownloadWarning = (warnings: readonly FileWarning[] | undefined): string | null => {
  const code = warnings?.find((w) => w === 'unwanted_software' || w === 'encrypted_archive' || w === 'encrypted_pdf');
  return code ? WARNING_MESSAGES[code] : null;
};

/** "Download all" for an album with any warned item asks first, with that item's message. */
export function albumDownloadWarning(items: readonly { warnings?: readonly FileWarning[] | undefined }[]): string | null {
  for (const item of items) {
    const message = confirmDownloadWarning(item.warnings);
    if (message) return message;
  }
  return null;
}
