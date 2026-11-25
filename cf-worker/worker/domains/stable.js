// files.gg: the new viewer and dashboard from web/dist (Workers static assets), the viewer shell
// with inlined boot data, the API passthrough, and the old frontend's pages (legacy shell).
// Routing order is web/README.md "Worker contract" §1; see classifyStablePath().

import { ApiError, ApiRedirect, DomainRouter } from 'cf-worker-router';

import { requestApi } from './api.js';
import { requestStorage } from './cdn.js';
import { internalLookup } from './internal.js';
import { DEFAULT_HOSTS, getHosts, hostPattern, isMainHost, originFor } from '../utils/hosts.js';
import { renderViewer, serveApp, serveStatic } from '../shell.js';
import { legacyMetatags, renderDocument } from '../utils/pages.js';
import { classifyStablePath, decideAlbumShell, decideFileShell } from '../utils/viewer.js';

export const STABLE_DOMAIN = hostPattern(DEFAULT_HOSTS.main, { www: true });
const legacyVersion = 'stable';

// The MAIN_HOST router (files.gg and www.files.gg by default); `hosts` is utils/hosts.js getHosts(env).
export function createRouter(hosts = DEFAULT_HOSTS) {
  const router = new DomainRouter(hostPattern(hosts.main, { www: true }));
  router.route('/*', '*', handle);
  return router;
}

export function isStableHost(hostname, hosts = DEFAULT_HOSTS) {
  return isMainHost(hostname, hosts);
}


// The old Mithril frontend, still the only place to log in, register, verify an email, reset a
// password or read the legal pages. Its bundle lives in the old GCS bucket.
async function renderLegacy(event) {
  const manifestResponse = await requestStorage(event, {
    method: 'GET',
    path: `/assets/${legacyVersion}/manifest.json`,
  });
  const manifest = (manifestResponse.ok) ? await manifestResponse.json() : null;
  const html = renderDocument({ manifest, metatags: legacyMetatags(event.url.pathname) });
  return new Response(html, {headers: {'content-type': 'text/html'}});
}

// /assets/*: web/dist first; the old frontend's files (GCS /assets/stable/*) as a fallback.
async function serveAssets(event) {
  const response = await serveStatic(event, { immutable: true });
  if (response) {
    return response;
  }
  const filename = encodeURIComponent(event.url.pathname.slice('/assets/'.length));
  return await requestStorage(event, `/assets/${legacyVersion}/${filename}`);
}

export async function serveRootFile(event) {
  return (await serveStatic(event, { immutable: false })) || new ApiError({ status: 404 });
}


async function handle(event) {
  const route = classifyStablePath(event.url.pathname);

  if (route.route === 'api') {
    return await requestApi(event, { path: route.path });
  }
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    return new ApiError({ status: 405 });
  }

  switch (route.route) {
    case 'root-file': return await serveRootFile(event);
    case 'asset': return await serveAssets(event);
    case 'app': return await serveApp(event);
    case 'home': return await renderViewer(event, { page: 'home', status: 200 });
    case 'convert': return await renderViewer(event, { page: 'convert', status: 200 });
    case 'legacy': return await renderLegacy(event);
    case 'album': {
      const lookup = await internalLookup(event, 'albums', route.vanity);
      return await renderViewer(event, decideAlbumShell({ lookup, vanity: route.vanity }));
    }
    case 'file': {
      const lookup = await internalLookup(event, 'files', route.vanity);
      const mainOrigin = originFor(getHosts(event.environment).main, event.url);
      const shell = decideFileShell({ lookup, vanity: route.vanity, headers: event.originalRequest.headers, mainOrigin });
      if (shell.redirect) {
        // Bots and embeds of `link` files go straight to the bytes (PLAN.md §1.4 item 3).
        return new ApiRedirect(shell.redirect);
      }
      return await renderViewer(event, shell);
    }
  }
  return new ApiError({ status: 404 });
}
