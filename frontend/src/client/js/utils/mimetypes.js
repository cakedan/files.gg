import m from 'mithril';
import Api from '../api';


const defaultMimetypes = {
  audio: ['audio/mp4', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-m4a', 'audio/x-wav'],
  image: ['image/apng', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
  json: ['application/json'],
  text: ['application/ecmascript', 'application/javascript', 'application/x-javascript', 'application/json'],
  video: ['video/mp4', 'video/ogg', 'video/quicktime', 'video/webm'],
  xml: ['application/xml', 'text/xml'],
};


class Mimetypes extends Map {
  constructor() {
    super();
    this.loading = true;
  }

  async fetch() {
    this.loading = true;
    this.clear();

    try {
      const mimetypes = await Api.fetchMimetypes();
      for (let mimetype of mimetypes) {
        this.set(mimetype.mimetype, mimetype);
      }
    } catch(error) {
      console.error(error);
    }
    this.loading = false;
    m.redraw();
  }

  getFromExtension(extension) {
    extension = extension.toLowerCase();
    for (let mimetype of this.values()) {
      if (mimetype.extensions.includes(extension)) {
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

    if (mimetype === 'audio/ogg') {
      const isValidBrowser = !window.browser.satisfies({
        'internet explorer': '>=0',
        safari: '>=0',
      });
      if (!isValidBrowser) {
        return false;
      }
    } else if (mimetype === 'audio/wav' || mimetype === 'audio/wave' || mimetype === 'audio/x-wav') {
      const isValidBrowser = !window.browser.satisfies({'internet explorer': '>=0'});
      if (!isValidBrowser) {
        return false;
      }
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

  isSvgType(mimetype) {
    return mimetype === 'image/svg+xml';
  }

  isTextType(mimetype) {
    if (mimetype.split('/').shift() === 'text') {
      return true;
    }
    if (mimetype.endsWith('+json')) {
      return true;
    }
    if (mimetype.endsWith('+xml')) {
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

    if (mimetype === 'video/mp4') {
      const isValidBrowser = window.browser.satisfies({
        firefox: '>=21',
        opera: '>=25',
      });
      // returns undefined if browser isnt listed here
      if (isValidBrowser === false) {
        return false;
      }
    } else if (mimetype === 'video/ogg' || mimetype === 'video/webm') {
      const isValidBrowser = !window.browser.satisfies({
        'internet explorer': '>=0',
        safari: '>=0',
      });
      if (!isValidBrowser) {
        return false;
      }
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

export default new Mimetypes();
