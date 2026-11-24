// Runs the real Worker (wrangler.toml, bundled by wrangler, in workerd) with wrangler's
// createTestHarness, against a local mock of the API and the storage bucket.
import http from 'node:http';

import { cases } from './fixtures.js';

process.env.WRANGLER_SEND_METRICS = 'false';
const { createTestHarness } = await import('wrangler');

const CONFIG_PATH = new URL('../../wrangler.toml', import.meta.url);


// Storage objects by path: [content-type, body].
const STORAGE = {
  '/assets/stable/favicon.ico': ['image/x-icon', 'ICO'],
  '/assets/stable/main.css': ['text/css', 'body{}'],
  '/assets/stable/evil.html': ['text/html', '<script>alert(1)</script>'],
};
for (const file of Object.values(cases.files)) {
  STORAGE['/files/' + file.hash] = [file.mimetype, `bytes of ${file.filename}`];
}


// One HTTP server plays the API origin, the storage bucket and any URL the proxy fetches.
// `requests` records everything the Worker sent upstream.
export async function startUpstream() {
  const state = { requests: [], noManifest: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      const url = new URL(req.url, 'http://upstream');
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });
      const send = (status, type, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(payload);
      };

      // API: file lookups.
      if (url.pathname.startsWith('/files/') && !STORAGE[url.pathname]) {
        const file = cases.files[decodeURIComponent(url.pathname.slice('/files/'.length))];
        return (file)
          ? send(200, 'application/json', JSON.stringify(file))
          : send(404, 'application/json', JSON.stringify({ status: 404, message: 'Unknown File' }));
      }
      // API: anything else echoes, with the Flask app's own (too loose) CORS headers.
      if (url.pathname.startsWith('/users/') || url.pathname === '/auth/login') {
        return send(200, 'application/json', JSON.stringify({ path: url.pathname, method: req.method }), {
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
        });
      }
      // Storage.
      if (url.pathname === '/assets/stable/manifest.json') {
        return (state.noManifest)
          ? send(403, 'application/xml', '<Error>AccessDenied</Error>')
          : send(200, 'application/json', JSON.stringify(cases.manifest));
      }
      if (STORAGE[url.pathname]) {
        const [type, payload] = STORAGE[url.pathname];
        return send(200, type, payload, { 'x-goog-generation': '1', 'accept-ranges': 'bytes' });
      }
      // Pages the proxy fetches.
      if (url.pathname === '/remote/page.html') {
        return send(200, 'text/html', '<html><head><meta property="og:image" content="/img.png"></head></html>');
      }
      if (url.pathname === '/remote/img.png') {
        return send(200, 'image/png', 'PNG');
      }
      // The bucket answers 403 for objects that don't exist.
      return send(403, 'application/xml', '<Error>AccessDenied</Error>');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}


export async function startWorker(upstream, { secrets = {}, vars = {} } = {}) {
  const harness = createTestHarness({
    workers: [{
      configPath: CONFIG_PATH,
      vars: { API_ORIGIN: upstream.origin, STORAGE_ORIGIN: upstream.origin, ...vars },
      secrets,
    }],
  });
  const { url } = await harness.listen();

  // Raw HTTP so the test controls every request header (fetch() would add Accept,
  // Accept-Language and User-Agent, which the bot routing looks at). Host picks the domain.
  const request = (target, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method,
      path: parsed.pathname + parsed.search,
      headers: { host: parsed.host, ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

  return { harness, request, close: () => harness.close() };
}
