require('mithril/test-utils/browserMock')(global);

import { FetchRouter, HttpMethods } from 'cf-worker-router';

import { 
  apiRouter,
  cdnRouter,
  stableRouter,
} from './domains';
import { requestStorage } from './domains/cdn';

const router = new FetchRouter();

router.beforeResponse = (response, event) => {
  if (event.originalRequest.headers.has('origin')) {
    response = new Response(response.body, response);
    response.headers.set('access-control-allow-credentials', 'true');
    response.headers.set('access-control-allow-headers', 'Authorization, Content-Type, X-Fingerprint');
    response.headers.set('access-control-allow-methods', Object.values(HttpMethods).join(', '));
    response.headers.set('access-control-allow-origin', '*');
    return response;
  }
};

router.route('/favicon.ico', '*', (event) => {
  return requestStorage(event, '/assets/stable/favicon.ico');
}, {priority: 100});

router.addRouter(apiRouter);
router.addRouter(cdnRouter);
router.addRouter(stableRouter);

addEventListener('fetch', (event) => {
  router.onFetch(event);  
});
