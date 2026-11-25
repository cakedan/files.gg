// Serves web/dist (Workers static assets, the ASSETS binding) and renders the viewer shell:
// HTMLRewriter sets the #root attributes, inserts the escaped boot JSON after #root, and replaces
// the default meta tags between the filesgg:meta markers (web/README.md "Worker contract").

import { getHosts, publicOrigins } from './utils/hosts.js';
import { escapeJsonForHtml, viewerCsp } from './utils/viewer.js';

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
// files). The shells are always fetched with a plain GET, since they are rewritten.
export async function fetchAsset(event, pathname, { passthrough = false } = {}) {
  const assets = event.environment && event.environment.ASSETS;
  if (!assets) {
    return new Response('Static assets are not configured', { status: 500 });
  }
  const url = new URL(event.url);
  url.pathname = pathname;
  url.search = '';
  const init = (passthrough)
    ? { method: event.method === 'HEAD' ? 'HEAD' : 'GET', headers: event.originalRequest.headers }
    : { method: 'GET' };
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

// /app and /app/*: the dashboard SPA.
export async function serveApp(event) {
  const response = await fetchAsset(event, '/app.html');
  if (!response.ok) {
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
  return new Response(event.method === 'HEAD' ? null : response.body, {
    status: 200,
    headers: {
      'Content-Type': HTML_TYPE,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}


const META_START = /^\s*filesgg:meta:start\b/;
const META_END = /^\s*filesgg:meta:end\b/;

// shell: { page, state?, dataId?, data?, meta?, status, cacheControl? } from utils/viewer.js.
export async function renderViewer(event, shell) {
  const asset = await fetchAsset(event, '/viewer.html');
  if (!asset.ok) {
    return new Response('Unavailable', { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }

  let rewriter = new HTMLRewriter().on('#root', {
    element(root) {
      root.setAttribute('data-page', shell.page);
      if (shell.state) {
        root.setAttribute('data-state', shell.state);
      }
      if (shell.dataId) {
        root.after(
          `<script id="${shell.dataId}" type="application/json">${escapeJsonForHtml(shell.data)}</script>`,
          { html: true },
        );
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

  const body = (event.method === 'HEAD') ? null : rewriter.transform(asset).body;
  return new Response(body, {
    status: shell.status,
    headers: {
      'Content-Type': HTML_TYPE,
      'Cache-Control': shell.cacheControl || 'no-cache',
      'Content-Security-Policy': viewerCsp(publicOrigins(getHosts(event.environment), event.url)),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}
