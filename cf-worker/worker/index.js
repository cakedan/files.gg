require('mithril/test-utils/browserMock')(global);

import { FetchRouter } from 'cf-worker-router';

import { 
  apiRouter,
  cdnRouter,
  mainRouter,
} from './domains';

const router = new FetchRouter();

router.route('/favicon.ico', ['GET', 'HEAD', 'OPTIONS'], async(event) => {
  return await fetch('https://cdn.files.gg/assets/favicon.ico', event.fetchRequest);
});

router.addRouter(apiRouter);
router.addRouter(cdnRouter);
router.addRouter(mainRouter);

addEventListener('fetch', (event) => {
  router.onFetch(event);  
});