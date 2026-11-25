// Worker ↔ API internal lookups (docs/redesign/contracts/milestone-3.md §5, milestone-4.md §6.3,
// milestone-6.md §10.7).
//
//   GET <API_ORIGIN>/internal/files/<vanity>       X-Filesgg-Origin-Secret: <ORIGIN_SHARED_SECRET>
//   GET <API_ORIGIN>/internal/albums/<vanity>      X-Filesgg-Internal-Lookup: 1
//   GET <API_ORIGIN>/internal/domains/<hostname>
//
// They are built here from scratch: no client header (no Cookie, no X-Filesgg-Via) is ever on them.
// The API needs both headers. Forwarded client requests carry the secret too (domains/api.js), but
// never the lookup header, which originRequestHeaders always strips.
//
// Every page and every CDN path names a vanity (or, for a custom host, its hostname); there are no
// lookups by id. Results are cached
// for 5 s with the Cache API, keyed by kind and vanity, and so are unknown vanities (negative
// entries). Returns { status: 'found', data } | { status: 'missing' } |
// { status: 'unavailable' } (API unreachable, timed out, 5xx, or the Worker has no secret).

import { apiOrigin, getStringBinding } from '../utils/env.js';
import { INTERNAL_LOOKUP_HEADER, ORIGIN_SECRET_HEADER } from '../utils/security.js';

export const LOOKUP_TTL_SECONDS = 5;
export const LOOKUP_TIMEOUT_MS = 8000;
const CACHE_NAME = 'filesgg-internal-lookups';
// Cache API keys only; nothing is ever fetched from this URL. Bump the version if the payload
// changes (v3: milestone 3's `previews`, albums with vanities, items_storage and collage; v4:
// milestone 4's `safety`, `serve_inline` and `pending_count`; v5: `safety` and `expires_at` in
// album `items_access`; v6: milestone 6's `served_on` and `owner_state`, `owner_user_id` on albums,
// and the domain lookup; v7: milestone-6.md §19.5's `view_limit` on file lookups).
export const CACHE_KEY_BASE = 'https://files.gg/__internal-lookup-cache/v7/';

export const LOOKUP_KINDS = Object.freeze(['files', 'albums', 'domains']);

let warnedMissingSecret = false;


export function encodeVanityPath(vanity) {
  return String(vanity).split('/').map((part) => encodeURIComponent(part)).join('/');
}

// A vanity the lookup can name safely: no empty, `.` or `..` segment (and no backslash, which URL
// parsing treats as `/`). Otherwise the URL parser resolves the segments, and the API URL and the
// cache key point somewhere else, e.g. /a/..%2F..%2Fv4%2Ffiles%2F<victim> would cache a "missing"
// entry under another file's key.
export function lookupableVanity(vanity) {
  const text = String(vanity);
  if (!text || text.includes('\\')) {
    return false;
  }
  return text.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function waitUntil(event, promise) {
  const guarded = promise.catch(() => {});
  if (event.context && typeof(event.context.waitUntil) === 'function') {
    event.context.waitUntil(guarded);
  }
  return guarded;
}


// kind: 'files' | 'albums' by vanity, or 'domains' by hostname.
export async function internalLookup(event, kind, vanity) {
  if (!LOOKUP_KINDS.includes(kind)) {
    throw new Error(`unknown internal lookup kind ${kind}`);
  }
  const secret = getStringBinding(event.environment, 'ORIGIN_SHARED_SECRET');
  if (!secret) {
    // Without the secret every lookup would 404 and every file would look deleted. Say
    // "unavailable" instead, which tells users the file still exists.
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      console.error('ORIGIN_SHARED_SECRET is not set: internal lookups are disabled, pages show "unavailable"');
    }
    return { status: 'unavailable' };
  }
  if (!vanity || String(vanity).length > 256 || !lookupableVanity(vanity)) {
    return { status: 'missing' };
  }

  const path = `${kind}/${encodeVanityPath(vanity)}`;
  const cache = await openCache();
  const cacheKey = new Request(CACHE_KEY_BASE + path);
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      const cached = await hit.json().catch(() => null);
      if (cached && cached.missing) {
        return { status: 'missing' };
      }
      if (cached && cached.data) {
        return { status: 'found', data: cached.data };
      }
    }
  }

  let response;
  try {
    response = await fetch(`${apiOrigin(event.environment)}/internal/${path}`, {
      headers: { [ORIGIN_SECRET_HEADER]: secret, [INTERNAL_LOOKUP_HEADER]: '1', accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { status: 'unavailable' };
  }

  let result;
  if (response.status === 404) {
    result = { status: 'missing' };
  } else if (response.ok) {
    const data = await response.json().catch(() => null);
    if (!data || typeof(data) !== 'object') {
      return { status: 'unavailable' };
    }
    result = { status: 'found', data };
  } else {
    // 5xx and anything unexpected: not cached, so the next request retries.
    await response.body?.cancel().catch(() => {});
    return { status: 'unavailable' };
  }

  if (cache) {
    const body = (result.status === 'missing') ? { missing: true } : { data: result.data };
    waitUntil(event, cache.put(cacheKey, new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${LOOKUP_TTL_SECONDS}`,
      },
    })));
  }
  return result;
}
