import { ApiError, DomainRouter } from 'cf-worker-router';
import { requestApi } from './api';


export const router = new DomainRouter('cdn.files.gg');


router.route('/*', ['GET', 'HEAD', 'OPTIONS'], async(event) => {
  return await requestStorage(event.request, event.url.pathname);
});


const displayAsText = [
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
];

router.route('/files/:fileId...', ['GET', 'HEAD', 'OPTIONS'], async(event) => {
  const fileId = event.parameters.fileId.split('.').shift();

  let response = await requestApi(event.request, {
    method: 'GET',
    path: `/files/${fileId}`,
  });

  if (response.ok) {
    const file = await response.json();
    response = await requestStorage(event.request, '/files/' + file.hash);
    if (response.ok) {
      const filename = encodeURIComponent([file.filename, file.extension].join('.'));

      let mimetype = file.mimetype;
      if (displayAsText.includes(mimetype)) {
        mimetype = 'text/plain';
      } else if ((event.url.searchParams.get('force-text') || '') === 'true') {
        mimetype = 'text/plain';
      }

      let disposition = 'inline';
      if ((event.url.searchParams.get('download') || '').toLowerCase() === 'true') {
        disposition = 'attachment';
      }
      response.headers.set('content-type', mimetype);
      response.headers.set('content-disposition', `${disposition}; filename="${filename}"`);
    }
  } else {
    response = new Response(response.body, response);
  }
  return response;
});


export async function requestStorage(request, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  const url = new URL('https://filesgg.storage.googleapis.com');
  url.pathname = options.path;

  request = new Request(url, request);
  if (options.method === 'GET' || options.method === 'HEAD') {
    options.body = undefined;
  }
  let response = await fetch(request, options);
  if (response.status < 400) {
    response = new Response(response.body, response);

    for (let header of response.headers.keys()) {
      if (header.startsWith('x-g')) {
        response.headers.delete(header);
      }
    }
  } else {
    let status = response.status;
    if (status === 403) {
      status = 404;
    }
    response = new ApiError({status});
  }
  return response;
};
