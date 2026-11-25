// Signed CDN URLs (docs/redesign/contracts/milestone-3.md §3). The API signs; the Worker only
// verifies.
//
//   signature = base64url_nopad( HMAC-SHA256( CDN_SIGNING_SECRET,
//                 "filesgg-cdn-1" + "\n" + <path> + "\n" + <expires> + "\n" + <grant> ) )
//
//   grant = "file:"  + <file id>  + ":" + <file access_version>
//         | "album:" + <album id> + ":" + <album access_version>
//         | "staff:" + <staff user id> + ":" + <file id>      (milestone-4.md §10.3, ≤ 10 minutes)
//
// `path` is the request's pathname exactly as it arrived (percent-encoded, no host, no query).
// `?download=true` and `?v=` aren't signed. Pure: Web Crypto only, so it runs in workerd and in
// Node's test runner.

const encoder = new TextEncoder();

export const SIGNATURE_VERSION = 'filesgg-cdn-1';
// A sanity cap on how far in the future `expires` may be (contract §3, rule 3).
export const MAX_SIGNED_URL_SECONDS = 31 * 24 * 60 * 60;
// Staff URLs live at most 10 minutes (milestone-4.md §10.3); the API's STAFF_URL_TTL is capped here.
export const MAX_STAFF_URL_SECONDS = 600;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// A HMAC-SHA256 is 32 bytes: 43 base64url characters without padding.
const SIGNATURE_LENGTH = 43;
// Epoch seconds, canonical (no sign, no leading zero, no exponent), at most 12 digits.
const EXPIRES = /^[1-9]\d{0,11}$/;
// Snowflake ids are decimal strings.
const ID = /^\d{1,20}$/;


export function base64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compares every byte whatever the inputs, so the time taken says nothing about where they differ.
export function constantTimeEqual(a, b) {
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    difference |= (a[i % (a.length || 1)] ?? 0) ^ (b[i % (b.length || 1)] ?? 0);
  }
  return difference === 0;
}


// One imported key per secret value (a Worker isolate only ever sees one).
let cachedKey = { secret: null, key: null };
async function hmacKey(secret) {
  if (cachedKey.secret !== secret) {
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

export function signingMessage(path, expires, grant) {
  return `${SIGNATURE_VERSION}\n${path}\n${expires}\n${grant}`;
}


function isVersion(value) {
  return typeof(value) === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function grant(kind, id, accessVersion) {
  const value = (typeof(id) === 'number' && Number.isSafeInteger(id)) ? String(id) : id;
  if (typeof(value) !== 'string' || !ID.test(value) || !isVersion(accessVersion)) {
    return null;
  }
  return `${kind}:${value}:${accessVersion}`;
}

// `file:<id>:<access_version>`, or null when either is missing or malformed (fail closed).
export const fileGrant = (fileId, accessVersion) => grant('file', fileId, accessVersion);
// `album:<id>:<access_version>`, or null when either is missing or malformed (fail closed).
export const albumGrant = (albumId, accessVersion) => grant('album', albumId, accessVersion);

// `staff:<staff user id>:<file id>` (milestone-4.md §10.3), or null when either is missing or
// malformed (fail closed).
export function staffGrant(staffId, fileId) {
  const file = (typeof(fileId) === 'number' && Number.isSafeInteger(fileId)) ? String(fileId) : fileId;
  if (typeof(staffId) !== 'string' || !ID.test(staffId) || typeof(file) !== 'string' || !ID.test(file)) {
    return null;
  }
  return `staff:${staffId}:${file}`;
}

// The grant a request for one of a file's URLs (the file or a preview) has to be signed with,
// from the file lookup (contract §5): the file grant, or with `album=<vanity>` the grant of that
// album, which must be in the lookup's `albums` list ([{ id, vanity, access_version }], the
// albums the file is shown in). null when there is none.
export function grantForFileRequest(data, query) {
  const file = (data && data.file) || {};
  const access = (data && data.access) || {};
  if (!query.has('album')) {
    return fileGrant(file.id, access.access_version);
  }
  const vanity = query.get('album');
  const albums = (data && Array.isArray(data.albums)) ? data.albums : [];
  const entry = albums.find((album) => album && typeof(album) === 'object' && typeof(album.vanity) === 'string'
    && album.vanity !== '' && album.vanity === vanity);
  return entry ? albumGrant(entry.id, entry.access_version) : null;
}


// True when `query` carries `expires` and `sig` that are valid for `path` and `grant` right now:
// the signature matches (constant time), `expires > now` and `expires <= now + maxSeconds`
// (31 days by default). `now` is epoch seconds. A missing secret or grant always fails (fail
// closed).
export async function verifySignedUrl({
  secret, path, query, grant, now = Math.floor(Date.now() / 1000), maxSeconds = MAX_SIGNED_URL_SECONDS,
}) {
  if (typeof(secret) !== 'string' || !secret || typeof(grant) !== 'string' || !grant || typeof(path) !== 'string') {
    return false;
  }
  const expiresText = query.get('expires');
  const sig = query.get('sig');
  if (typeof(expiresText) !== 'string' || !EXPIRES.test(expiresText)) {
    return false;
  }
  if (typeof(sig) !== 'string' || sig.length !== SIGNATURE_LENGTH || !BASE64URL.test(sig)) {
    return false;
  }

  // Compared as text, so the 4 spellings of the last character's unused bits can't all pass.
  const expected = base64urlEncode(new Uint8Array(await crypto.subtle.sign(
    'HMAC', await hmacKey(secret), encoder.encode(signingMessage(path, expiresText, grant)),
  )));
  const matches = constantTimeEqual(encoder.encode(sig), encoder.encode(expected));

  const expires = Number(expiresText);
  return matches && expires > now && expires <= now + maxSeconds;
}

// A staff URL (milestone-4.md §10.3): `?staff=<staff user id>&expires&sig`, signed for this path
// with `staff:<staff id>:<file id>`, where the file id comes from the lookup, and valid for at most
// 10 minutes. False without `staff=`, or when anything is missing or wrong.
export async function verifyStaffUrl({ secret, path, query, fileId, now = Math.floor(Date.now() / 1000) }) {
  if (!query.has('staff')) {
    return false;
  }
  const grant = staffGrant(query.get('staff'), fileId);
  if (!grant) {
    return false;
  }
  return await verifySignedUrl({ secret, path, query, grant, now, maxSeconds: MAX_STAFF_URL_SECONDS });
}
