import { ApiRedirect, DomainRouter } from 'cf-worker-router';
import { requestApi } from './api.js';
import { requestStorage } from './cdn.js';
import { Metatags, fileMetatags, renderDocument, shouldRedirectToCdn } from '../utils/pages.js';

export const router = new DomainRouter('(?:[w]{3}.)?files.gg');
const version = 'stable';


const renderHtml = async (event, metatags) => {
  const manifestResponse = await requestStorage(event, {
    method: 'GET',
    path: `/assets/${version}/manifest.json`,
  });
  const manifest = (manifestResponse.ok) ? await manifestResponse.json() : null;

  const html = renderDocument({ manifest, metatags });
  return new Response(html, {headers: {'content-type': 'text/html'}});
};


router.route(['/auth', '/auth/*'], async (event) => {
  const metatags = new Metatags();
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route('/auth/callback/:token', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'secret');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/login', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Login here to view your files');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/logout', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Logout here');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/forgot/:token', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Do not share this forgot password url with anyone');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/verify/:token', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Do not share this verify url with anyone');
  return renderHtml(event, metatags);
}, {priority: 1});


router.route(['/dashboard', '/dashboard/*'], async (event) => {
  const metatags = new Metatags();
  metatags.set('title', 'File Uploader Dashboard');
  return renderHtml(event, metatags);
});

router.route('/dashboard/configs', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'View your custom uploader configs here.');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route(['/dashboard/files', '/dashboard/files/*'], async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'View your files here.');
  return renderHtml(event, metatags);
}, {priority: 1});


router.route(['/details', '/details/*'], async (event) => {
  const metatags = new Metatags();
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});


router.route(['/legal', '/legal/*'], async (event) => {
  const metatags = new Metatags();
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route('/legal/privacy', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Our Privacy Policy');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/legal/report', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Report content');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/legal/terms', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Our Terms of Service');
  return renderHtml(event, metatags);
}, {priority: 1});


router.route('/options/*', async (event) => {
  const metatags = new Metatags();
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route(['/options', '/options/:optionType'], async (event) => {
  const metatags = new Metatags();
  metatags.set('description', 'Customizable Options');
  return renderHtml(event, metatags);
}, {priority: 1});


// files.gg/<vanity> and files.gg/<vanity>.<anything>, including multi-segment vanities (PLAN.md §1.4).
router.route('/:fileId...', ['GET', 'HEAD'], async (event) => {
  if (event.url.pathname === '/') {
    return renderHtml(event, new Metatags());
  }

  const fileId = event.parameters.fileId.split('.').shift();
  const apiResponse = await requestApi(event, {
    method: 'GET',
    path: `/files/${fileId}`,
  });

  let file = null;
  if (apiResponse.ok) {
    file = await apiResponse.json();
    // Bots and embeds go straight to the bytes (PLAN.md §1.4 item 3).
    if (shouldRedirectToCdn(event.request.headers, file)) {
      return new ApiRedirect(file.urls.cdn);
    }
  }
  return renderHtml(event, fileMetatags(file));
});

router.route('/assets/:filename...', '*', async (event) => {
  const filename = encodeURIComponent(event.parameters.filename);
  return await requestStorage(event, `/assets/${version}/${filename}`);
});

router.route('/favicon.ico', '*', async (event) => {
  return await requestStorage(event, `/assets/${version}/favicon.ico`);
});

router.route('/api/:apiRoute...', '*', async (event) => {
  return await requestApi(event, {
    path: event.parameters.apiRoute,
  });
});
