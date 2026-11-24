import { FetchRouter } from 'cf-worker-router';

import {
  apiRouter,
  cdnRouter,
  proxyRouter,
  stableRouter,
} from './domains/index.js';

import { CDN_HOSTNAME, applyCdnSecurityHeaders, requestStorage } from './domains/cdn.js';
import { getStringBinding } from './utils/env.js';
import { CDN_EXPOSE_HEADERS, corsHeaders, isCredentialedRoute, parseAllowedOrigins } from './utils/security.js';


// Origins allowed to make credentialed API requests: the comma-separated CORS_ALLOWED_ORIGINS var
// (see cf-worker/README.md). Defaults to https://files.gg. Parsed once per distinct value.
let allowedOriginsCache = { raw: null, origins: parseAllowedOrigins(undefined) };
function getAllowedOrigins(env) {
  const raw = getStringBinding(env, 'CORS_ALLOWED_ORIGINS') || null;
  if (raw !== allowedOriginsCache.raw) {
    allowedOriginsCache = { raw, origins: parseAllowedOrigins(raw || undefined) };
  }
  return allowedOriginsCache.origins;
}


export const router = new FetchRouter();

router.beforeResponse = (response, event) => {
  const { hostname, pathname } = event.url;
  const origin = event.originalRequest.headers.get('origin');
  const isCdn = (hostname === CDN_HOSTNAME);
  if (!origin && !isCdn) {
    return response;
  }

  // Copy: responses from fetch() have immutable headers.
  response = new Response(response.body, response);

  // CDN bytes always carry CORS `*` (pdf.js and canvas on files.gg fetch them, and the browser
  // cache must not keep a copy without it). Elsewhere, only cross-origin requests get CORS headers.
  const headers = corsHeaders({
    allowedOrigins: getAllowedOrigins(event.environment),
    credentialed: isCredentialedRoute(hostname, pathname),
    origin,
  });

  // Drop whatever CORS the origin sent (the API adds `*` with credentials), then set ours.
  response.headers.delete('access-control-allow-credentials');
  for (const name in headers) {
    if (name === 'Vary') {
      response.headers.append('vary', headers[name]);
    } else {
      response.headers.set(name, headers[name]);
    }
  }

  // Every cdn.files.gg response, including 404s, 405s and 500s, is sandboxed.
  if (isCdn) {
    applyCdnSecurityHeaders(response);
    response.headers.set('Access-Control-Expose-Headers', CDN_EXPOSE_HEADERS);
  }
  return response;
};

router.route('/favicon.ico', '*', (event) => {
  return requestStorage(event, '/assets/stable/favicon.ico');
}, {priority: 100});

router.addRouter(apiRouter);
router.addRouter(cdnRouter);
router.addRouter(proxyRouter);
router.addRouter(stableRouter);


export default {
  fetch(request, env, ctx) {
    return router.onFetch(request, env, ctx);
  },
};
