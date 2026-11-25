// files.gg: the viewer and dashboard from web/dist (Workers static assets), the viewer shell with
// inlined boot data, the API passthrough (the only route that forwards the session cookie,
// milestone-6.md §12), the auth redirects and the custom domains' Turnstile frame. Routing order is
// web/README.md "Worker contract" §1 and milestone-6.md §6.2; see classifyStablePath().

import { ApiError, ApiRedirect, DomainRouter } from 'cf-worker-router';

import { requestApi } from './api.js';
import { internalLookup } from './internal.js';
import { DEFAULT_HOSTS, getHosts, hostPattern, isMainHost, originFor } from '../utils/hosts.js';
import { renderChallenge, renderViewer, serveApp, serveSecurityTxt, serveStatic } from '../shell.js';
import { parseChallengeQuery } from '../utils/domains.js';
import { domainServing } from '../utils/owners.js';
import { classifyStablePath, decideAlbumShell, decideFileShell, publicPageHead } from '../utils/viewer.js';
import { botRefusalResponse } from '../utils/viewlimits.js';

export const STABLE_DOMAIN = hostPattern(DEFAULT_HOSTS.main, { www: true });

// The MAIN_HOST router (files.gg and www.files.gg by default); `hosts` is utils/hosts.js getHosts(env).
export function createRouter(hosts = DEFAULT_HOSTS) {
  const router = new DomainRouter(hostPattern(hosts.main, { www: true }));
  router.route('/*', '*', handle);
  return router;
}

export function isStableHost(hostname, hosts = DEFAULT_HOSTS) {
  return isMainHost(hostname, hosts);
}


// /assets/* (immutable) and the exact root files, from web/dist only.
async function serveFromDist(event, { immutable }) {
  return (await serveStatic(event, { immutable })) || new ApiError({ status: 404 });
}


// files.gg/challenge?host=<custom hostname>&action=unlock|report|view (milestone-6.md §10.10): only on
// MAIN_HOST itself (Turnstile's hostname is files.gg), and only for a serving custom domain.
// Anything else is a 404 that says nothing about the domain.
async function serveChallenge(event) {
  const hosts = getHosts(event.environment);
  const refused = () => {
    const response = new ApiError({ status: 404 });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  if (event.url.hostname !== hosts.main) {
    return refused();
  }
  const query = parseChallengeQuery(event.url.searchParams, hosts);
  if (!query) {
    return refused();
  }
  const lookup = await internalLookup(event, 'domains', query.host);
  if (lookup.status === 'unavailable') {
    const response = new ApiError({ status: 503 });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
  const domain = (lookup.status === 'found' && lookup.data) ? lookup.data.domain : null;
  if (!domainServing(domain) || String(domain.hostname || '').toLowerCase() !== query.host) {
    return refused();
  }
  return await renderChallenge(event, { ...query, frameAncestor: originFor(query.host, event.url) });
}


const mainOriginOf = (event) => originFor(getHosts(event.environment).main, event.url);


async function handle(event) {
  const route = classifyStablePath(event.url.pathname);

  if (route.route === 'api') {
    return await requestApi(event, { path: route.path });
  }
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    return new ApiError({ status: 405 });
  }

  switch (route.route) {
    case 'root-file': return await serveFromDist(event, { immutable: false });
    case 'asset': return await serveFromDist(event, { immutable: true });
    case 'app': return await serveApp(event);
    // The home page: the dashboard entry's, with the upload box (a public page, like /convert).
    case 'home': return await serveApp(event, publicPageHead('home', { mainOrigin: mainOriginOf(event) }));
    // /convert (milestone-5.md §11), /changelog, /legal/terms, /legal/privacy (§19.1) and /help/link-warnings
    // (milestone-7.md §7): the dashboard entry's public pages, with their own title and description. No lookup.
    case 'page': return await serveApp(event, publicPageHead(route.page, { mainOrigin: mainOriginOf(event) }));
    // /login, /register, /signup: the dashboard's auth pages, 308 (milestone-6.md §6.2); /legal: 302
    // to the Terms (milestone-5.md §19.1). The query is kept.
    case 'redirect': return new ApiRedirect(route.location + event.url.search, { status: route.status });
    case 'challenge': return await serveChallenge(event);
    // Report pages: always 200, no lookup, the default meta tags (milestone-4.md §10.1). They never
    // say whether the target exists; the API answers that when the form is sent.
    case 'report': return await renderViewer(event, { page: 'report', dataId: 'report-data', data: route.data, status: 200, cacheControl: 'no-cache' });
    case 'security-txt': return (await serveSecurityTxt(event)) || new ApiError({ status: 404 });
    // A vanity with a reserved segment (`report`) can't exist: missing, without a lookup.
    case 'missing': return await renderViewer(event, { page: 'file', state: 'missing', dataId: 'file-data', data: null, status: 404 });
    case 'album': {
      const lookup = await internalLookup(event, 'albums', route.vanity);
      return await renderViewer(event, decideAlbumShell({ lookup, vanity: route.vanity }));
    }
    case 'file': {
      const lookup = await internalLookup(event, 'files', route.vanity);
      const shell = decideFileShell({ lookup, vanity: route.vanity, headers: event.originalRequest.headers, mainOrigin: mainOriginOf(event) });
      if (shell.redirect) {
        // ShareX, Telegram and embeds of `link` files go straight to cdn_url (PLAN.md §1.4 item 3).
        return new ApiRedirect(shell.redirect);
      }
      if (shell.refuse) {
        // A link-preview bot asking for a view-limited file (milestone-6.md §19.5): 403, no og media.
        return botRefusalResponse(event.method);
      }
      return await renderViewer(event, shell);
    }
  }
  return new ApiError({ status: 404 });
}
