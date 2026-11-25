import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

// Files and files.gg requests shared by the unit and integration tests. Each request says what it
// gets: `redirect` (302 to `location`, the file's cdn_url), `page` (the viewer), `missing` or `home`.
export const cases = read('stable-cases.json');

// The file payload a files.gg/<vanity>[.<ext>] path resolves to, or null.
export const fileFor = (path) => cases.files[path.slice(1).split('.').shift()] || null;

export const headersFor = (request) => (request.agent === 'browser') ? { ...cases.browser } : { ...(request.headers || {}) };
