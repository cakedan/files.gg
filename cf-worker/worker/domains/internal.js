// Worker ↔ API internal lookup (docs/redesign/contracts/milestone-2.md §2).
//
//   GET <API_ORIGIN>/internal/files/<vanity>    X-Filesgg-Origin-Secret: <ORIGIN_SHARED_SECRET>
//   GET <API_ORIGIN>/internal/albums/<vanity>
//
// Results are cached for 30 s with the Cache API, keyed by vanity, and so are unknown vanities
// (negative entries). Returns { status: 'found', data } | { status: 'missing' } |
// { status: 'unavailable' } (API unreachable, timed out, 5xx, or the Worker has no secret).

import { apiOrigin, getStringBinding } from '../utils/env.js';
import { ORIGIN_SECRET_HEADER } from '../utils/security.js';

export const LOOKUP_TTL_SECONDS = 30;
export const LOOKUP_TIMEOUT_MS = 8000;
const CACHE_NAME = 'filesgg-internal-lookups';
// Cache API keys only; nothing is ever fetched from this URL. Bump `v1` if the payload changes.
const CACHE_KEY_BASE = 'https://files.gg/__internal-lookup-cache/v1/';

let warnedMissingSecret = false;


export function encodeVanityPath(vanity) {
  return String(vanity).split('/').map((part) => encodeURIComponent(part)).join('/');
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


// kind: 'files' | 'albums'.
export async function internalLookup(event, kind, vanity) {
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
  if (!vanity || String(vanity).length > 256) {
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
      headers: { [ORIGIN_SECRET_HEADER]: secret, accept: 'application/json' },
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
