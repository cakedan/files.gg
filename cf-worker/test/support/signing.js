// Signs CDN URLs the way the API does (docs/redesign/contracts/milestone-3.md §3), with Node's own
// crypto rather than the Worker's code, so the tests check the Worker against an independent
// implementation. The Worker itself never signs.
import { createHmac } from 'node:crypto';

export const SIGNING_SECRET = 'test-cdn-signing-secret';
export const DAY_S = 24 * 60 * 60;
export const NOW_S = () => Math.floor(Date.now() / 1000);

export function signature(path, expires, grant, secret = SIGNING_SECRET) {
  return createHmac('sha256', secret).update(`filesgg-cdn-1\n${path}\n${expires}\n${grant}`).digest('base64url');
}

// `url` is a path with an optional query (`/files/a.png?album=x`). Adds expires and sig for the
// path, signed with `grant`. `expires` defaults to an hour from now.
export function signUrl(url, grant, { expires = NOW_S() + 3600, secret = SIGNING_SECRET } = {}) {
  const parsed = new URL(url, 'https://cdn.files.gg');
  parsed.searchParams.set('expires', String(expires));
  parsed.searchParams.set('sig', signature(parsed.pathname, expires, grant, secret));
  return parsed.pathname + parsed.search;
}

export const fileGrant = (id, version) => `file:${id}:${version}`;
export const albumGrant = (id, version) => `album:${id}:${version}`;
