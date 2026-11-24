import { DomainRouter } from 'cf-worker-router';

import { apiOrigin, getStringBinding } from '../utils/env.js';
import { originRequestHeaders } from '../utils/security.js';

export const API_HOSTNAME = 'api.files.gg';

export const router = new DomainRouter(API_HOSTNAME);


// Handled (not `{pass: true}`) so the response goes through `beforeResponse` in index.js and gets
// the credentialed CORS headers. A worker's subrequest to its own route goes to the origin.
router.route('/*', '*', async (event) => {
  const url = new URL(apiOrigin(event.environment));
  url.pathname = event.url.pathname;
  url.search = event.url.search;
  return await fetch(forOrigin(new Request(url, event.originalRequest), event));
});


let warnedMissingSecret = false;

// Every request to the API goes through here: client-supplied X-Filesgg-* headers are dropped, and
// the client IP is vouched for with the ORIGIN_SHARED_SECRET binding (see cf-worker/README.md).
export function forOrigin(request, event) {
  const { headers, trusted } = originRequestHeaders(
    request.headers,
    getStringBinding(event.environment, 'ORIGIN_SHARED_SECRET'),
    event.originalRequest.headers.get('cf-connecting-ip'),
  );
  if (!trusted && !warnedMissingSecret) {
    warnedMissingSecret = true;
    console.warn('ORIGIN_SHARED_SECRET is not set: API requests are sent without a trusted client IP');
  }
  return new Request(request, { headers });
}


const bodyLessMethods = ['GET', 'HEAD', 'OPTIONS'];
export async function requestApi(event, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  // Same path and query as the incoming request unless a path is given.
  const url = new URL(apiOrigin(event.environment));
  url.pathname = options.path || event.url.pathname;
  url.search = event.url.search;

  const request = forOrigin(new Request(url, event.request), event);
  if (bodyLessMethods.includes(options.method)) {
    options.body = null;
  }
  return await fetch(request, options);
};
