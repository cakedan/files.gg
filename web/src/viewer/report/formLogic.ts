/**
 * The report form's pure logic (milestone-4 §7.3): which reasons apply, what's
 * required, client-side checks, and the request body. The API checks everything
 * again; these only catch mistakes before a Turnstile token is spent.
 */

import type { AlbumPart, DmcaNotice, ReportReason, ReportRequest, ReportTargetBody } from '../../lib/reports';
import { hostContext } from '../host/context';
import type { ReportPageTarget } from '../types';

/** lib/reports' targets plus milestone-6 §10.12's custom domain target. */
export type ViewerReportTarget = ReportTargetBody | { type: 'domain'; hostname: string };
export type ViewerReportRequest = Omit<ReportRequest, 'target'> & { target: ViewerReportTarget };

export const REASON_LABELS: Record<ReportReason, string> = {
  csam: 'Child sexual abuse material',
  ncii: 'Intimate images shared without consent',
  violence: 'Violence, terrorism or credible threats',
  malware: 'Malware or phishing',
  adult_unmarked: 'Adult content not marked as sensitive',
  copyright: 'Copyright (DMCA)',
  harassment: 'Harassment or private information',
  spam: 'Spam',
  other: 'Something else',
  bug: 'A problem with files.gg',
};

/** §7.3 "Applies to": file and album targets take the same reasons; `bug` is bug-only. */
export const CONTENT_REASONS: readonly ReportReason[] = [
  'csam',
  'ncii',
  'violence',
  'malware',
  'adult_unmarked',
  'copyright',
  'harassment',
  'spam',
  'other',
];

export const PART_LABELS: Record<AlbumPart, string> = {
  whole: 'The whole album',
  title: 'Its title',
  description: 'Its description',
  captions: 'Its captions',
};

export const DETAILS_MAX = 2000;
export const EMAIL_MAX = 254;
export const DMCA_URLS_MAX = 50;

/** §7.3: `details` is required for these. */
export const needsDetails = (reason: ReportReason | '') => reason === 'other' || reason === 'bug' || reason === 'copyright';

/** Milestone 6 §10.12: the reasons a custom domain can be reported for. */
export const DOMAIN_REASONS: readonly ReportReason[] = ['malware', 'spam', 'harassment', 'other'];

/** Reasons offered on a page: the `any` page adds "A problem with files.gg"; a domain has its own. */
export const reasonsFor = (target: ReportPageTarget): readonly ReportReason[] => {
  if (target.type === 'domain') return DOMAIN_REASONS;
  return target.type === 'any' ? [...CONTENT_REASONS, 'bug'] : CONTENT_REASONS;
};

/**
 * Exactly the hosts the API's `parse_url` accepts (api/safety/reports.py): the site's
 * own host and the CDN's. `www.files.gg` isn't one, so it's refused here too.
 */
const HOSTS = new Set(['files.gg', 'cdn.files.gg']);

/**
 * Milestone 6 §10.12: the API also resolves URLs on live custom domains. On a custom
 * domain the form accepts that domain's links too (by host, with any port, as served).
 */
export const extraReportHosts = (): readonly string[] => {
  const context = hostContext();
  return context.custom ? [context.host] : [];
};

/** The hosts the URL and DMCA fields take: "files.gg or cdn.files.gg", plus a custom domain first. */
export const linkKinds = (extraHosts: readonly string[] = extraReportHosts()): string =>
  extraHosts.length > 0 ? `${extraHosts[0]}, files.gg or cdn.files.gg` : 'files.gg or cdn.files.gg';

/** "a files.gg or cdn.files.gg link", or "a link on i.example.com, files.gg or cdn.files.gg". */
export const linkPhrase = (extraHosts: readonly string[] = extraReportHosts()): string =>
  extraHosts.length > 0 ? `a link on ${linkKinds(extraHosts)}` : `a ${linkKinds(extraHosts)} link`;

export type ParsedReportUrl =
  | { kind: 'album'; vanity: string; url: string }
  | { kind: 'url'; url: string }
  | { kind: 'invalid' };

/**
 * A pasted `files.gg` or `cdn.files.gg` URL (the scheme may be left off). An album
 * page link (`files.gg/a/<vanity>`, optionally `/report`) becomes an album target, so
 * a part can be picked; anything else on those hosts is sent as a `url` target for
 * the API to resolve (§7.3), including album items (`/a/<vanity>/<n>`).
 */
export function parseReportUrl(input: string, extraHosts: readonly string[] = extraReportHosts()): ParsedReportUrl {
  const text = input.trim();
  if (!text) return { kind: 'invalid' };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { kind: 'invalid' };
  }
  const known = HOSTS.has(url.hostname.toLowerCase()) || extraHosts.includes(url.host.toLowerCase());
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !known) return { kind: 'invalid' };
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/report') return { kind: 'invalid' };
  url.hash = '';
  url.search = '';
  const album = /^\/a\/([^/]+)(\/report)?$/.exec(path);
  if (url.hostname.toLowerCase() !== 'cdn.files.gg' && album) {
    return { kind: 'album', vanity: decodeURIComponent(album[1]!), url: url.href };
  }
  return { kind: 'url', url: url.href };
}

export interface DmcaFields {
  name: string;
  address: string;
  phone: string;
  email: string;
  work: string;
  /** One URL per line. */
  urls: string;
  good_faith: boolean;
  accurate_and_authorised: boolean;
  signature: string;
}

export const emptyDmca = (url = ''): DmcaFields => ({
  name: '',
  address: '',
  phone: '',
  email: '',
  work: '',
  urls: url,
  good_faith: false,
  accurate_and_authorised: false,
  signature: '',
});

export interface ReportFormState {
  /** Only on the `any` page. */
  url: string;
  reason: ReportReason | '';
  part: AlbumPart;
  details: string;
  contactEmail: string;
  dmca: DmcaFields;
}

export type FieldErrors = Partial<Record<'url' | 'reason' | 'details' | 'contact_email' | `dmca.${keyof DmcaFields}`, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (value: string) => value.length <= EMAIL_MAX && EMAIL.test(value);

export const dmcaUrlList = (text: string) =>
  text
    .split(/\s+/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Whether the form describes an album (a part can be picked). */
export function albumTarget(target: ReportPageTarget, url: string): string | null {
  if (target.type === 'album') return target.vanity;
  if (target.type === 'any') {
    const parsed = parseReportUrl(url);
    return parsed.kind === 'album' ? parsed.vanity : null;
  }
  return null;
}

export function validateReport(target: ReportPageTarget, state: ReportFormState, signedIn: boolean): FieldErrors {
  const errors: FieldErrors = {};
  const { reason } = state;
  if (target.type === 'any' && reason !== 'bug') {
    if (!state.url.trim()) errors.url = 'Enter the link to the file or album.';
    else if (parseReportUrl(state.url).kind === 'invalid') errors.url = `Enter ${linkPhrase()}.`;
  }
  if (!reason) errors.reason = 'Choose a reason.';
  if (needsDetails(reason) && !state.details.trim()) errors.details = 'Add some details.';
  if (state.details.length > DETAILS_MAX) errors.details = `Keep it under ${DETAILS_MAX.toLocaleString('en')} characters.`;
  const email = state.contactEmail.trim();
  if (!signedIn && email && !validEmail(email)) errors.contact_email = "That email address doesn't look right.";

  if (reason === 'copyright') {
    const d = state.dmca;
    const required = (key: 'name' | 'address' | 'phone' | 'work' | 'signature', message: string) => {
      if (!d[key].trim()) errors[`dmca.${key}`] = message;
    };
    required('name', 'Enter your full name.');
    required('address', 'Enter your address.');
    required('phone', 'Enter your phone number.');
    if (!d.email.trim()) errors['dmca.email'] = 'Enter your email address.';
    else if (!validEmail(d.email.trim())) errors['dmca.email'] = "That email address doesn't look right.";
    required('work', 'Describe the copyrighted work.');
    if (d.work.length > DETAILS_MAX) errors['dmca.work'] = `Keep it under ${DETAILS_MAX.toLocaleString('en')} characters.`;
    const urls = dmcaUrlList(d.urls);
    if (urls.length === 0) errors['dmca.urls'] = extraReportHosts().length > 0 ? 'List at least one link.' : 'List at least one files.gg link.';
    else if (urls.length > DMCA_URLS_MAX) errors['dmca.urls'] = `List at most ${DMCA_URLS_MAX} links.`;
    else if (urls.some((url) => parseReportUrl(url).kind === 'invalid')) errors['dmca.urls'] = `Every link must be ${linkPhrase()}.`;
    if (!d.good_faith) errors['dmca.good_faith'] = 'Confirm this statement.';
    if (!d.accurate_and_authorised) errors['dmca.accurate_and_authorised'] = 'Confirm this statement.';
    required('signature', 'Type your full legal name.');
  }
  return errors;
}

/** The request body. Call only once `validateReport` returns no errors. */
export function buildReport(target: ReportPageTarget, state: ReportFormState, signedIn: boolean): ViewerReportRequest {
  const reason = state.reason as ReportReason;
  let body: ViewerReportTarget;
  if (reason === 'bug') body = { type: 'bug' };
  else if (target.type === 'domain') body = { type: 'domain', hostname: target.hostname };
  else if (target.type === 'file') body = { type: 'file', vanity: target.vanity };
  else if (target.type === 'album') body = { type: 'album', vanity: target.vanity, part: state.part };
  else {
    const parsed = parseReportUrl(state.url);
    body =
      parsed.kind === 'album'
        ? { type: 'album', vanity: parsed.vanity, part: state.part }
        : { type: 'url', url: parsed.kind === 'url' ? parsed.url : state.url.trim() };
  }
  const details = state.details.trim();
  const email = state.contactEmail.trim();
  const request: ViewerReportRequest = { target: body, reason };
  if (details) request.details = details;
  if (!signedIn && email) request.contact_email = email;
  if (reason === 'copyright') {
    const d = state.dmca;
    const dmca: DmcaNotice = {
      name: d.name.trim(),
      address: d.address.trim(),
      phone: d.phone.trim(),
      email: d.email.trim(),
      work: d.work.trim(),
      urls: dmcaUrlList(d.urls).map((url) => {
        const parsed = parseReportUrl(url);
        return parsed.kind === 'invalid' ? url : parsed.url;
      }),
      good_faith: d.good_faith,
      accurate_and_authorised: d.accurate_and_authorised,
      signature: d.signature.trim(),
    };
    request.dmca = dmca;
  }
  return request;
}

/**
 * `DETAILS_REQUIRED` / `DMCA_FIELDS_REQUIRED` bodies carry `errors` per field
 * (§12). Maps them onto the form's fields; unknown keys are dropped.
 */
export function serverFieldErrors(body: unknown, code: string | null): FieldErrors {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  const out: FieldErrors = {};
  const text = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);
  if (code === 'DETAILS_REQUIRED') {
    out.details = text((errors as Record<string, unknown> | undefined)?.details, 'Add some details.');
    return out;
  }
  if (code === 'DMCA_FIELDS_REQUIRED' && typeof errors === 'object' && errors !== null) {
    const keys: (keyof DmcaFields)[] = ['name', 'address', 'phone', 'email', 'work', 'urls', 'good_faith', 'accurate_and_authorised', 'signature'];
    for (const key of keys) {
      const value = (errors as Record<string, unknown>)[key];
      if (value !== undefined) out[`dmca.${key}`] = text(value, 'Fill this in.');
    }
  }
  return out;
}

/** The `?url=` a "Report" link may carry to the `any` page. */
export function initialReportUrl(search: string = window.location.search): string {
  return new URLSearchParams(search).get('url')?.slice(0, 2048) ?? '';
}
