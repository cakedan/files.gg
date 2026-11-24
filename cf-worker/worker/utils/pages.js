// The files.gg page shell: <head> meta tags for the old SPA, and the bot/embed routing that sends
// non-browsers straight to the CDN (docs/redesign/PLAN.md §1.4 item 3). Pure, so it is unit-tested.

import { element } from './html.js';
import { formatBytes } from './tools.js';


export const DEFAULT_METATAGS = Object.freeze({
  favicon: '/assets/favicon.ico',
  charset: 'UTF-8',
  title: 'File Uploader',
  description: 'Upload some files',
  'theme-color': '#43b581',
  'og:site_name': 'files.gg',
  'twitter:card': 'summary',
  //'twitter:site': '@filesgg',
  viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
});


// Insertion-ordered; setting an existing key keeps its position (that order is the tag order).
export class Metatags extends Map {
  constructor(tags = DEFAULT_METATAGS) {
    super();
    for (const key in tags) {
      this.set(key, tags[key]);
    }
  }

  toHtml() {
    let html = '';
    for (const [name, content] of this) {
      switch (name) {
        case 'favicon': html += element('link', { rel: 'icon', href: content }); break;
        case 'charset': html += element('meta', { charset: content }); break;
        case 'title': html += element('title', {}, { text: content }); break;
        default: {
          // OpenGraph uses property=, everything else (twitter:*, description...) uses name=.
          const key = name.startsWith('og:') ? 'property' : 'name';
          html += element('meta', { [key]: name, content });
        }
      }
    }
    return html;
  }
}


// `manifest` is the parsed /assets/stable/manifest.json, or null when it couldn't be loaded.
export function renderDocument({ manifest, metatags }) {
  let head = '';
  let body = '';
  if (manifest) {
    head += element('link', { rel: 'stylesheet', href: manifest.css, type: 'text/css' });
    head += element('script', { src: manifest.js });
  } else {
    body += element('span', {}, { text: 'script unavailable srry bro' });
  }
  head += metatags.toHtml();
  return '<!DOCTYPE html>' + element('html', {}, {
    children: element('head', {}, { children: head }) + element('body', {}, { children: body }),
  });
}


export const EMBED_MIMETYPES = Object.freeze({
  audio: ['audio/mpeg', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-pn-wav', 'audio/x-wav'],
  image: ['image/png', 'image/x-citrix-png', 'image/x-png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/x-citrix-jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/ogg', 'video/avi', 'video/msvideo'],
});


// True when files.gg/<vanity> should 302 to the CDN instead of rendering the page:
// ShareX and Telegram, requests without Accept-Language or Accept, and `Accept: <type>/*` embeds.
export function shouldRedirectToCdn(headers, file) {
  const userAgent = headers.get('user-agent') || '';
  const mime = file.mimetype.split('/').shift();

  if (userAgent.match(/sharex/i)) {
    return true;
  }
  if (userAgent.match(/bot/i)) {
    // deal with special bots here
    return !!userAgent.match(/telegrambot/i);
  }
  if (!headers.get('accept-language')) {
    // might be a forum embed, browsers usually have this when initially requesting
    return true;
  }

  const accepted = (headers.get('accept') || '').split(',').map((x) => x.split(';').shift().trim()).filter((v) => v);
  // Browsers always have this header, redirect if not here
  if (!accepted.length) {
    return true;
  }

  // Check if this is a forum embed request ({type}/*)
  return (mime in EMBED_MIMETYPES) && accepted.some((x) => x === `${mime}/*`);
}


// Meta tags for files.gg/<vanity>; `file` is the API's file JSON, or null when it wasn't found.
export function fileMetatags(file) {
  const metatags = new Metatags();
  if (!file) {
    metatags.set('description', '404, file not found');
    return metatags;
  }

  const mime = file.mimetype.split('/').shift();
  metatags.set('mimetype', file.mimetype);
  metatags.set('description', formatBytes(file.size, 2));
  metatags.set('url', file.urls.cdn);
  metatags.set('title', file.filename);

  metatags.set('og:type', 'article');
  //og:image is a thumbnail

  if (mime in EMBED_MIMETYPES && EMBED_MIMETYPES[mime].includes(file.mimetype)) {
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
      }; break;
      case 'audio': {
        metatags.set('og:type', 'music.song');
        metatags.set('og:audio', file.urls.cdn);
        metatags.set('og:audio:type', file.mimetype);
        metatags.set('music:duration', file.duration);

        metatags.set('twitter:card', 'player');
        metatags.set('twitter:player', file.urls.cdn);
      }; break;
    }
  }
  return metatags;
}
