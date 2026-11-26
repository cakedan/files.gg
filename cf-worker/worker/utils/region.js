// Regional rules (docs/redesign/contracts/milestone-7.md §11): the visitor's country, and whether
// adult content is unavailable there. Pure helpers, unit-tested with `node --test`.

// Where adult content isn't served when ADULT_BLOCKED_COUNTRIES is unset or empty (§11.1).
export const DEFAULT_ADULT_BLOCKED_COUNTRIES = Object.freeze(['GB']);

// Cloudflare's "unknown" (XX) and Tor (T1): no country.
const UNKNOWN_COUNTRIES = Object.freeze(['XX', 'T1']);

const COUNTRY_CODE = /^[A-Z]{2}$/;

// `country` as an upper-case ISO 3166-1 alpha-2 code, or null (absent, malformed, XX, T1).
export function normalizeCountry(country) {
  if (typeof(country) !== 'string') {
    return null;
  }
  const code = country.trim().toUpperCase();
  return (COUNTRY_CODE.test(code) && !UNKNOWN_COUNTRIES.includes(code)) ? code : null;
}

// The visitor's country, from `request.cf.country` only: never a request header (a client can send
// CF-IPCountry to wrangler's harness, and production must not trust one). null when unknown.
export function clientCountry(request) {
  const cf = request && request.cf;
  return normalizeCountry(cf ? cf.country : undefined);
}

// ADULT_BLOCKED_COUNTRIES (comma-separated codes, spaces and case ignored) as a list. Unset, empty,
// or with no valid code at all (ops/check-env.sh refuses those), it is the default, GB.
export function adultBlockedCountries(env) {
  const value = (env && typeof(env.ADULT_BLOCKED_COUNTRIES) === 'string') ? env.ADULT_BLOCKED_COUNTRIES : '';
  const codes = value.split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((code) => COUNTRY_CODE.test(code));
  return codes.length ? [...new Set(codes)] : [...DEFAULT_ADULT_BLOCKED_COUNTRIES];
}

// Whether adult content is unavailable in `country` (from clientCountry()). An unknown country is
// never blocked.
export function adultBlocked(env, country) {
  const code = normalizeCountry(country);
  return code !== null && adultBlockedCountries(env).includes(code);
}

// adultBlocked() for a request's own country.
export function adultBlockedFor(env, request) {
  return adultBlocked(env, clientCountry(request));
}

// The status and Cache-Control of every "not in your region" response (§11.2).
export const REGION_STATUS = 451;
export const REGION_CACHE_CONTROL = 'no-store';
