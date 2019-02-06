import { DomainRouter } from 'cf-worker-router';

const router = new DomainRouter('api.files.gg');

export async function requestApi(request, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({method: request.method}, options);
  }

  const url = new URL(request.url);
  url.hostname = 'filesgg.appspot.com';
  if (options.path) {
    url.pathname = options.path;
  }

  request = new Request(url, request);
  return await fetch(request, options);
};

router.route('/*', '*', async (event) => {
  let response = await requestApi(event.request);
  response = new Response(response.body, response);
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', '*');
  response.headers.set('access-control-allow-headers', '*');
  return response;
});

export default router;
