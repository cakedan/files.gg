import { readFileSync } from 'node:fs';

const read = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

// Files, requests and the manifest shared by the unit and integration tests.
export const cases = read('stable-cases.json');

// files.gg page responses captured from the old Mithril worker (webpack 4 build, service-worker
// format) before Mithril was removed: { [request name]: { status, location, contentType, body } }.
export const mithril = read('stable-pages.mithril.json');

// The one deliberate difference from the Mithril output: OpenGraph tags use property=.
export const withOgProperty = (html) => html.replaceAll('<meta name="og:', '<meta property="og:');

// The API file JSON a files.gg/<vanity>[.<ext>] path resolves to, or null.
export const fileFor = (path) => cases.files[path.slice(1).split('.').shift()] || null;

export const headersFor = (request) => (request.agent === 'browser') ? { ...cases.browser } : { ...(request.headers || {}) };
