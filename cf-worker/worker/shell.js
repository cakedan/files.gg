// Serves web/dist (Workers static assets, the ASSETS binding) and renders the viewer shell:
// HTMLRewriter sets the #root attributes, inserts the escaped boot JSON after #root, and replaces
// the default meta tags between the filesgg:meta markers (web/README.md "Worker contract").

import { MINIMAL_PAGE_CSP, minimalPage, rehost } from './utils/domains.js';
import { getHosts, publicOrigins } from './utils/hosts.js';
import { appCsp, challengeCsp, customViewerCsp, escapeJsonForHtml, viewerCsp } from './utils/viewer.js';

const HTML_TYPE = 'text/html; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ROOT_FILE_CACHE = 'public, max-age=86400';

// Types module workers and wasm streaming insist on, whatever the asset server guesses.
const FORCED_TYPES = Object.freeze({
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
});


// `passthrough`: forward the client's method and headers (conditional requests for static
// files), but never its cookies. The shells are always fetched with a plain GET, since they are
// rewritten.
export async function fetchAsset(event, pathname, { passthrough = false } = {}) {
  const assets = event.environment && event.environment.ASSETS;
  if (!assets) {
    return new Response('Static assets are not configured', { status: 500 });
  }
  const url = new URL(event.url);
  url.pathname = pathname;
  url.search = '';
  let init = { method: 'GET' };
  if (passthrough) {
    const headers = new Headers(event.originalRequest.headers);
    headers.delete('cookie');
    init = { method: event.method === 'HEAD' ? 'HEAD' : 'GET', headers };
  }
  return await assets.fetch(new Request(url, init));
}

function withHeaders(response, headers) {
  response = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

// /assets/* (hashed, so immutable) and the exact root files. Returns null when it doesn't exist.
export async function serveStatic(event, { immutable }) {
  const response = await fetchAsset(event, event.url.pathname, { passthrough: true });
  if (response.status === 404) {
    return null;
  }
  const headers = {};
  if (response.ok) {
    headers['Cache-Control'] = immutable ? IMMUTABLE : ROOT_FILE_CACHE;
    const extension = (event.url.pathname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    if (FORCED_TYPES[extension]) {
      headers['Content-Type'] = FORCED_TYPES[extension];
    }
  }
  headers['X-Content-Type-Options'] = 'nosniff';
  return withHeaders(response, headers);
}

// /.well-known/security.txt from web/dist (milestone-4.md §10.4), on files.gg and cdn.files.gg
// (where index.js adds the CDN security headers). Always text/plain; charset=utf-8. Returns null
// when web/dist doesn't have it.
export const SECURITY_TXT_TYPE = 'text/plain; charset=utf-8';
export async function serveSecurityTxt(event) {
  const response = await serveStatic(event, { immutable: false });
  if (response && response.ok) {
    response.headers.set('Content-Type', SECURITY_TXT_TYPE);
  }
  return response;
}

// /app and /app/*: the dashboard SPA. With `head` ({ title, meta }, utils/viewer.js publicPageHead), one of
// its public pages outside /app (milestone-5.md §11, §19.1).
export async function serveApp(event, head = null) {
  let response = await fetchAsset(event, '/app.html');
  if (!response.ok) {
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (head) {
    // A public page (milestone-5.md §19.1): its own <title> and meta tags instead of the dashboard's,
    // and indexable (the dashboard's `robots: noindex` goes).
    const remove = { element(meta) { meta.remove(); } };
    response = new HTMLRewriter()
      .on('title', { element(title) { title.setInnerContent(head.title); } })
      .on('meta[name="robots"]', remove)
      .on('meta[name="description"]', remove)
      .on('meta[property^="og:"]', remove)
      .on('meta[name^="twitter:"]', remove)
      .on('head', { element(element) { element.append(head.meta, { html: true }); } })
      .transform(response);
  }
  return new Response(event.method === 'HEAD' ? null : response.body, {
    status: 200,
    headers: {
      'Content-Type': HTML_TYPE,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // A strict policy (PLAN.md "Hardening"): scripts only from files.gg and Turnstile. The signed-in dashboard
      // (deletes, access changes, passwords) is never framed: clickjacking.
      'Content-Security-Policy': appCsp(publicOrigins(getHosts(event.environment), event.url)),
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}


const META_START = /^\s*filesgg:meta:start\b/;
const META_END = /^\s*filesgg:meta:end\b/;

// shell: { page, state?, dataId?, data?, meta?, status, cacheControl? } from utils/viewer.js.
// `site`: null on files.gg; on a custom domain (milestone-6.md §10.8, §13.4) { host, origin,
// rehostFrom }, which adds `data-host="custom"` and `#host-data`, rehosts the meta tags' URLs and
// uses the custom-domain CSP. Its boot data is rehosted by the caller.
export async function renderViewer(event, shell, site = null) {
  const asset = await fetchAsset(event, '/viewer.html');
  if (!asset.ok) {
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
  const origins = publicOrigins(getHosts(event.environment), event.url);

  let rewriter = new HTMLRewriter().on('#root', {
    element(root) {
      root.setAttribute('data-page', shell.page);
      if (shell.state) {
        root.setAttribute('data-state', shell.state);
      }
      if (site) {
        root.setAttribute('data-host', 'custom');
      }
      let after = '';
      if (shell.dataId) {
        after += `<script id="${shell.dataId}" type="application/json">${escapeJsonForHtml(shell.data)}</script>`;
      }
      if (site) {
        const hostData = { host: site.host, main_origin: origins.main, api_origin: origins.api };
        after += `<script id="host-data" type="application/json">${escapeJsonForHtml(hostData)}</script>`;
      }
      if (after) {
        root.after(after, { html: true });
      }
    },
  });

  if (typeof(shell.meta) === 'string') {
    // Everything between the markers goes; the file's own tags go right after the start marker.
    let inside = false;
    rewriter = rewriter
      .onDocument({
        comments(comment) {
          if (META_START.test(comment.text)) {
            inside = true;
            comment.after(shell.meta, { html: true });
          } else if (META_END.test(comment.text)) {
            inside = false;
          } else if (inside) {
            comment.remove();
          }
        },
        text(text) {
          if (inside) {
            text.remove();
          }
        },
      })
      .on('*', {
        element(element) {
          if (inside) {
            element.remove();
          }
        },
      });
  }

  if (site) {
    // Every meta tag's URL, the default ones in viewer.html included (og:image), on the custom
    // origin (§10.9). Tags inserted above were made from rehosted data already.
    rewriter = rewriter.on('meta[content]', {
      element(element) {
        const content = element.getAttribute('content');
        const rehosted = rehost(content, site.rehostFrom, site.origin);
        if (rehosted !== content) {
          element.setAttribute('content', rehosted);
        }
      },
    });
  }

  const body = (event.method === 'HEAD') ? null : rewriter.transform(asset).body;
  return new Response(body, {
    status: shell.status,
    headers: {
      'Content-Type': HTML_TYPE,
      'Cache-Control': shell.cacheControl || 'no-cache',
      'Content-Security-Policy': (site) ? customViewerCsp(origins) : viewerCsp(origins),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}


// files.gg/challenge (milestone-6.md §10.10): web/dist/challenge.html with `#challenge-data`
// ({ host, action }) as the first child of <body>, framable only by `frameAncestor` (the custom
// domain's origin). Never cached. The page makes no API calls.
export async function renderChallenge(event, { host, action, frameAncestor }) {
  const asset = await fetchAsset(event, '/challenge.html');
  if (!asset.ok) {
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
  const data = `<script id="challenge-data" type="application/json">${escapeJsonForHtml({ host, action })}</script>`;
  const rewriter = new HTMLRewriter().on('body', {
    element(body) {
      body.prepend(data, { html: true });
    },
  });
  return new Response((event.method === 'HEAD') ? null : rewriter.transform(asset).body, {
    status: 200,
    headers: {
      'Content-Type': HTML_TYPE,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': challengeCsp(frameAncestor),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}


// A tiny page with one sentence and no branding beyond "files.gg" (the custom-domain "isn't
// connected" page, milestone-6.md §10.8 step 2).
export function renderMinimalPage(event, { message, status, cacheControl }) {
  return new Response((event.method === 'HEAD') ? null : minimalPage(message), {
    status,
    headers: {
      'Content-Type': HTML_TYPE,
      'Cache-Control': cacheControl,
      'Content-Security-Policy': MINIMAL_PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
