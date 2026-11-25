// files.gg: the viewer and dashboard from web/dist (Workers static assets), the viewer shell with
// inlined boot data, and the API passthrough. Routing order is web/README.md "Worker contract" §1;
// see classifyStablePath().

import { ApiError, ApiRedirect, DomainRouter } from 'cf-worker-router';

import { requestApi } from './api.js';
import { internalLookup } from './internal.js';
import { DEFAULT_HOSTS, getHosts, hostPattern, isMainHost, originFor } from '../utils/hosts.js';
import { renderViewer, serveApp, serveStatic } from '../shell.js';
import { classifyStablePath, decideAlbumShell, decideFileShell } from '../utils/viewer.js';

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
    case 'home': return await renderViewer(event, { page: 'home', status: 200 });
    case 'convert': return await renderViewer(event, { page: 'convert', status: 200 });
    case 'album': {
      const lookup = await internalLookup(event, 'albums', route.vanity);
      return await renderViewer(event, decideAlbumShell({ lookup, vanity: route.vanity }));
    }
    case 'file': {
      const lookup = await internalLookup(event, 'files', route.vanity);
      const mainOrigin = originFor(getHosts(event.environment).main, event.url);
      const shell = decideFileShell({ lookup, vanity: route.vanity, headers: event.originalRequest.headers, mainOrigin });
      if (shell.redirect) {
        // ShareX, Telegram and embeds of `link` files go straight to cdn_url (PLAN.md §1.4 item 3).
        return new ApiRedirect(shell.redirect);
      }
      return await renderViewer(event, shell);
    }
  }
  return new ApiError({ status: 404 });
}
