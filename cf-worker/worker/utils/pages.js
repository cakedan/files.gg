// The legacy shell for the old frontend's pages (/auth, /dashboard, /details, /legal, /options),
// and the bot/embed routing that sends non-browsers straight to the CDN (docs/redesign/PLAN.md
// §1.4 item 3). Pure, so it is unit-tested.

import { element } from './html.js';


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


// Meta tags for the old frontend's pages (the legacy shell), exactly as the old router set them.
// The more specific routes only changed `description`, so they keep the default title.
export function legacyMetatags(pathname) {
  const path = pathname.replace(/(.)\/$/, '$1');
  const metatags = new Metatags();
  const set = (key, value) => metatags.set(key, value);
  const one = '[^/]+';

  const rules = [
    [new RegExp(`^/auth/callback/${one}$`), () => set('description', 'secret')],
    [/^\/auth\/login$/, () => set('description', 'Login here to view your files')],
    [/^\/auth\/logout$/, () => set('description', 'Logout here')],
    [new RegExp(`^/auth/forgot/${one}$`), () => set('description', 'Do not share this forgot password url with anyone')],
    [new RegExp(`^/auth/verify/${one}$`), () => set('description', 'Do not share this verify url with anyone')],
    [/^\/auth(\/.*)?$/, () => set('description', '??')],
    [/^\/dashboard\/configs$/, () => set('description', 'View your custom uploader configs here.')],
    [/^\/dashboard\/files(\/.*)?$/, () => set('description', 'View your files here.')],
    [/^\/dashboard(\/.*)?$/, () => set('title', 'File Uploader Dashboard')],
    [/^\/details(\/.*)?$/, () => set('description', '??')],
    [/^\/legal\/privacy$/, () => set('description', 'Our Privacy Policy')],
    [/^\/legal\/report$/, () => set('description', 'Report content')],
    [/^\/legal\/terms$/, () => set('description', 'Our Terms of Service')],
    [/^\/legal(\/.*)?$/, () => set('description', '??')],
    [new RegExp(`^/options(/${one})?$`), () => set('description', 'Customizable Options')],
    [/^\/options\/.*$/, () => set('description', '??')],
  ];
  for (const [pattern, apply] of rules) {
    if (pattern.test(path)) {
      apply();
      break;
    }
  }
  return metatags;
}
