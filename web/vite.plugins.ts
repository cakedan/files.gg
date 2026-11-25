import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Connect, Plugin } from 'vite';

import { mockApiMiddleware } from './mock-api.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.icc': 'application/vnd.iccprofile',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
};

/** Serves one file with HTTP Range support (pdf.js range loading needs it). */
function sendFile(req: Connect.IncomingMessage, res: ServerResponse, path: string): void {
  const { size } = statSync(path);
  res.setHeader('Content-Type', CONTENT_TYPES[extname(path)] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', String(size));
  createReadStream(path).pipe(res);
}

/** Resolves `relative` inside `root`, refusing path traversal. */
function safeJoin(root: string, relative: string): string | null {
  const path = normalize(join(root, decodeURIComponent(relative)));
  if (!path.startsWith(root + sep)) return null;
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** The dashboard entry's public pages: the home page, and milestone-5 §11 and §19.1's. */
const APP_PUBLIC_PAGES = /^\/(|convert|changelog|legal|legal\/terms|legal\/privacy)\/?$/;

/**
 * Mirrors the production routing in dev and preview:
 *   /app, /app/*            -> app.html     (the dashboard SPA)
 *   /, /convert, /changelog, /legal, /legal/terms, /legal/privacy -> app.html (its public pages, milestone-5
 *                              §11, §19.1; the Worker answers /legal with a 302, the dev server leaves it to the app)
 *   /challenge              -> challenge.html (the Turnstile frame for custom domains)
 *   /a/<vanity>             -> viewer.html  (album page; the lightbox item is ?item=<n>)
 *   /report/<vanity>, /report/a/<vanity> -> viewer.html (report pages, milestone-6 §20.2)
 */
export function routeEntries(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? '/';
    const [pathname = '/', search = ''] = url.split(/(?=\?)/, 2);
    if (pathname === '/app' || (pathname.startsWith('/app/') && !pathname.includes('.')) || APP_PUBLIC_PAGES.test(pathname)) {
      req.url = `/app.html${search}`;
    } else if (pathname === '/challenge') {
      // Before the bare-vanity rule, which would match it. `challenge` is a reserved vanity.
      req.url = `/challenge.html${search}`;
    } else if (
      /^\/a\/[^/.]+\/?$/.test(pathname) ||
      pathname.startsWith('/report/') ||
      // A bare vanity (no extension), e.g. /private123 for owner-pass testing.
      /^\/[a-z0-9]{3,}$/i.test(pathname)
    ) {
      req.url = `/viewer.html${search}`;
    }
    next();
  };
  return {
    name: 'filesgg:route-entries',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

/** Dev only: serves web/fixtures/ at /fixtures/, with Range support. Never part of a build. */
export function devFixtures(): Plugin {
  const root = here('./fixtures');
  return {
    name: 'filesgg:dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/fixtures/', (req, res, next) => {
        const path = safeJoin(root, (req.url ?? '').split('?')[0] ?? '');
        if (!path) return next();
        sendFile(req, res, path);
      });
    },
  };
}

const PDFJS_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

/**
 * pdf.js data files (CMaps, standard fonts, wasm decoders, ICC profiles), served
 * same-origin under /assets/pdfjs/<version>/. The viewer fetches them only when a
 * PDF needs them. Emitted into the build; served from node_modules in dev.
 */
export function pdfjsAssets(): Plugin {
  const pkgRoot = here('./node_modules/pdfjs-dist');
  const { version } = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };
  const base = `assets/pdfjs/${version}`;
  return {
    name: 'filesgg:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use(`/${base}/`, (req, res, next) => {
        const path = safeJoin(pkgRoot, (req.url ?? '').split('?')[0] ?? '');
        if (!path || !PDFJS_DIRS.some((dir) => path.startsWith(join(pkgRoot, dir) + sep))) return next();
        sendFile(req, res, path);
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS) {
        for (const name of readdirSync(join(pkgRoot, dir))) {
          if (name.endsWith('.js')) continue; // nowasm fallbacks: wasm is always available
          this.emitFile({
            type: 'asset',
            fileName: `${base}/${dir}/${name}`,
            source: readFileSync(join(pkgRoot, dir, name)),
          });
        }
      }
    },
  };
}

/** Dev only: the in-memory Milestone 2 API (mock-api.ts) at /__mock-api. */
export function mockApi(): Plugin {
  return {
    name: 'filesgg:mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(mockApiMiddleware());
    },
  };
}
