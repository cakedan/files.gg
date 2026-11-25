/**
 * The ShareX `.sxcu` and the curl snippet for an upload key (milestone-6 §7.7). Built in
 * the browser from the create response, once, because they contain the key; the ShareX
 * defaults picked in the dialog go only into `Arguments` here, never to the API.
 */

import { PUBLIC_API_URL, type ViewLimitAction, type Visibility } from './api';

export interface SharexDefaults {
  /** Seconds, or null for the account's upload defaults (milestone-5 §21). */
  expiresIn: number | null;
  /** Null leaves access to the account's upload defaults (milestone-5 §21). */
  visibility: Exclude<Visibility, 'private'> | 'private' | null;
  /** With `visibility: "password"`: a generated password per upload. */
  generatePassword: boolean;
  nsfw: boolean;
  /** An album vanity (only with `albums:append`). */
  album: string | null;
  /** Milestone 6 §19.3: unique viewers (1–1000) before the action fires, or null for none. */
  viewLimit?: number | null;
  /** What happens at the limit: `expire` (the default) or `private`. Only with a `viewLimit`. */
  viewLimitAction?: ViewLimitAction;
}

export const NO_SHAREX_DEFAULTS: SharexDefaults = { expiresIn: null, visibility: null, generatePassword: false, nsfw: false, album: null };

/** The `Arguments` object, in the contract's order: expiry, access, NSFW, album, then the view limit. */
export function sharexArguments(defaults: SharexDefaults, canAppendAlbums: boolean): Record<string, string> {
  const args: Record<string, string> = {};
  if (defaults.expiresIn !== null) args.expires_in = String(defaults.expiresIn);
  if (defaults.visibility !== null) args.visibility = defaults.visibility;
  if (defaults.visibility === 'password' && defaults.generatePassword) args.generate_password = 'true';
  if (defaults.nsfw) args.nsfw = 'true';
  if (defaults.album && canAppendAlbums) args.album = defaults.album;
  if (defaults.viewLimit !== undefined && defaults.viewLimit !== null) {
    args.view_limit = String(defaults.viewLimit);
    args.view_limit_action = defaults.viewLimitAction ?? 'expire';
  }
  return args;
}

/** `RequestURL`: the API origin plus `/files` (tools never use `files.gg/api`). */
export const uploadUrl = (apiOrigin: string = PUBLIC_API_URL) => `${apiOrigin.replace(/\/+$/, '')}/files`;

/**
 * The API's own `RequestURL` (its `sharex` object), when it's usable: https, or http while the page
 * itself is served over http (the local stack, e2e/README.md). Anything else falls back to
 * `uploadUrl()`, so a tool is never handed a plain-http URL from an https page.
 */
export function apiRequestUrl(sharex: Record<string, unknown> | undefined, pageProtocol: string = window.location.protocol): string {
  const url = sharex?.RequestURL;
  if (typeof url === 'string' && (/^https:\/\//.test(url) || (pageProtocol === 'http:' && /^http:\/\//.test(url)))) {
    return url;
  }
  return uploadUrl();
}

/**
 * The `.sxcu` object with the contract's key order. `RequestURL` comes from the API's
 * own `sharex` object when it sent one, else `PUBLIC_API_URL`.
 */
export function buildSharexConfig({ keyName, secret, requestUrl = uploadUrl(), args }: { keyName: string; secret: string; requestUrl?: string; args: Record<string, string> }) {
  return {
    Version: '17.0.0',
    Name: `files.gg (${keyName})`,
    DestinationType: 'ImageUploader, TextUploader, FileUploader',
    RequestMethod: 'POST',
    RequestURL: requestUrl,
    Headers: { Authorization: `Key ${secret}` },
    Body: 'MultipartFormData',
    ...(Object.keys(args).length > 0 ? { Arguments: args } : {}),
    FileFormName: 'file',
    // Key uploads always answer `url_with_password` (the plain link without a password), so a password the
    // account's upload defaults generate reaches the copied link too (milestone-5 §21).
    URL: '{json:url_with_password}',
    ErrorMessage: '{json:message}',
  };
}

/** `files.gg - <key name>.sxcu`, without characters file systems refuse. */
export const sharexFilename = (keyName: string) => `files.gg - ${keyName.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').trim() || 'Upload key'}.sxcu`;

/** The curl snippet: the same arguments as `-F` fields (§7.7). */
export function curlSnippet({ secret, requestUrl = uploadUrl(), args }: { secret: string; requestUrl?: string; args: Record<string, string> }): string {
  const fields = ['-F "file=@photo.png"', ...Object.entries(args).map(([name, value]) => `-F "${name}=${value}"`)];
  return `curl -H "Authorization: Key ${secret}" \\\n     ${fields.join(' ')} \\\n     ${requestUrl}`;
}

/** Saves the `.sxcu` (`application/json`) through a temporary object URL. */
export function downloadSharexConfig(config: object, filename: string): void {
  const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
