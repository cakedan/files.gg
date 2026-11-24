import { ApiError, DomainRouter } from 'cf-worker-router';
import { requestApi } from './api.js';
import { storageOrigin } from '../utils/env.js';
import {
  cdnSecurityHeaders,
  decideCdnResponse,
  isForcedText,
} from '../utils/security.js';


export const CDN_HOSTNAME = 'cdn.files.gg';

export const router = new DomainRouter(CDN_HOSTNAME);


router.route('/*', ['GET', 'HEAD', 'OPTIONS'], async (event) => {
  const response = await requestStorage(event, event.url.pathname);
  // Same XSS guard as /files/: never let storage serve markup with a renderable type.
  if (response.ok && isForcedText(response.headers.get('content-type'))) {
    response.headers.set('content-type', 'text/plain');
  }
  return response;
});


router.route('/files/:fileId...', ['GET', 'HEAD', 'OPTIONS'], async (event) => {
  // `<vanity>` and `<vanity>.<anything>` both resolve, including multi-segment vanities (PLAN.md §1.4).
  const fileId = event.parameters.fileId.split('.').shift();

  let response = await requestApi(event, {
    method: 'GET',
    path: `/files/${fileId}`,
  });

  if (response.ok) {
    const file = await response.json();
    response = await requestStorage(event, '/files/' + file.hash);
    if (response.ok) {
      const decision = decideCdnResponse({
        filename: file.filename,
        mimetype: file.mimetype,
        query: event.url.searchParams,
      });
      response.headers.set('content-disposition', decision.contentDisposition);
      response.headers.set('content-type', decision.contentType);
    }
  } else {
    response = new Response(response.body, response);
  }
  return response;
});


// Applied to every response on cdn.files.gg (including 404s, 405s and 500s) from index.js.
export function applyCdnSecurityHeaders(response) {
  const headers = cdnSecurityHeaders();
  for (const name in headers) {
    response.headers.set(name, headers[name]);
  }
  return response;
};


const bodyLessMethods = ['GET', 'HEAD', 'OPTIONS'];
export async function requestStorage(event, options) {
  if (typeof(options) === 'string') {
    options = {path: options};
  } else {
    options = Object.assign({}, options);
  }

  const url = new URL(storageOrigin(event.environment));
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
