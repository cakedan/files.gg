// Custom domains (docs/redesign/contracts/milestone-6.md §10.8-§10.11): every hostname that isn't
// MAIN_HOST (or www.), CDN_HOST or API_HOST. Cloudflare for SaaS sends customers'
// hostnames to the Worker through the zone's `*/*` route (Worker as origin).
//
// Per request:
//   1. Cloudflare's validation paths (/.well-known/acme-challenge/ etc.) go straight to the origin.
//   2. The domain lookup (5 s cache). Unknown, deleted or not serving: the "isn't connected" page.
//   3. The path: the landing card, viewer and album shells, report pages, the CDN's byte paths
//      (with every cdn.files.gg rule), and web/dist's assets and root files. Nothing else.
//   4-6. In domains/cdn.js and utils/viewer.js: the domain's scope, the owner's pending deletion,
//      then exactly the files.gg and cdn.files.gg decisions. `served_on` is ignored here.
//
// No cookie ever goes upstream from here, and responses never set one (the router's
// beforeResponse, createCustomRouter below). Payload URLs are rehosted onto the domain (§10.9).

import { ApiError, ApiRedirect, DomainRouter, FetchRouter } from 'cf-worker-router';

import { applyCdnSecurityHeaders, serveCdnPath } from './cdn.js';
import { internalLookup } from './internal.js';
import { renderMinimalPage, renderViewer, serveStatic } from '../shell.js';
import { filterSetCookies } from '../utils/cookies.js';
import {
  classifyCustomPath,
  CUSTOM_HSTS,
  isCustomHostname,
  NOT_CONNECTED_MESSAGE,
  rehostDeep,
  rehostSources,
  UNAVAILABLE_MESSAGE,
} from '../utils/domains.js';
import { getHosts, originFor, publicOrigins } from '../utils/hosts.js';
import { domainServing } from '../utils/owners.js';
import { adultBlockedFor } from '../utils/region.js';
import { CDN_EXPOSE_HEADERS, corsHeaders } from '../utils/security.js';
import { decideAlbumShell, decideFileShell } from '../utils/viewer.js';
import { botRefusalResponse } from '../utils/viewlimits.js';

const PAGE_METHODS = ['GET', 'HEAD'];
const CDN_METHODS = ['GET', 'HEAD', 'OPTIONS'];
// For responses that don't set their own (router errors, plain 404s): nothing may run or frame.
const FALLBACK_CSP = "default-src 'none'; frame-ancestors 'none'";


// §10.8 step 1: passed through without the client's cookies, so Cloudflare's own HTTP DCV and
// hostname validation are never answered by the Worker.
async function passToOrigin(event) {
  const request = new Request(event.originalRequest);
  request.headers.delete('cookie');
  return await fetch(request);
}

function notConnected(event) {
  return renderMinimalPage(event, { message: NOT_CONNECTED_MESSAGE, status: 404, cacheControl: 'no-cache' });
}

function notFound() {
  const response = new ApiError({ status: 404 });
  response.headers.set('Cache-Control', 'no-cache');
  return response;
}

// The domain lookup for this request's hostname, as { domain } (serving) or { response }.
async function lookupDomain(event, hosts) {
  const host = event.url.hostname;
  if (!isCustomHostname(host, hosts)) {
    return { response: notConnected(event) };
  }
  const lookup = await internalLookup(event, 'domains', host);
  if (lookup.status === 'unavailable') {
    return { response: renderMinimalPage(event, { message: UNAVAILABLE_MESSAGE, status: 503, cacheControl: 'private, no-store' }) };
  }
  const domain = (lookup.status === 'found' && lookup.data) ? lookup.data.domain : null;
  // The lookup must be for this exact hostname, and serving (§10.5: active or failing, premium,
  // and the owner's account active).
  if (!domainServing(domain) || String(domain.hostname || '').toLowerCase() !== host) {
    return { response: notConnected(event) };
  }
  return { domain };
}

// The site handed to the shells and the CDN: the domain, its origin, and the origins whose URLs
// are rehosted onto it.
function siteFor(event, hosts, domain) {
  const host = event.url.hostname;
  return {
    kind: 'custom',
    host,
    domain,
    origin: originFor(host, event.url),
    rehostFrom: rehostSources(hosts, publicOrigins(hosts, event.url)),
  };
}

function rehostLookup(lookup, site) {
  return (lookup.status === 'found') ? { ...lookup, data: rehostDeep(lookup.data, site.rehostFrom, site.origin) } : lookup;
}


async function handle(event) {
  const hosts = getHosts(event.environment);
  const route = classifyCustomPath(event.url.pathname);
  if (route.route === 'dcv') {
    return await passToOrigin(event);
  }

  // The lookup comes first, so an unknown hostname is the same clean 404 whatever the method.
  const { domain, response } = await lookupDomain(event, hosts);
  if (response) {
    return response;
  }
  const site = siteFor(event, hosts, domain);

  if (route.route === 'cdn') {
    if (!CDN_METHODS.includes(event.method)) {
      return new ApiError({ status: 405 });
    }
    return await serveCdnPath(event, site);
  }
  if (!PAGE_METHODS.includes(event.method)) {
    return new ApiError({ status: 405 });
  }

  switch (route.route) {
    case 'root-file': return (await serveStatic(event, { immutable: false })) || notFound();
    case 'asset': return (await serveStatic(event, { immutable: true })) || notFound();
    // The landing card (§10.8, §13.4): "Files hosted with files.gg" and a Report link.
    case 'home': return await renderViewer(event, { page: 'domain-home', status: 200 }, site);
    case 'report': return await renderViewer(event, { page: 'report', dataId: 'report-data', data: route.data, status: 200, cacheControl: 'no-cache' }, site);
    case 'missing': return await renderViewer(event, { page: 'file', state: 'missing', dataId: 'file-data', data: null, status: 404 }, site);
    case 'album': {
      const lookup = rehostLookup(await internalLookup(event, 'albums', route.vanity), site);
      const adultBlocked = adultBlockedFor(event.environment, event.originalRequest);
      return await renderViewer(event, decideAlbumShell({ lookup, vanity: route.vanity, domain, adultBlocked }), site);
    }
    case 'file': {
      const lookup = rehostLookup(await internalLookup(event, 'files', route.vanity), site);
      const shell = decideFileShell({
        lookup, vanity: route.vanity, headers: event.originalRequest.headers, mainOrigin: site.origin, domain,
        adultBlocked: adultBlockedFor(event.environment, event.originalRequest),
      });
      if (shell.redirect) {
        // Bots and embeds of `link` files: the rehosted cdn_url, https://<host>/files/<vanity>.<ext>.
        return new ApiRedirect(shell.redirect);
      }
      if (shell.refuse) {
        // A link-preview bot asking for a view-limited file (milestone-6.md §19.5): 403, no og media.
        return botRefusalResponse(event.method);
      }
      return await renderViewer(event, shell, site);
    }
  }
  return notFound();
}


// The custom-host router. Its beforeResponse is the cookie and header policy of §10.11 for every
// response, errors included.
export function createCustomRouter(hosts) {
  const router = new FetchRouter();
  router.beforeResponse = (response, event) => {
    response = new Response(response.body, response);
    // No cookies on custom domains, whatever upstream (the DCV origin) said.
    filterSetCookies(response.headers, null);
    response.headers.delete('access-control-allow-credentials');
    response.headers.set('Strict-Transport-Security', CUSTOM_HSTS);
    response.headers.set('X-Content-Type-Options', 'nosniff');

    const route = classifyCustomPath(event.url.pathname);
    if (route.route === 'cdn') {
      // Exactly the cdn.files.gg headers (§10.11): the sandbox (framable by MAIN_HOST only), CORS
      // `*` and the exposed range headers.
      applyCdnSecurityHeaders(response, { mainOrigin: originFor(hosts.main, event.url) });
      const cors = corsHeaders();
      for (const name in cors) {
        response.headers.set(name, cors[name]);
      }
      response.headers.set('Access-Control-Expose-Headers', CDN_EXPOSE_HEADERS);
    } else if (route.route !== 'dcv' && !response.headers.has('content-security-policy')) {
      response.headers.set('Content-Security-Policy', FALLBACK_CSP);
    }
    return response;
  };
  const domains = new DomainRouter('[^/]+', 'custom-hosts');
  domains.route('/*', '*', handle);
  router.addRouter(domains);
  return router;
}
