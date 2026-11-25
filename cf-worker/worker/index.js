import { FetchRouter } from 'cf-worker-router';

import {
  createApiRouter,
  createCdnRouter,
  createCustomRouter,
  createStableRouter,
} from './domains/index.js';

import { applyCdnSecurityHeaders } from './domains/cdn.js';
import { filterSetCookies, sessionCookieName } from './utils/cookies.js';
import { isOwnHost } from './utils/domains.js';
import { DEFAULT_HOSTS, getHosts, isMainHost, originFor } from './utils/hosts.js';
import { CDN_EXPOSE_HEADERS, corsHeaders } from './utils/security.js';


// files.gg/api and files.gg/api/*: the only responses that may set a cookie (the session cookie).
function isMainApi(hostname, pathname, hosts) {
  return isMainHost(hostname, hosts) && (pathname === '/api' || pathname.startsWith('/api/'));
}


// One router per set of hostnames (MAIN_HOST, CDN_HOST, API_HOST; utils/hosts.js).
// A deployment only ever has one, so this builds a single router per isolate.
function createRouter(hosts) {
  const router = new FetchRouter();

  router.beforeResponse = (response, event) => {
    const { hostname, pathname } = event.url;
    const origin = event.originalRequest.headers.get('origin');
    const isCdn = (hostname === hosts.cdn);

    // Copy: responses from fetch() have immutable headers.
    response = new Response(response.body, response);

    // Cookies (milestone-6.md §12 item 1): only the API's Set-Cookie for the session cookie, and
    // only on files.gg/api/*. Every other response (api.files.gg included) sets none.
    filterSetCookies(response.headers, isMainApi(hostname, pathname, hosts) ? sessionCookieName(event.environment) : null);
    // Never credentialed CORS (§12 item 2), whatever the API sent.
    response.headers.delete('access-control-allow-credentials');

    // CDN bytes always carry CORS `*` (pdf.js and canvas on files.gg fetch them, and the browser
    // cache must not keep a copy without it). Elsewhere, only cross-origin requests get CORS
    // headers, and always `*`.
    if (origin || isCdn) {
      const headers = corsHeaders();
      for (const name in headers) {
        response.headers.set(name, headers[name]);
      }
    }

    // Every cdn.files.gg response, including 404s, 405s and 500s, is sandboxed.
    if (isCdn) {
      applyCdnSecurityHeaders(response, { mainOrigin: originFor(hosts.main, event.url) });
      response.headers.set('Access-Control-Expose-Headers', CDN_EXPOSE_HEADERS);
    }
    return response;
  };

  router.addRouter(createApiRouter(hosts));
  router.addRouter(createCdnRouter(hosts));
  router.addRouter(createStableRouter(hosts));
  return router;
}

// { own, custom } routers per set of hostnames: `own` for our three hosts (and www.), `custom` for every other
// hostname (customers' domains, milestone-6.md §10.8).
const routers = new Map();
function routersFor(hosts) {
  const key = [hosts.main, hosts.cdn, hosts.api].join('\n');
  let entry = routers.get(key);
  if (!entry) {
    entry = { own: createRouter(hosts), custom: createCustomRouter(hosts) };
    routers.set(key, entry);
  }
  return entry;
}

export const router = routersFor(DEFAULT_HOSTS).own;


export default {
  fetch(request, env, ctx) {
    const hosts = getHosts(env);
    const { own, custom } = routersFor(hosts);
    const hostname = new URL(request.url).hostname;
    return (isOwnHost(hostname, hosts) ? own : custom).onFetch(request, env, ctx);
  },
};
