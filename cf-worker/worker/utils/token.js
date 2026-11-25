// Signed access tokens for protected files and albums (docs/redesign/contracts/milestone-2.md §1).
//
//   token = base64url(body_json) + "." + base64url(HMAC_SHA256(CDN_TOKEN_SECRET, base64url(body_json)))
//
// body_json is the claims with sorted keys and no whitespace (Python's
// json.dumps(claims, separators=(',', ':'), sort_keys=True)). Pure: Web Crypto only, so it runs in
// workerd and in Node's test runner.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const TOKEN_KINDS = Object.freeze(['file', 'album']);
export const TOKEN_SCOPES = Object.freeze(['unlock', 'owner']);
const CLAIM_KEYS = Object.freeze(['e', 'k', 's', 't', 'u', 'v']);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// Tokens are short; anything far longer is not one of ours.
const MAX_TOKEN_LENGTH = 1024;


export function base64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Strict: unpadded RFC 4648 §5 alphabet only. Returns null for anything else.
export function base64urlDecode(value) {
  if (typeof(value) !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1) {
    return null;
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

// JSON with keys sorted and no whitespace, like Python's sort_keys=True with compact separators.
// (Claims are flat: strings and integers.)
export function canonicalJson(claims) {
  const sorted = {};
  for (const key of Object.keys(claims).sort()) {
    sorted[key] = claims[key];
  }
  return JSON.stringify(sorted);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function constantTimeEqual(a, b) {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    difference |= (a[i % (a.length || 1)] ?? 0) ^ (b[i % (b.length || 1)] ?? 0);
  }
  return difference === 0;
}


// Used by tests (to reproduce the contract's vectors); the Worker only verifies.
export async function signToken(claims, secret) {
  const body = base64urlEncode(encoder.encode(canonicalJson(claims)));
  return body + '.' + base64urlEncode(await hmac(secret, body));
}


function isInteger(value) {
  return typeof(value) === 'number' && Number.isSafeInteger(value);
}

export function validClaims(claims) {
  if (!claims || typeof(claims) !== 'object' || Array.isArray(claims)) {
    return false;
  }
  const keys = Object.keys(claims).sort();
  if (keys.length !== CLAIM_KEYS.length || keys.some((key, i) => key !== CLAIM_KEYS[i])) {
    return false;
  }
  return TOKEN_KINDS.includes(claims.k)
    && typeof(claims.t) === 'string' && /^\d{1,20}$/.test(claims.t)
    && TOKEN_SCOPES.includes(claims.s)
    && isInteger(claims.v) && claims.v >= 0
    && isInteger(claims.u) && isInteger(claims.e);
}


// Returns the claims when the signature is right, the claims are well-formed and `e > now`;
// otherwise null. `now` is epoch seconds. A missing or empty secret always fails (fail closed).
export async function verifyToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof(secret) !== 'string' || !secret) {
    return null;
  }
  if (typeof(token) !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, signature] = parts;
  const given = base64urlDecode(signature);
  const bodyBytes = base64urlDecode(body);
  if (!given || !bodyBytes) {
    return null;
  }

  // Signature first, constant time, before the claims are even parsed.
  const expected = await hmac(secret, body);
  if (!constantTimeEqual(given, expected)) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(decoder.decode(bodyBytes));
  } catch {
    return null;
  }
  if (!validClaims(claims) || !(claims.e > now)) {
    return null;
  }
  return claims;
}


// Rules 3 and 4 of contract §1 (with §2), for verified claims:
// - `k: "file"`: `t` is the requested file's id and `v` is the file's current access_version;
// - `k: "album"`: some entry of the file lookup's `albums` ([{ id, access_version }], the albums
//   the file is a visible item of) has `id === t` and `access_version === v`. Missing or empty
//   denies. A `private` file needs an owner pass even through an album.
// A missing file id denies everything (fail closed).
export function tokenGrantsAccess(claims, { fileId, accessVersion, albums, visibility }) {
  if (!claims || fileId === undefined || fileId === null || String(fileId) === '') {
    return false;
  }
  if (claims.k === 'file') {
    return claims.t === String(fileId) && claims.v === accessVersion;
  }
  if (claims.k === 'album') {
    const list = Array.isArray(albums) ? albums : [];
    const match = list.some((album) => album && typeof(album) === 'object'
      && String(album.id) === claims.t && album.access_version === claims.v);
    if (!match) {
      return false;
    }
    return visibility !== 'private' || claims.s === 'owner';
  }
  return false;
}
