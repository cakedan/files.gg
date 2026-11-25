// Bytes for cdn.files.gg (docs/redesign/contracts/milestone-2.md §3, milestone-3.md §0): SigV4-signed
// GET/HEAD to B2's S3 endpoint with a read-only key, plus an edge cache keyed by the object key
// (files/<hash_id>, derived/...). B2 only. Callers check access FIRST.

import { AwsClient } from 'aws4fetch';

import { getStringBinding } from './utils/env.js';

// Only these client headers reach storage.
export const PASSTHROUGH_HEADERS = Object.freeze(['range', 'if-none-match', 'if-modified-since']);
// Storage response headers worth keeping; everything else (x-amz-*, x-bz-*...) is dropped.
const KEPT_HEADERS = Object.freeze(['accept-ranges', 'content-length', 'content-range', 'etag', 'last-modified']);
const BLOB_CACHE_NAME = 'filesgg-blobs';
// Cache API keys only. Blobs are content-addressed and never change.
const BLOB_CACHE_KEY_BASE = 'https://cdn.files.gg/__blob-cache/v1/';
const BLOB_CACHE_CONTROL = 'public, max-age=31536000, immutable';

let warnedNoStorage = false;
let client = null;
let clientKey = null;


export function b2Config(env) {
  const config = {
    endpoint: getStringBinding(env, 'S3_ENDPOINT'),
    region: getStringBinding(env, 'S3_REGION'),
    bucket: getStringBinding(env, 'S3_BUCKET_FILES'),
    accessKeyId: getStringBinding(env, 'S3_READ_ACCESS_KEY_ID'),
    secretAccessKey: getStringBinding(env, 'S3_READ_SECRET_ACCESS_KEY'),
  };
  return Object.values(config).every(Boolean) ? config : null;
}

function getClient(config) {
  const key = [config.accessKeyId, config.secretAccessKey, config.region].join('\n');
  if (!client || key !== clientKey) {
    // retries: 0, so a failing B2 answers at once instead of backing off for seconds.
    client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
      retries: 0,
    });
    clientKey = key;
  }
  return client;
}

export function objectUrl(config, key) {
  const endpoint = config.endpoint.replace(/\/+$/, '');
  const path = String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
  return `${endpoint}/${encodeURIComponent(config.bucket)}/${path}`;
}

function passthroughHeaders(request) {
  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

function cleanResponse(response) {
  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = response.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return new Response(response.body, { status: response.status, headers });
}


async function fromB2(config, method, key, headers) {
  const signed = await getClient(config).sign(objectUrl(config, key), { method, headers });
  return await fetch(signed);
}

// Returns the storage response for `storage` ({ key }) with only safe headers, or a
// status-only Response: 404 when the object is missing (storage 403s become 404s), else the
// storage status. 2xx and 304 keep their bodies and range/validator headers.
// `cacheVersion`: part of the edge-cache key, for objects whose key is reused (previews are
// rewritten in place by a re-derive; previews_version tells them apart). `cacheWrite: false` reads
// the edge cache but never fills it (the album ZIP, which would otherwise tee every blob).
export async function fetchBlob({ env, request, storage, waitUntil, cacheVersion = null, cacheWrite = true }) {
  const method = (request.method === 'HEAD') ? 'HEAD' : 'GET';
  const key = storage && storage.key;
  if (typeof(key) !== 'string' || !key || key.includes('..')) {
    return new Response(null, { status: 404 });
  }
  const headers = passthroughHeaders(request);
  const plainGet = method === 'GET' && ![...headers.keys()].length;

  // Edge cache: whole-object GETs only. Range and conditional requests go to storage.
  let cache = null;
  const version = (cacheVersion === null || cacheVersion === undefined) ? '' : `?v=${encodeURIComponent(String(cacheVersion))}`;
  const cacheKey = new Request(BLOB_CACHE_KEY_BASE + key.split('/').map(encodeURIComponent).join('/') + version);
  if (plainGet) {
    cache = await caches.open(BLOB_CACHE_NAME).catch(() => null);
    const hit = cache && await cache.match(cacheKey).catch(() => null);
    if (hit) {
      return cleanResponse(hit);
    }
  }

  const config = b2Config(env);
  if (!config) {
    // A misconfiguration must not look like deleted files.
    if (!warnedNoStorage) {
      warnedNoStorage = true;
      console.error('S3_* bindings are not set: cdn.files.gg can\'t read any bytes (503)');
    }
    return new Response(null, { status: 503 });
  }
  let response;
  try {
    response = await fromB2(config, method, key, headers);
  } catch (error) {
    console.error('B2 fetch failed', String(error));
    response = new Response(null, { status: 502 });
  }

  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return new Response(null, { status: 404 });
  }
  if (!(response.ok || response.status === 304 || response.status === 416)) {
    await response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status >= 500 ? 502 : response.status });
  }

  response = cleanResponse(response);
  if (cache && cacheWrite && response.status === 200) {
    const [forClient, forCache] = response.body ? response.body.tee() : [null, null];
    const cached = new Response(forCache, { status: 200, headers: response.headers });
    cached.headers.set('Cache-Control', BLOB_CACHE_CONTROL);
    waitUntil(cache.put(cacheKey, cached).catch(() => {}));
    response = new Response(forClient, { status: 200, headers: response.headers });
  }
  return response;
}
