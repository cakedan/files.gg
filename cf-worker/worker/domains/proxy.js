import { ApiError, ApiResponse, DomainRouter } from 'cf-worker-router';

import { requestApi } from './api';
import { InputTypes } from '../utils';


export const router = new DomainRouter('proxy.files.gg');

const secret = 'lol';

router.route('/download/:url...', ['GET', 'HEAD', 'OPTIONS'], async (event) => {
  const token = event.request.headers.get('x-proxy-token');
  if (token !== secret) {
    return new ApiError({status: 403});
  }

  return await requestProxy(event, new URL(event.parameters.url));
});


const UnfurlConstants = Object.freeze({
  Regexps: {
    METATAGS: /\<meta.*?\>/g,
    METATAG_PARSE: /<\s*meta\s(?=[^>]*?\b(?:name|property|http-equiv)\s*=\s*(?:"\s*([^"]*?)\s*"|'\s*([^']*?)\s*'|([^"'>]*?)(?=\s*\/?\s*>|\s\w+\s*=)))[^>]*?\bcontent\s*=\s*(?:"\s*([^"]*?)\s*"|'\s*([^']*?)\s*'|([^"'>]*?)(?=\s*\/?\s*>|\s\w+\s*=))[^>]*>/i,
  },
  imageTags: ['og:image', 'twitter:image'],
});

router.route('/unfurl/:url...', ['GET', 'OPTIONS'], async (event) => {
  const token = event.request.headers.get('x-proxy-token');
  if (token !== secret) {
    return new ApiError({status: 403});
  }

  const url = new URL(event.parameters.url);
  const response = await requestProxy(event, url);
  const mimetype = (response.headers.get('content-type') || '').split(';').shift().toLowerCase();
  if (mimetype !== 'text/html') {
    return new ApiError({message: 'Invalid Mimetype', metadata: {mimetype}});
  }

  const html = await response.text();
  const body = {metatags: {}};

  const tags = html.match(UnfurlConstants.Regexps.METATAGS);
  if (tags) {
    for (let tag of tags) {
      let match = tag.match(UnfurlConstants.Regexps.METATAG_PARSE);
      if (match) {
        match = match.filter((value) => value);
        body.metatags[match[1].toLowerCase()] = match[2];
      }
    }
  }

  for (let imageTag of UnfurlConstants.imageTags) {
    if (imageTag in body.metatags) {
      let imageUrl = body.metatags[imageTag];
      if (imageUrl.startsWith('/')) {
        imageUrl = url.origin + imageUrl;
      }
      body.imageUrl = imageUrl;
      body.imageUrlProxy = 'https://proxy.files.gg/download/' + encodeURIComponent(body.imageUrl);
    }
  }

  // check oembed
  return new ApiResponse(body);
});


export async function requestProxy(event, url) {
  if (InputTypes.boolean(event.url.searchParams.get('ip'))) {
    const ip = Array.from({length: 4}).map(() => Math.round(Math.random() * 255)).join('.');
    event.request.headers.set('cf-connecting-ip', ip);
    event.request.headers.set('true-client-ip', ip);
    event.request.headers.set('x-real-ip', ip);
  } else {
    event.request.headers.delete('cf-connecting-ip');
    event.request.headers.delete('true-client-ip');
    event.request.headers.delete('x-real-ip');
  }
  return await fetch(url, event.request);
};
