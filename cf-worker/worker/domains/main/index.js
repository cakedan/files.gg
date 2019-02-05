import m from 'mithril/hyperscript';
import toHtml from 'mithril-node-render';

import { ApiError, DomainRouter } from 'cf-worker-router';
import { formatBytes } from '../../utils';

const router = new DomainRouter('(?:[w]{3}.)?files.gg');

class Metatags extends Map {
  constructor(tags) {
    super();

    for (let key in tags) {
      this.set(key, tags[key]);
    }
  }

  toHtml() {
    const tags = [];

    for (let [name, content] of this) {
      switch(name) {
        case 'favicon': {
          tags.push(m('link', {rel: 'icon', href: content}));
        }; break;
        case 'charset': {
          tags.push(m('meta', {charset: content}));
        }; break;
        case 'title': {
          tags.push(m(name, content));
        }; break;
        default: {
          tags.push(m('meta', {name, content}));
        };
      }
    }

    return tags;
  }
}


const defaultMetatags = {
  favicon: '/assets/favicon.ico',
  charset: 'UTF-8',
  title: 'File Uploader',
  description: 'Upload some files',
  'theme-color': '#43b581',
  'og:site_name': 'https://files.gg',
  'twitter:card': 'summary',
  //'twitter:site': '@filesgg',
};

const renderHtml = async(event, metatags) => {
  const manifestUrl = new URL(event.url);
  manifestUrl.pathname = '/assets/manifest.json';

  const manifestResponse = await fetch(manifestUrl, {
    method: 'GET',
    headers: event.request.headers,
  });

  const manifestHead = [];
  const manifestBody = [];
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json();
    manifestBody.push(m('div', {id: 'app'}));
  } else {
    manifestBody.push(m('span', 'script unavailable srry bro'));
  }

  const html = await toHtml([
    m.trust('<!DOCTYPE html>'),
    m('html', [
      m('head', [
        manifestHead,
        metatags.toHtml(),
      ]),
      m('body', manifestBody),
    ]),
  ]);
  return new Response(html, {headers: {'content-type': 'text/html'}});
};

router.route('/panel*', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('title', 'File Uploader Panel');
  return renderHtml(event, metatags);
});

router.route('/panel/files', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'View your files here.');
  return renderHtml(event, metatags);
});

router.route('/auth*', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route('/auth/callback', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'secret');
  return renderHtml(event, metatags);
});

router.route('/auth/login', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Login here to view your files');
  return renderHtml(event, metatags);
});

router.route('/auth/logout', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Logout here');
  return renderHtml(event, metatags);
});

router.route('/info*', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route('/info/terms', async(event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Our Terms of Service');
  return renderHtml(event, metatags);
});


const mimetypes = {
  audio: ['audio/mpeg', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-pn-wav', 'audio/x-wav'],
  image: ['image/png', 'image/x-citrix-png', 'image/x-png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/x-citrix-jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/ogg', 'video/avi', 'video/msvideo']
};
router.route('/:fileId...', async(event) => {
  const fileId = event.parameters.fileId.split('.').shift();

  const apiUrl = new URL(event.url);
  apiUrl.hostname = 'filesgg.appspot.com';
  apiUrl.pathname = '/files/' + fileId;

  const apiResponse = await fetch(apiUrl, {
    method: 'GET',
    headers: event.request.headers,
  });

  const metatags = new Metatags(defaultMetatags);
  if (apiResponse.ok) {
    const file = await apiResponse.json();
    const filename = [file.filename, file.extension].join('.');

    metatags.set('mimetype', file.mimetype);
    metatags.set('description', formatBytes(file.size, 2));
    metatags.set('url', file.urls.cdn);
    metatags.set('title', filename);

    metatags.set('[og:type]', 'article');
    //og:image is a thumbnail

    const mime = file.mimetype.split('/').shift();
    if (mime in mimetypes && mimetypes[mime].includes(file.mimetype)) {
      switch (mime) {
        case 'image': {
          metatags.set('og:image', file.urls.cdn);
          metatags.set('og:image:type', file.mimetype);
          metatags.set('og:image:height', file.height);
          metatags.set('og:image:width', file.width);
          metatags.set('og:image:alt', filename);

          metatags.set('twitter:card', 'summary_large_image');
          metatags.set('twitter:image', file.urls.cdn);
          metatags.set('twitter:image:alt', filename);
        }; break;
        case 'video': {
          metatags.set('og:type', 'video.other');
          metatags.set('og:video', file.urls.cdn);
          metatags.set('og:video:type', file.mimetype);
          metatags.set('og:video:height', file.height);
          metatags.set('og:video:width', file.width);
          metatags.set('og:video:alt', filename);
          metatags.set('video:duration', file.duration);

          metatags.set('twitter:card', 'player');
          metatags.set('twitter:player', file.urls.cdn);
          metatags.set('twitter:player:height', file.height);
          metatags.set('twitter:player:width', file.width);

          // thumbnail
          //metatags.set('twitter:image', null);
          //metatags.set('twitter:image:alt', null);
        }; break;
        case 'audio': {
          metatags.set('og:type', 'music.song');
          metatags.set('og:audio', file.urls.cdn);
          metatags.set('og:audio:type', file.mimetype);
          metatags.set('music:duration', file.duration);

          metatags.set('twitter:card', 'player');
          metatags.set('twitter:player', file.urls.cdn);

          // thumbnail
          //metatags.set('twitter:image', null);
          //metatags.set('twitter:image:alt', null);
        }; break;
      }
    }

    /*
    if (metatags.get('og:type') === 'article') {
      // ISO8601 Datetime based off the published
      metatags.set('article:published_time', null);
    }
    */
  } else {
    metatags.set('description', '404, file not found');
  }

  return renderHtml(event, metatags);
});

router.route('/assets*', async(event) => {
  let response = await fetch(event.request);
  if (!response.ok) {
    response = new ApiError({status: response.status});
  }
  return response;
});

export default router;
