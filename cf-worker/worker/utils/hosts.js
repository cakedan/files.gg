// The public hostnames this Worker answers on, from the MAIN_HOST, CDN_HOST and API_HOST vars
// (cf-worker/README.md). Unset, they are today's production hosts, so production
// routing, URLs, the CSPs and CORS are unchanged. A local stack (e2e/) sets them to *.localhost.
//
// Pure (no Worker globals), so it is unit-tested with `node --test`.

export const DEFAULT_HOSTS = Object.freeze({
  main: 'files.gg',
  cdn: 'cdn.files.gg',
  api: 'api.files.gg',
});

const BINDINGS = Object.freeze({ main: 'MAIN_HOST', cdn: 'CDN_HOST', api: 'API_HOST' });
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function normalizeHost(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  const host = String(value).trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(host)) {
    // A typo must not silently route nothing (or everything): fail loudly at the first request.
    throw new Error(`${name} must be a bare hostname (no scheme, port or path), got ${JSON.stringify(value)}`);
  }
  return host;
}

let cache = { key: null, hosts: DEFAULT_HOSTS };

// { main, cdn, api }: lower-case hostnames, without scheme or port.
export function getHosts(env) {
  const raw = Object.values(BINDINGS).map((name) => {
    const value = (env) ? env[name] : undefined;
    return (typeof(value) === 'string' && value.trim()) ? value : undefined;
  });
  const key = raw.map((value) => value || '').join('\n');
  if (key !== cache.key) {
    const hosts = {};
    Object.keys(BINDINGS).forEach((kind, index) => {
      hosts[kind] = normalizeHost(raw[index], DEFAULT_HOSTS[kind], BINDINGS[kind]);
    });
    cache = { key, hosts: Object.freeze(hosts) };
  }
  return cache.hosts;
}

// The main site also answers on its www. name, as files.gg always has.
export function isMainHost(hostname, hosts = DEFAULT_HOSTS) {
  const host = String(hostname || '').toLowerCase();
  return host === hosts.main || host === 'www.' + hosts.main;
}

// A hostname as a regex source for cf-worker-router's DomainRouter. The router turns `:word` and
// `*` into parameters, so the optional www. is written `[w]{3}` (never `(?:www`).
export function hostPattern(host, { www = false } = {}) {
  const escaped = String(host).replace(/[.\\+?^${}()|[\]]/g, '\\$&');
  return (www) ? `(?:[w]{3}\\.)?${escaped}` : escaped;
}

const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

// Base for the absolute URLs the Worker writes (CSPs, CORS defaults, og:image):
// `https://<host>`, as in production. Only a plain-http request to a loopback name (wrangler dev
// on *.localhost) keeps its scheme and port, so the local stack links to itself.
export function originFor(host, requestUrl) {
  if (requestUrl) {
    const url = (requestUrl instanceof URL) ? requestUrl : new URL(String(requestUrl));
    if (url.protocol === 'http:' && LOOPBACK.test(url.hostname)) {
      return `http://${host}${url.port ? ':' + url.port : ''}`;
    }
  }
  return `https://${host}`;
}

// { main, cdn, api } origins for this request.
export function publicOrigins(hosts = DEFAULT_HOSTS, requestUrl = null) {
  return {
    main: originFor(hosts.main, requestUrl),
    cdn: originFor(hosts.cdn, requestUrl),
    api: originFor(hosts.api, requestUrl),
  };
}

export const DEFAULT_ORIGINS = Object.freeze(publicOrigins(DEFAULT_HOSTS));
