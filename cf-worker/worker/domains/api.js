import { DomainRouter } from 'cf-worker-router';

export const router = new DomainRouter('api.files.gg');


router.route('/*', '*', {pass: true});


export async function requestApi(request, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  const url = new URL(request.url);
  url.hostname = 'api.files.gg';
  if (options.path) {
    url.pathname = options.path;
  }

  request = new Request(url, request);
  if (options.method === 'GET' || options.method === 'HEAD') {
    // Safari sends a body with OPTIONS requests lol
    options.body = undefined;
  }
  return await fetch(request, options);
};
