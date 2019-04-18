import m from 'mithril/hyperscript';
import toHtml from 'mithril-node-render';

import { ApiRedirect, DomainRouter } from 'cf-worker-router';
import { requestApi } from './api';
import { requestStorage } from './cdn';
import { formatBytes } from '../utils';

export const router = new DomainRouter('(?:[w]{3}.)?files.gg');
const version = 'stable';

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
  'og:site_name': 'files.gg',
  'twitter:card': 'summary',
  //'twitter:site': '@filesgg',
  viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
};

const renderHtml = async (event, metatags) => {
  const manifestResponse = await requestStorage(event, {
    method: 'GET',
    path: `/assets/${version}/manifest.json`,
  });

  const manifestHead = [];
  const manifestBody = [];
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json();

    manifestHead.push([
      m('link', {
        rel: 'stylesheet',
        href: manifest.css,
        type: 'text/css',
      }),
      m('script', {
        src: manifest.js,
      }),
    ]);
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


router.route(['/auth', '/auth/*'], async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route('/auth/callback/:token', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'secret');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/login', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Login here to view your files');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/logout', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Logout here');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/forgot/:token', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Do not share this forgot password url with anyone');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/auth/verify/:token', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Do not share this verify url with anyone');
  return renderHtml(event, metatags);
}, {priority: 1});


router.route(['/dashboard', '/dashboard/*'], async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('title', 'File Uploader Dashboard');
  return renderHtml(event, metatags);
});

router.route('/dashboard/configs', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'View your custom uploader configs here.');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route(['/dashboard/files', '/dashboard/files/*'], async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'View your files here.');
  return renderHtml(event, metatags);
}, {priority: 1});


router.route(['/details', '/details/*'], async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});


router.route(['/legal', '/legal/*'], async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route('/legal/privacy', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Our Privacy Policy');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/legal/report', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Report content');
  return renderHtml(event, metatags);
}, {priority: 1});

router.route('/legal/terms', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Our Terms of Service');
  return renderHtml(event, metatags);
}, {priority: 1});


router.route('/options/*', async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', '??');
  return renderHtml(event, metatags);
});

router.route(['/options', '/options/:optionType'], async (event) => {
  const metatags = new Metatags(defaultMetatags);
  metatags.set('description', 'Customizable Options');
  return renderHtml(event, metatags);
}, {priority: 1});


const mimetypes = {
  audio: ['audio/mpeg', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-pn-wav', 'audio/x-wav'],
  image: ['image/png', 'image/x-citrix-png', 'image/x-png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/x-citrix-jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/ogg', 'video/avi', 'video/msvideo'],
};
router.route('/:fileId...', ['GET', 'HEAD'], async (event) => {
  const userAgent = event.request.headers.get('user-agent') || '';

  const metatags = new Metatags(defaultMetatags);
  if (event.url.pathname !== '/') {
    const fileId = event.parameters.fileId.split('.').shift();
    const apiResponse = await requestApi(event, {
      method: 'GET',
      path: `/files/${fileId}`,
    });

    if (apiResponse.ok) {
      const file = await apiResponse.json();
      const mime = file.mimetype.split('/').shift();

      if (userAgent.match(/sharex/i)) {
        return new ApiRedirect(file.urls.cdn);
      } else if (userAgent.match(/bot/i)) {
        // deal with special bots here
        if (userAgent.match(/telegrambot/i)) {
          return new ApiRedirect(file.urls.cdn);
        }
      } else {
        if (!event.request.headers.get('accept-language')) {
          // might be a forum embed, browsers usually have this when initially requesting
          return new ApiRedirect(file.urls.cdn);
        }

        const acceptedHeader = (event.request.headers.get('accept') || '').split(',').map((x) => x.split(';').shift().trim()).filter((v) => v);
        // Browsers always have this header, redirect if not here
        if (!acceptedHeader.length) {
          return new ApiRedirect(file.urls.cdn);
        }

        // Check if this is a forum embed request ({type}/*)
        if (mime in mimetypes) {
          const accepted = acceptedHeader.some((x) => x === `${mime}/*`);
          if (accepted) {
            return new ApiRedirect(file.urls.cdn);
          }
        }
      }

      metatags.set('mimetype', file.mimetype);
      metatags.set('description', formatBytes(file.size, 2));
      metatags.set('url', file.urls.cdn);
      metatags.set('title', file.filename);

      metatags.set('og:type', 'article');
      //og:image is a thumbnail

      if (mime in mimetypes && mimetypes[mime].includes(file.mimetype)) {
        switch (mime) {
          case 'image': {
            metatags.set('favicon', file.urls.cdn);
            metatags.set('og:image', file.urls.cdn);
            metatags.set('og:image:type', file.mimetype);
            metatags.set('og:image:height', file.height);
            metatags.set('og:image:width', file.width);
            metatags.set('og:image:alt', file.filename);

            metatags.set('twitter:card', 'summary_large_image');
            metatags.set('twitter:image', file.urls.cdn);
            metatags.set('twitter:image:alt', file.filename);
          }; break;
          case 'video': {
            metatags.set('og:type', 'video.other');
            metatags.set('og:video', file.urls.cdn);
            metatags.set('og:video:type', file.mimetype);
            metatags.set('og:video:height', file.height);
            metatags.set('og:video:width', file.width);
            metatags.set('og:video:alt', file.filename);
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
  }

  return renderHtml(event, metatags);
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
