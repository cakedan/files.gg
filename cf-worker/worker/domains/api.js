import { DomainRouter } from 'cf-worker-router';

export const router = new DomainRouter('api.files.gg');


router.route('/*', '*', {pass: true});


const bodyLessMethods = ['GET', 'HEAD', 'OPTIONS'];
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
  if (bodyLessMethods.includes(options.method)) {
    options.body = null;
  }
  return await fetch(request, options);
};
