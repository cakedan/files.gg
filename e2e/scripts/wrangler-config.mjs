// Writes the wrangler config for the local stack: cf-worker/wrangler.toml (so it never drifts),
// minus the production routes, with absolute paths, the e2e web build as the static assets, and
// the local hosts and origins as vars. Secrets go in .dev.vars next to it (written by up.sh).
//
//   node e2e/scripts/wrangler-config.mjs <out.json> <web-dist dir>
//
// Without routes, wrangler dev keeps each request's Host, so the Worker routes on
// files.localhost, cdn.files.localhost, api.files.localhost and proxy.files.localhost.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKER_DIR = join(ROOT, 'cf-worker');
const [out, webDist] = process.argv.slice(2);
if (!out || !webDist) {
  console.error('usage: node e2e/scripts/wrangler-config.mjs <out.json> <web-dist dir>');
  process.exit(2);
}

const env = (name, fallback) => process.env[name] || fallback;
const port = env('E2E_PORT', '8787');

process.env.WRANGLER_SEND_METRICS = 'false';
const require = createRequire(join(WORKER_DIR, 'package.json'));
const { experimental_readRawConfig } = require('wrangler');
const { rawConfig } = experimental_readRawConfig({ config: join(WORKER_DIR, 'wrangler.toml') });

const config = {
  ...rawConfig,
  name: 'files-gg-e2e',
  main: join(WORKER_DIR, rawConfig.main),
  assets: { ...rawConfig.assets, directory: resolve(webDist) },
  vars: {
    ...rawConfig.vars,
    MAIN_HOST: 'files.localhost',
    CDN_HOST: 'cdn.files.localhost',
    API_HOST: 'api.files.localhost',
    PROXY_HOST: 'proxy.files.localhost',
    // empty: the default, the MAIN_HOST origin (http://files.localhost:<port>)
    CORS_ALLOWED_ORIGINS: '',
    API_ORIGIN: `http://127.0.0.1:${env('E2E_API_PORT', '18080')}`,
    S3_ENDPOINT: `http://127.0.0.1:${env('E2E_MINIO_PORT', '19000')}`,
    S3_REGION: 'us-east-1',
    S3_BUCKET_FILES: 'filesgg',
    // Everything is in MinIO; never fall back to the production GCS bucket.
    STORAGE_GCS_FALLBACK: 'false',
    // The old frontend's assets (legacy /auth pages) aren't available locally; point the GCS
    // origin at MinIO so nothing reaches the production bucket.
    STORAGE_ORIGIN: `http://127.0.0.1:${env('E2E_MINIO_PORT', '19000')}`,
  },
  dev: { ip: '127.0.0.1', port: Number(port), local_protocol: 'http' },
};
delete config.routes;

writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`wrote ${out}`);
