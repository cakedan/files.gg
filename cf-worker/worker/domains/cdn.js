import { ApiError, DomainRouter } from 'cf-worker-router';
import { requestApi } from './api';
import { InputTypes } from '../utils';


export const router = new DomainRouter('cdn.files.gg');


router.route('/*', ['GET', 'HEAD', 'OPTIONS'], async (event) => {
  return await requestStorage(event, event.url.pathname);
});


const displayAsText = [
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
];

router.route('/files/:fileId...', ['GET', 'HEAD', 'OPTIONS'], async (event) => {
  const fileId = event.parameters.fileId.split('.').shift();

  let response = await requestApi(event, {
    method: 'GET',
    path: `/files/${fileId}`,
  });

  if (response.ok) {
    const file = await response.json();
    response = await requestStorage(event, '/files/' + file.hash);
    if (response.ok) {
      const filename = encodeURIComponent([file.filename, file.extension].join('.'));

      let mimetype = file.mimetype;
      if (displayAsText.includes(mimetype)) {
        mimetype = 'text/plain';
      } else if (InputTypes.boolean(event.url.searchParams.get('force-text'))) {
        mimetype = 'text/plain';
      }

      let disposition = 'inline';
      if (InputTypes.boolean(event.url.searchParams.get('download'))) {
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


const bodyLessMethods = ['GET', 'HEAD', 'OPTIONS'];
export async function requestStorage(event, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  const url = new URL('https://filesgg.storage.googleapis.com');
  url.pathname = options.path;

  const request = new Request(url, event.request);
  if (bodyLessMethods.includes(options.method)) {
    options.body = null;
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
