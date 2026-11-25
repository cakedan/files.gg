// Writes the wrangler config for the local stack: cf-worker/wrangler.toml (so it never drifts),
// minus the production routes, with absolute paths, the e2e web build as the static assets, and
// the local hosts and origins as vars. Secrets go in .dev.vars next to it (written by up.sh).
//
//   node e2e/scripts/wrangler-config.mjs <out.json> <web-dist dir>
//
// Without routes, wrangler dev keeps each request's Host, so the Worker routes on
// files.localhost, cdn.files.localhost and api.files.localhost, and every other host (for example a
// custom domain such as <name>.example.localhost) goes to the custom-host router.
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
    // milestone-6 §3.2, §12: the API's plain-http cookie name (SESSION_COOKIE_INSECURE=1). The Worker
    // forwards only this cookie, and only on files.localhost/api/*.
    SESSION_COOKIE_NAME: 'filesgg_session',
    API_ORIGIN: `http://127.0.0.1:${env('E2E_API_PORT', '18080')}`,
    S3_ENDPOINT: `http://127.0.0.1:${env('E2E_MINIO_PORT', '19000')}`,
    S3_REGION: 'us-east-1',
    S3_BUCKET_FILES: 'filesgg',
  },
  dev: { ip: '127.0.0.1', port: Number(port), local_protocol: 'http' },
};
delete config.routes;

writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
console.log(`wrote ${out}`);
