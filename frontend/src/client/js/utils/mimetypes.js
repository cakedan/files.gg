import m from 'mithril';

import { Api } from '../api';
import { Browser } from './browser';


const defaultMimetypes = {
  audio: [
    'audio/3gpp',
    'audio/mp4',
    'audio/mp3',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/wave',
    'audio/x-m4a',
    'audio/x-wav',
  ],
  image: [
    'image/apng',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp',
  ],
  json: ['application/json'],
  pdf: ['application/pdf'],
  text: [
    'application/dart',
    'application/ecmascript',
    'application/edn',
    'application/javascript',
    'application/json',
    'application/mbox',
    'application/n-triples',
    'application/pgp',
    'application/pgp-encrypted',
    'application/pgp-keys',
    'application/pgp-signature',
    'application/sparql-query',
    'application/x-aspx',
    'application/x-cypher-query',
    'application/x-ejs',
    'application/x-erb',
    'application/x-httpd-php',
    'application/x-javascript',
    'application/x-jsp',
    'application/x-php',
    'application/x-powershell',
    'application/x-sh',
    'application/x-sql',
    'application/xquery',
  ],
  video: [
    'video/3gpp',
    'video/mp4',
    'video/ogg',
    'video/quicktime',
    'video/webm',
    'video/x-m4v',
  ],
  xml: ['application/xml', 'text/xml'],
};


class MimetypeStore extends Map {
  constructor() {
    super();
    this.loading = true;
    this.waiting = [];
  }

  get isLoading() {
    return !!this.loading;
  }

  set isLoading(value) {
    this.loading = !!value;
    if (!this.loading) {
      while (this.waiting.length) {
        (this.waiting.shift())();
      }
    }
    return this.loading;
  }

  async fetch() {
    this.isLoading = true;
    this.clear();

    try {
      const mimetypes = await Api.fetchMimetypes();
      for (let mimetype of mimetypes) {
        this.set(mimetype.mimetype, mimetype);
      }
    } catch(error) {
      console.error(error);
    }
    this.isLoading = false;
    m.redraw();
  }

  async wait() {
    if (this.isLoading) {
      await new Promise((resolve) => this.waiting.push(resolve));
    }
  }

  getFromExtension(extension) {
    const tempIgnore = ['application/octet-stream', 'text/plain'];

    extension = extension.toLowerCase();
    for (let mimetype of this.values()) {
      if (tempIgnore.includes(mimetype.mimetype)) {continue;}
      if (mimetype.extensions.some((ext) => ext.extension === extension)) {
        return mimetype;
      }
    }
    for (let mime in tempIgnore) {
      const mimetype = this.get(mime);
      console.log(mimetype);
      if (mimetype && mimetype.extensions.some((ext) => ext.extension === extension)) {
        return mimetype;
      }
    }
  }

  isAudioType(mimetype) {
    if (mimetype.split('/').shift() !== 'audio') {
      return false;
    }
    if (!defaultMimetypes.audio.includes(mimetype)) {
      return false;
    }

    switch (mimetype) {
      case 'audio/ogg': {
        // IE and Safari do not support these types
        if (Browser.isInternetExplorer || Browser.isSafari) {
          return false;
        }
      }; break;
      case 'audio/wav':
      case 'audio/wave':
      case 'audio/x-wav': {
        // IE does not support these types
        if (Browser.isInternetExplorer) {
          return false;
        }
      }; break;
    }

    return true;
  }

  isImageType(mimetype) {
    return defaultMimetypes.image.includes(mimetype);
  }

  isJsonType(mimetype) {
    if (defaultMimetypes.json.includes(mimetype)) {
      return true;
    }
    if (mimetype.endsWith('+json')) {
      return true;
    }
    return false;
  }

  isPDFType(mimetype) {
    return defaultMimetypes.pdf.includes(mimetype);
  }

  isSvgType(mimetype) {
    return mimetype === 'image/svg+xml';
  }

  isTextType(mimetype) {
    if (mimetype.split('/').shift() === 'text') {
      return true;
    }
    if (this.isJsonType(mimetype) || this.isXmlType(mimetype)) {
      return true;
    }
    return defaultMimetypes.text.includes(mimetype);
  }

  isVideoType(mimetype) {
    if (mimetype.split('/').shift() !== 'video') {
      return false;
    }
    if (!defaultMimetypes.video.includes(mimetype)) {
      return false;
    }

    switch (mimetype) {
      case 'video/mp4': {
        const isValidBrowser = Browser.satisfies({
          firefox: '>=21',
          opera: '>=25',
        });
        // these past versions do not support this mimetype
        // returns undefined if browser isnt listed here
        if (isValidBrowser === false) {
          return false;
        }
      }; break;
      case 'video/ogg':
      case 'video/webm': {
        // IE and Safari do not support these types
        if (Browser.isInternetExplorer || Browser.isSafari) {
          return false;
        }
      }; break;
      case 'video/x-m4v': {
        // Only Apple supports this type, something about itunes videos
        if (!Browser.isSafari) {
          return false;
        }
      }; break;
    }
    return true;
  }

  isXmlType(mimetype) {
    if (defaultMimetypes.xml.includes(mimetype)) {
      return true;
    }
    if (mimetype.endsWith('+xml')) {
      return true;
    }
    return false;
  }
}

export const Mimetypes = new MimetypeStore();
