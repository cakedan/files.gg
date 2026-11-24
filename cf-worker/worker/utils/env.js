// Worker bindings (vars and secrets) arrive on `env` in the ES module format.

export const DEFAULT_API_ORIGIN = 'https://api.files.gg';
export const DEFAULT_STORAGE_ORIGIN = 'https://filesgg.storage.googleapis.com';

// A non-empty string binding, or undefined.
export function getStringBinding(env, name) {
  const value = (env) ? env[name] : undefined;
  return (typeof(value) === 'string' && value) ? value : undefined;
}

function origin(env, name, fallback) {
  const value = getStringBinding(env, name);
  return new URL(value || fallback).origin;
}

// Where API lookups and the api.files.gg passthrough go. Only tests override API_ORIGIN.
export function apiOrigin(env) {
  return origin(env, 'API_ORIGIN', DEFAULT_API_ORIGIN);
}

// The storage bucket files and assets are streamed from. Only tests override STORAGE_ORIGIN.
export function storageOrigin(env) {
  return origin(env, 'STORAGE_ORIGIN', DEFAULT_STORAGE_ORIGIN);
}
