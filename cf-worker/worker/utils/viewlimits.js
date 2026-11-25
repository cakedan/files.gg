// View limits (docs/redesign/contracts/milestone-6.md §19.5). Pure, so it is unit-tested.
//
// The internal file lookup carries `view_limit: { limit, used, action }`, or null without a limit. While
// one is set the Worker serves the file like a protected one:
//   - the page is the `limited` shell, `{ vanity, view_limited: true, views_remaining }`, with generic og
//     tags and no image, video or audio (a password file keeps its lock screen, with the same two fields);
//   - there is never a bot or `Accept: image/*` redirect to the CDN;
//   - link-preview bots get a 403 text answer instead of a page, so they never reach
//     /access/open/files/<vanity> and never use up a view;
//   - the CDN serves its bytes and previews only through a URL signed with the file grant.
// Once the limit is used up (`used >= limit`) the file is missing, never "view limit reached".

import { isLinkPreviewUserAgent } from './bots.js';

export const LIMITED_FILE_TITLE = 'View-limited file · files.gg';
export const BOT_REFUSAL_TEXT = "This file has a view limit and can't be previewed.";
export const BOT_REFUSAL_CACHE_CONTROL = 'private, no-store';

function count(value) {
  return (typeof(value) === 'number' && Number.isSafeInteger(value) && value >= 0) ? value : null;
}

// The lookup's view limit as { limit, used, remaining, action }, or null when there is none. Anything
// present but malformed fails closed: limited, with nothing remaining.
export function viewLimitOf(data) {
  const value = data ? data.view_limit : undefined;
  if (value === null || value === undefined) {
    return null;
  }
  const limit = (value && typeof(value) === 'object') ? count(value.limit) : null;
  const used = (value && typeof(value) === 'object') ? count(value.used) : null;
  if (limit === null || used === null || limit < 1) {
    return { limit: 0, used: 0, remaining: 0, action: null };
  }
  return { limit, used, remaining: Math.max(0, limit - used), action: value.action ?? null };
}

export function isViewLimited(data) {
  return viewLimitOf(data) !== null;
}

// A link-preview bot (§19.5, §19.7a): ShareX, anything calling itself a bot, and the preview fetchers
// without "bot" in their name (utils/bots.js), plus requests that accept `image/*`, as image embeds do.
export function isLinkPreviewBot(headers) {
  if (isLinkPreviewUserAgent(headers.get('user-agent'))) {
    return true;
  }
  const accepted = (headers.get('accept') || '').split(',').map((x) => x.split(';').shift().trim().toLowerCase());
  return accepted.includes('image/*');
}

// The answer for a link-preview bot: a tiny text body, never cached, no og media at all.
export function botRefusalResponse(method = 'GET') {
  return new Response(method === 'HEAD' ? null : BOT_REFUSAL_TEXT, {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': BOT_REFUSAL_CACHE_CONTROL,
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
