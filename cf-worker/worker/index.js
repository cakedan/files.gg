import { FetchRouter } from 'cf-worker-router';

import {
  createApiRouter,
  createCdnRouter,
  createProxyRouter,
  createStableRouter,
} from './domains/index.js';

import { applyCdnSecurityHeaders, requestStorage } from './domains/cdn.js';
import { serveRootFile } from './domains/stable.js';
import { getStringBinding } from './utils/env.js';
import { DEFAULT_HOSTS, getHosts, isMainHost, originFor } from './utils/hosts.js';
import { CDN_EXPOSE_HEADERS, corsHeaders, isCredentialedRoute, parseAllowedOrigins } from './utils/security.js';


// Origins allowed to make credentialed API requests: the comma-separated CORS_ALLOWED_ORIGINS var
// (see cf-worker/README.md). Defaults to the MAIN_HOST origin (https://files.gg). Parsed once per
// distinct value.
let allowedOriginsCache = { key: null, origins: null };
function getAllowedOrigins(env, mainOrigin) {
  const raw = getStringBinding(env, 'CORS_ALLOWED_ORIGINS') || null;
  const key = `${raw}\n${mainOrigin}`;
  if (key !== allowedOriginsCache.key) {
    allowedOriginsCache = { key, origins: parseAllowedOrigins(raw || undefined, [mainOrigin]) };
  }
  return allowedOriginsCache.origins;
}


// One router per set of hostnames (MAIN_HOST, CDN_HOST, API_HOST, PROXY_HOST; utils/hosts.js).
// A deployment only ever has one, so this builds a single router per isolate.
function createRouter(hosts) {
  const router = new FetchRouter();

  router.beforeResponse = (response, event) => {
    const { hostname, pathname } = event.url;
    const origin = event.originalRequest.headers.get('origin');
    const isCdn = (hostname === hosts.cdn);
    if (!origin && !isCdn) {
      return response;
    }

    // Copy: responses from fetch() have immutable headers.
    response = new Response(response.body, response);

    // CDN bytes always carry CORS `*` (pdf.js and canvas on files.gg fetch them, and the browser
    // cache must not keep a copy without it). Elsewhere, only cross-origin requests get CORS headers.
    const mainOrigin = originFor(hosts.main, event.url);
    const headers = corsHeaders({
      allowedOrigins: getAllowedOrigins(event.environment, mainOrigin),
      credentialed: isCredentialedRoute(hostname, pathname, hosts),
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
      applyCdnSecurityHeaders(response, { mainOrigin });
      response.headers.set('Access-Control-Expose-Headers', CDN_EXPOSE_HEADERS);
    }
    return response;
  };

  // files.gg serves its favicon from web/dist; the other hosts keep the old one from storage.
  router.route('/favicon.ico', '*', (event) => {
    if (isMainHost(event.url.hostname, hosts)) {
      return serveRootFile(event);
    }
    return requestStorage(event, '/assets/stable/favicon.ico');
  }, {priority: 100});

  router.addRouter(createApiRouter(hosts));
  router.addRouter(createCdnRouter(hosts));
  router.addRouter(createProxyRouter(hosts));
  router.addRouter(createStableRouter(hosts));
  return router;
}

const routers = new Map();
function routerFor(hosts) {
  const key = [hosts.main, hosts.cdn, hosts.api, hosts.proxy].join('\n');
  let router = routers.get(key);
  if (!router) {
    router = createRouter(hosts);
    routers.set(key, router);
  }
  return router;
}

export const router = routerFor(DEFAULT_HOSTS);


export default {
  fetch(request, env, ctx) {
    return routerFor(getHosts(env)).onFetch(request, env, ctx);
  },
};
