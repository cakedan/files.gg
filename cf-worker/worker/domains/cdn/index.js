import { ApiError, DomainRouter } from 'cf-worker-router';

const router = new DomainRouter('cdn.files.gg');


const requestStorage = async(path, request) => {
  const storageUrl = 'https://storage.googleapis.com/filesgg' + path;
  let response = await fetch(storageUrl, request);
  if (response.ok) {
    response = new Response(response.body, response);
  } else {
    const status = (response.status === 403) ? 404 : response.status;
    response = new ApiError({status});
  }
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', '*');
  response.headers.set('access-control-allow-headers', '*');
  return response;
};

router.route('/*', ['GET', 'HEAD', 'OPTIONS'], async(event) => {
  return await requestStorage(event.url.pathname, event.request);
});

router.route('/files/:fileId...', ['GET', 'HEAD', 'OPTIONS'], async(event) => {
  const fileId = event.parameters.fileId.split('.').shift();

  const apiUrl = new URL(event.url);
  apiUrl.hostname = 'filesgg.appspot.com';
  apiUrl.pathname = '/files/' + fileId;

  const apiResponse = await fetch(apiUrl, {
    method: 'GET',
    headers: event.request.headers,
  });

  if (!apiResponse.ok) {
    return apiResponse;
  }

  const file = await apiResponse.json();
  const response = await requestStorage('/files/' + file.hash, event.request);
  if (response.ok) {
    const filename = encodeURIComponent([file.filename, file.extension].join('.'));

    let mimetype = file.mimetype;
    switch (mimetype) {
      case 'text/html': {
        mimetype = 'text/plain';
      }; break;
    }

    response.headers.set('content-type', mimetype);
    response.headers.set('content-disposition', `inline; filename="${filename}"`);
  }
  return response;
});

export default router;
