// Worker bindings (vars and secrets) arrive on `env` in the ES module format.

import { DEFAULT_HOSTS, getHosts } from './hosts.js';

export const DEFAULT_API_ORIGIN = `https://${DEFAULT_HOSTS.api}`;

// A non-empty string binding, or undefined.
export function getStringBinding(env, name) {
  const value = (env) ? env[name] : undefined;
  return (typeof(value) === 'string' && value) ? value : undefined;
}

function origin(env, name, fallback) {
  const value = getStringBinding(env, name);
  return new URL(value || fallback).origin;
}

// Where API lookups and the API passthrough go: API_ORIGIN, else https://<API_HOST> (a Worker's
// subrequest to its own route goes to the origin). Production leaves API_ORIGIN unset.
export function apiOrigin(env) {
  return origin(env, 'API_ORIGIN', `https://${getHosts(env).api}`);
}
