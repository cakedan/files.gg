import { DomainRouter } from 'cf-worker-router';

export const router = new DomainRouter('api.files.gg');


router.route('/*', '*', {pass: true});


export async function requestApi(event, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  const url = new URL(event.request.url);
  url.hostname = 'api.files.gg';
  if (options.path) {
    url.pathname = options.path;
  }

  const request = new Request(url, event.request);
  if (options.method === 'GET' || options.method === 'HEAD') {
    // Safari sends a body with OPTIONS requests lol
    options.body = undefined;
  }
  return await fetch(request, options);
};
