/**
 * Report reasons, album parts and the DMCA notice fields (milestone-4 §7.3), shared by
 * the API client (`api.ts`) and the viewer's report form (`reports.ts`). No imports, so
 * anything can use them without pulling in the API client.
 */

export const REPORT_REASONS = [
  'csam',
  'ncii',
  'violence',
  'malware',
  'adult_unmarked',
  'copyright',
  'harassment',
  'spam',
  'other',
  'bug',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const ALBUM_PARTS = ['whole', 'title', 'description', 'captions'] as const;
export type AlbumPart = (typeof ALBUM_PARTS)[number];

/** 17 U.S.C. § 512(c)(3) fields (milestone-4 §7.3). */
export interface DmcaNotice {
  name: string;
  address: string;
  phone: string;
  email: string;
  work: string;
  urls: string[];
  good_faith: boolean;
  accurate_and_authorised: boolean;
  signature: string;
}
