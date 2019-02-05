import { DomainRouter } from 'cf-worker-router';

const router = new DomainRouter('api.files.gg');

router.route('/*', '*', async (event) => {
  const url = new URL(event.url);
  url.hostname = 'filesgg.appspot.com';

  let response = await fetch(url, event.request);
  response = new Response(response.body, response);
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', '*');
  response.headers.set('access-control-allow-headers', '*');
  return response;
});

export default router;
