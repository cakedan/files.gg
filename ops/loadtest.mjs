#!/usr/bin/env node
// Upload load test (docs/redesign/contracts/milestone-7.md §5.2): streaming single uploads and chunked uploads at a
// configurable concurrency, with each chunked session's requests spread across two (or more) API processes on
// purpose, then:
// - every upload completed with the right content (the API's stored blake2b, sha1 and md5, read with psql);
// - each scheduled task ran at most once per period while it went on (the scheduler's own marker rows);
// - a short report: counts, errors, p50/p95 throughput.
//
//   node ops/loadtest.mjs --main <site url> --api <api process url> --api <another> --session fgs_… \
//                         [--key fgg_…] [--concurrency 6] [--duration 60] [--single-mb 4] [--chunked-mb 25]
//                         [--chunked-share 0.5] [--compose-project filesgg] [--report <file>] [--cookie-name <name>]
//
// `--api` names the API processes directly, not through the load balancer, so a session's chunks reach different
// processes for certain: on the server, the containers' own addresses during a deploy rollover (both up), e.g.
//   docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <api container>  → http://<ip>:8080
// Uploads use an upload key (`--key`, FILESGG_LOADTEST_KEY, or a temporary one made with the session and revoked at
// the end). The session (`--session` or FILESGG_LOADTEST_SESSION, the website's session cookie value, sent to
// `--main`/api) also deletes every uploaded file at the end; each upload expires in an hour regardless. Use a staging
// stack with a throwaway bucket, and raise `upload_key` in its RATE_LIMITS (600 an hour by default): a load test
// sends far more than a real tool.
//
// The database checks run `docker exec` on the compose project's `postgres` container (psql), and read the
// scheduled tasks' intervals from its `worker` container, so run this on the server (or next to the local stack).
// A run should last longer than the intervals it's meant to cover: 11 minutes (`--duration 660`) sees the 1, 5 and
// 10-minute tasks run more than once. Node 22+, no dependencies. Exit 0 when everything passed, 1 otherwise, 2 on bad arguments.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node ops/loadtest.mjs --main <site url> --api <url> [--api <url> …] --session fgs_… [--key fgg_…] ' +
  '[--concurrency 6] [--duration 60] [--single-mb 4] [--chunked-mb 25] [--chunked-share 0.5] [--compose-project filesgg] ' +
  '[--report <file>] [--cookie-name <name>]';

let parsed;
try {
  parsed = parseArgs({
    options: {
      main: { type: 'string' },
      api: { type: 'string', multiple: true, default: [] },
      session: { type: 'string' },
      key: { type: 'string' },
      concurrency: { type: 'string', default: '6' },
      duration: { type: 'string', default: '60' },
      'single-mb': { type: 'string', default: '4' },
      'chunked-mb': { type: 'string', default: '25' },
      'chunked-share': { type: 'string', default: '0.5' },
      'compose-project': { type: 'string', default: 'filesgg' },
      report: { type: 'string' },
      'cookie-name': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
const args = parsed.values;
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const number = (name, { min, max }) => {
  const value = Number(args[name]);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`--${name} must be a number from ${min} to ${max}\n${USAGE}`);
    process.exit(2);
  }
  return value;
};
const SESSION = args.session || process.env.FILESGG_LOADTEST_SESSION;
if (!args.main || !args.api.length || !SESSION) {
  console.error(USAGE);
  process.exit(2);
}
const MAIN = new URL(args.main).origin;
const APIS = args.api.map((url) => new URL(url).origin);
// at most 20 open chunked sessions per account (UPLOAD_MAX_OPEN_SESSIONS)
const CONCURRENCY = number('concurrency', { min: 1, max: 20 });
const DURATION_MS = number('duration', { min: 5, max: 3600 }) * 1000;
const MB = 1_000_000;
const SINGLE_BYTES = Math.round(number('single-mb', { min: 0.001, max: 100 }) * MB);
const CHUNKED_BYTES = Math.round(number('chunked-mb', { min: 1, max: 1000 }) * MB);
const CHUNKED_SHARE = number('chunked-share', { min: 0, max: 1 });
const PROJECT = args['compose-project'];
const COOKIE_NAME = args['cookie-name'] || (MAIN.startsWith('https:') ? '__Host-filesgg_session' : 'filesgg_session');
const FINALIZE_TIMEOUT_MS = 300_000;


// --- helpers -------------------------------------------------------------------------------------------------

async function request(url, { method = 'GET', headers = {}, body, json } = {}) {
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers = { 'content-type': 'application/json', ...headers };
  }
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(300_000) });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

const web = (path, { method = 'GET', ...rest } = {}) => request(`${MAIN}/api${path}`, {
  method,
  ...rest,
  headers: { cookie: `${COOKIE_NAME}=${SESSION}`, ...(method === 'GET' ? {} : { 'x-filesgg-csrf': '1' }) },
});

function container(service) {
  const ids = execFileSync('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--filter', `label=com.docker.compose.service=${service}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (!ids.length) {
    throw new Error(`no running ${service} container in the compose project ${PROJECT} (--compose-project)`);
  }
  return ids[0];
}

// psql in the project's postgres container: rows of tab-separated fields
function psql(sql) {
  const output = execFileSync('docker', ['exec', '-i', container('postgres'), 'psql', '-U', 'filesgg', '-d', 'filesgg',
    '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '\t', '-c', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

function digests(bytes) {
  return ['blake2b512', 'sha1', 'md5'].map((algorithm) => createHash(algorithm).update(bytes).digest('hex'));
}

function percentile(values, p) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// --- the scheduler (api/jobs/scheduler.py) ------------------------------------------------------------------------
// One marker row per task in `jobs` (kind `scheduled:<name>`, queue `scheduler`): `done_at` is the last run's finish
// and `attempts` counts the runs. Sampled every 2 s, a task that ran twice in one period shows as a gap between two
// runs shorter than its interval, or as attempts jumping by more than one between samples.

function scheduledIntervals() {
  const output = execFileSync('docker', ['exec', container('worker'), 'python', '-c',
    'import json, db\nfrom jobs import Scheduler, tasks\n' +
    's = tasks.register_scheduled(Scheduler(db.connect()))\n' +
    'print(json.dumps({name: task.interval for name, task in s.tasks.items()}))'], { encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop());
}

function schedulerProcesses() {
  const rows = execFileSync('docker', ['ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--format', '{{.Names}}\t{{.Command}}'], { encoding: 'utf8' }).trim().split('\n');
  return rows.filter((row) => row.includes('python -m worker')).map((row) => row.split('\t')[0]);
}

function markers() {
  const rows = psql("SELECT kind, attempts, extract(epoch FROM done_at), last_error IS NOT NULL FROM jobs " +
    "WHERE queue = 'scheduler' AND kind LIKE 'scheduled:%' ORDER BY kind, id");
  return rows.map(([kind, attempts, doneAt, failing]) => ({
    task: kind.slice('scheduled:'.length), attempts: Number(attempts), doneAt: Number(doneAt), failing: failing === 't',
  }));
}

const samples = [];
let sampling = true;
async function sampleScheduler() {
  while (sampling) {
    samples.push({ at: Date.now() / 1000, rows: markers() });
    await sleep(2000);
  }
  samples.push({ at: Date.now() / 1000, rows: markers() });
}

function analyseScheduler(intervals) {
  const problems = [];
  const lines = [];
  const window = samples.at(-1).at - samples[0].at;
  const duplicates = Object.entries(Object.groupBy(samples.at(-1).rows, (row) => row.task)).filter(([, rows]) => rows.length > 1);
  for (const [task, rows] of duplicates) {
    problems.push(`${task}: ${rows.length} marker rows (a run raced its first insert)`);
  }
  for (const [task, interval] of Object.entries(intervals).sort()) {
    const series = samples.map((sample) => sample.rows.find((row) => row.task === task)).filter(Boolean);
    const runs = [];
    for (let i = 1; i < series.length; i++) {
      const jump = series[i].attempts - series[i - 1].attempts;
      if (jump > 1) {
        problems.push(`${task}: ${jump} runs within one 2 s sample (interval ${interval} s)`);
      }
      if (jump > 0) {
        runs.push(series[i].doneAt);
      }
    }
    const previous = series.length ? series[0].doneAt : null;
    const finishes = previous ? [previous, ...runs] : runs;
    for (let i = 1; i < finishes.length; i++) {
      if (finishes[i] - finishes[i - 1] < interval - 1) {
        problems.push(`${task}: ran ${(finishes[i] - finishes[i - 1]).toFixed(1)} s after its previous run (interval ${interval} s)`);
      }
    }
    // a task due at least twice in the window that never ran means the scheduler stalled under load
    if (interval * 2 <= window && runs.length === 0) {
      problems.push(`${task}: never ran in ${window.toFixed(0)} s (interval ${interval} s)`);
    }
    const failing = series.length && series.at(-1).failing ? ' (its last run failed)' : '';
    lines.push(`| ${task} | ${interval} s | ${runs.length} | ${Math.floor(window / interval)}–${Math.floor(window / interval) + 1} |${failing}`);
  }
  return { problems, lines, window };
}


// --- uploads --------------------------------------------------------------------------------------------------

const done = [];
const errors = [];
const perApi = Object.fromEntries(APIS.map((api) => [api, 0]));
let sessionsSpread = 0;
let sequence = 0;

function call(api, path, options, key) {
  perApi[api] += 1;
  return request(api + path, { ...options, headers: { authorization: `Key ${key}`, ...(options.headers || {}) } });
}

function fail(kind, stage, response) {
  errors.push({ kind, stage, status: response.status ?? 'network', code: (response.data && response.data.code) || response.message || '' });
}

async function singleUpload(key, n) {
  const bytes = randomBytes(SINGLE_BYTES);
  const api = APIS[n % APIS.length];
  const started = performance.now();
  const response = await call(api, `/files?type=raw&expires_in=3600&filename=loadtest-${n}.bin`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
  }, key);
  if (response.status !== 200 || !response.data || !response.data.id) {
    return fail('single', 'POST /files', response);
  }
  done.push({ kind: 'single', id: response.data.id, size: bytes.length, ms: performance.now() - started, digests: digests(bytes) });
}

// Every request of the session goes to a different process than the one before it: create on A, chunk k on
// APIS[(n + k) % N], complete on the next one, and the status polls alternate.
async function chunkedUpload(key, n) {
  const bytes = randomBytes(CHUNKED_BYTES);
  const pick = (offset) => APIS[(n + offset) % APIS.length];
  const used = new Set();
  const started = performance.now();
  const created = await call(pick(0), '/uploads', { method: 'POST', json: { filename: `loadtest-${n}.bin`, size: bytes.length, expires_in: 3600 } }, key);
  used.add(pick(0));
  if (created.status !== 201) {
    return fail('chunked', 'POST /uploads', created);
  }
  const { upload_id: id, chunk_size: chunkSize } = created.data;
  const count = Math.ceil(bytes.length / chunkSize);
  const puts = await Promise.all([...Array(count).keys()].map((index) => {
    used.add(pick(1 + index));
    return call(pick(1 + index), `/uploads/${id}/chunks/${index}`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
    }, key);
  }));
  const broken = puts.find((response) => response.status !== 204);
  if (broken) {
    return fail('chunked', 'PUT chunk', broken);
  }
  const completed = await call(pick(1 + count), `/uploads/${id}/complete`, { method: 'POST' }, key);
  used.add(pick(1 + count));
  if (completed.status !== 202) {
    return fail('chunked', 'POST complete', completed);
  }
  for (let poll = 0; performance.now() - started < FINALIZE_TIMEOUT_MS; poll++) {
    const status = await call(pick(poll), `/uploads/${id}`, {}, key);
    used.add(pick(poll));
    if (status.status !== 200) {
      return fail('chunked', 'GET /uploads/<id>', status);
    }
    if (status.data.status === 'complete') {
      sessionsSpread += used.size >= Math.min(2, APIS.length) ? 1 : 0;
      done.push({ kind: 'chunked', id: status.data.file.id, size: bytes.length, ms: performance.now() - started, digests: digests(bytes), chunks: count });
      return;
    }
    if (status.data.status === 'failed') {
      return fail('chunked', 'finalize', { status: 200, data: { code: status.data.error } });
    }
    await sleep(250);
  }
  fail('chunked', 'finalize', { status: 'timeout', data: { code: `not complete after ${FINALIZE_TIMEOUT_MS / 1000} s` } });
}

async function worker(key, deadline) {
  while (Date.now() < deadline) {
    const n = sequence++;
    // spread the kinds evenly: the share of chunked uploads, in order
    const chunked = Math.floor((n + 1) * CHUNKED_SHARE) > Math.floor(n * CHUNKED_SHARE);
    try {
      await (chunked ? chunkedUpload(key, n) : singleUpload(key, n));
    } catch (error) {
      fail(chunked ? 'chunked' : 'single', 'request', { status: 'network', message: String(error.cause || error.message) });
    }
  }
}


// --- run --------------------------------------------------------------------------------------------------------

console.log(`files.gg load test: ${CONCURRENCY} concurrent for ${DURATION_MS / 1000} s against ${APIS.join(', ')}`);
for (const api of APIS) {
  const health = await request(`${api}/health`).catch((error) => ({ status: String(error.cause || error) }));
  if (health.status !== 200) {
    console.error(`${api}/health: ${health.status}`);
    process.exit(1);
  }
}
const intervals = scheduledIntervals();
const processes = schedulerProcesses();
console.log(`scheduler processes: ${processes.join(', ')} (${processes.length}); ${Object.keys(intervals).length} scheduled tasks`);

let temporaryKey = null;
let key = args.key || process.env.FILESGG_LOADTEST_KEY;
if (!key) {
  const created = await web('/users/@me/upload-keys', { method: 'POST', json: { name: 'load test' } });
  if (created.status !== 201) {
    console.error(`couldn't make an upload key with the session: ${created.status} ${created.text.slice(0, 200)}`);
    process.exit(1);
  }
  temporaryKey = created.data.key;
  key = created.data.secret;
}

const sampler = sampleScheduler();
const started = Date.now();
await Promise.all([...Array(CONCURRENCY)].map(() => worker(key, started + DURATION_MS)));
const elapsed = (Date.now() - started) / 1000;
sampling = false;
await sampler;
console.log(`uploads finished after ${elapsed.toFixed(0)} s; checking hashes and the scheduler`);

// the stored hashes, before anything is deleted
const mismatches = [];
if (done.length) {
  const stored = new Map(psql(`SELECT f.id, h.blake2b, h.sha1, h.md5, h.size FROM files f JOIN file_hashes h ON h.id = f.hash_id ` +
    `WHERE f.id = ANY('{${done.map((upload) => BigInt(upload.id)).join(',')}}'::bigint[])`).map(([id, ...rest]) => [id, rest]));
  for (const upload of done) {
    const row = stored.get(upload.id);
    if (!row) {
      mismatches.push(`${upload.kind} ${upload.id}: no file row`);
    } else if (row.slice(0, 3).join() !== upload.digests.join() || Number(row[3]) !== upload.size) {
      mismatches.push(`${upload.kind} ${upload.id}: stored ${row.join(' ')}, sent ${upload.digests.join(' ')} ${upload.size}`);
    }
  }
}
const scheduler = analyseScheduler(intervals);

// clean up: every uploaded file, then the temporary key
let cleanupFailures = 0;
for (let i = 0; i < done.length; i += 8) {
  const results = await Promise.all(done.slice(i, i + 8).map((upload) => web(`/users/@me/files/${upload.id}`, { method: 'DELETE' })));
  cleanupFailures += results.filter((response) => response.status !== 204).length;
}
if (temporaryKey) {
  await web(`/users/@me/upload-keys/${temporaryKey.id}`, { method: 'DELETE' });
}


// --- the report -------------------------------------------------------------------------------------------------

const mbps = (uploads) => uploads.map((upload) => (upload.size / MB) / (upload.ms / 1000));
const fmt = (value, digits = 1) => (value === null ? '–' : value.toFixed(digits));
const kindRow = (kind) => {
  const uploads = done.filter((upload) => upload.kind === kind);
  const failed = errors.filter((error) => error.kind === kind).length;
  const rates = mbps(uploads);
  const ms = uploads.map((upload) => upload.ms);
  return `| ${kind} | ${uploads.length} | ${failed} | ${fmt(percentile(rates, 50))} | ${fmt(percentile(rates, 95))} | ` +
    `${fmt(percentile(ms, 50) / 1000, 2)} | ${fmt(percentile(ms, 95) / 1000, 2)} |`;
};
const errorCounts = Object.entries(Object.groupBy(errors, (error) => `${error.kind} ${error.stage}: ${error.status} ${error.code}`))
  .map(([text, list]) => `- ${list.length} × ${text}`);
const chunkedCount = done.filter((upload) => upload.kind === 'chunked').length;
const totalBytes = done.reduce((sum, upload) => sum + upload.size, 0);
const failures = [
  ...(errors.length ? [`${errors.length} upload(s) failed`] : []),
  ...(mismatches.length ? [`${mismatches.length} hash mismatch(es)`] : []),
  ...(sessionsSpread < chunkedCount ? [`${chunkedCount - sessionsSpread} chunked session(s) not spread across APIs`] : []),
  ...scheduler.problems,
  ...(cleanupFailures ? [`${cleanupFailures} file(s) not deleted`] : []),
  ...(done.length ? [] : ['nothing was uploaded']),
];

const report = [
  `# files.gg load test, ${new Date().toISOString()}`,
  '',
  `${CONCURRENCY} concurrent uploaders for ${elapsed.toFixed(0)} s; single uploads of ${SINGLE_BYTES / MB} MB (raw body), ` +
    `chunked uploads of ${CHUNKED_BYTES / MB} MB (${Math.round(CHUNKED_SHARE * 100)}% of uploads).`,
  `API processes: ${APIS.join(', ')}; requests each: ${APIS.map((api) => perApi[api]).join(' / ')}. ` +
    `Chunked sessions spread across ${Math.min(2, APIS.length)}+ processes: ${sessionsSpread} of ${chunkedCount}.`,
  `Scheduler processes (\`python -m worker\`): ${processes.length} (${processes.join(', ')}).`,
  '',
  `${done.length} uploads completed, ${(totalBytes / MB).toFixed(0)} MB in all (${(totalBytes / MB / elapsed).toFixed(1)} MB/s), ` +
    `${errors.length} failed; ${mismatches.length} hash mismatches.`,
  '',
  '| kind | completed | failed | p50 MB/s | p95 MB/s | p50 s | p95 s |',
  '|---|---|---|---|---|---|---|',
  kindRow('single'),
  kindRow('chunked'),
  '',
  'Throughput is per upload: its size over the time from the first request to the file existing (a chunked upload',
  'includes its finalize job). p95 throughput is the 95th-percentile rate (the fast end); p95 seconds the slow end.',
  '',
  ...(errorCounts.length ? ['Errors:', ...errorCounts, ''] : []),
  ...(mismatches.length ? ['Hash mismatches:', ...mismatches.map((line) => `- ${line}`), ''] : []),
  `Scheduled tasks over ${scheduler.window.toFixed(0)} s (runs seen; a task may run once per interval):`,
  '',
  '| task | interval | runs | expected |',
  '|---|---|---|---|',
  ...scheduler.lines,
  '',
  failures.length ? `**FAILED:** ${failures.join('; ')}` : '**PASSED**: every upload completed with the right hash, and no scheduled task ran twice in a period.',
  '',
].join('\n');

const path = args.report || join(tmpdir(), `filesgg-loadtest-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(path, report);
console.log(`\n${report}\nreport written to ${path}`);
process.exit(failures.length ? 1 : 0);
