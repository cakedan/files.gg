import m from 'mithril';

import Api from '../../api';
import {
  formatBytes,
  Mimetypes,
  snowflakeToTimestamp,
} from '../../utils';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
} from '../media';


class FileItem {
  oninit(vnode) {
    this.file = vnode.attrs.file;
    this.dimensions = {};
    this.showIcon = false;

    this._language = vnode.attrs.language;
  }

  get language() {
    if (this._language) {
      return this._language;
    }
    if (window.monaco && this._language !== null) {
      const mimetype = this.file.mimetype;
      const alias = mimetype.split('/').pop();
      const extension = `.${this.file.extension}`;

      const languages = window.monaco.languages.getLanguages();
      for (let language of languages) {
        if (language.aliases && language.aliases.includes(alias)) {
          this._language = language.id;
          break;
        } else if (language.mimetypes && language.mimetypes.includes(mimetype)) {
          this._language = language.id;
          break;
        } else if (language.extension && language.extensions.includes(extension)) {
          this._language = language.id;
          break;
        }
      }
      if (this._language === undefined) {
        this._language = null;
      }
    }
    return this._language;
  }

  view(vnode) {
    if (!this.showIcon) {
      // maybe parse xml/json, or add a button for it
      if (Mimetypes.isAudioType(this.file.mimetype)) {
        return m(AudioMedia, {
          src: this.file.urls.cdn,
          onerror: () => this.showIcon = true,
        });
        return m('audio', {controls: true}, [
          m('source', {
            src: this.file.urls.cdn,
            preload: 'metadata',
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      if (Mimetypes.isImageType(this.file.mimetype)) {
        return m(ImageMedia, {
          zoom: vnode.attrs.zoom,
          alt: this.file.name,
          src: this.file.urls.cdn,
          onerror: () => this.showIcon = true,
        });
      }

      if (Mimetypes.isTextType(this.file.mimetype)) {
        if (this.file.data === undefined) {
          return m(TextMedia, {
            useMonaco: false,
            value: 'loading file data...',
          });
        } else if (this.file.data === false) {
          return m(TextMedia, {
            useMonaco: false,
            value: 'couldn\'t fetch text data, sorry',
          });
        } else {
          return m(TextMedia, {
            useMonaco: vnode.attrs.monaco,
            settings: {
              automaticLayout: true,
              language: this.language,
              readOnly: true,
              theme: 'vs-dark',
              value: this.file.data,
            },
          });
        }
      }

      if (Mimetypes.isVideoType(this.file.mimetype)) {
        return m(VideoMedia, {
          src: this.file.urls.cdn,
          onerror: () => this.showIcon = true,
        });
      }

      this.showIcon = true;
    }
    // return thumbnail/icon
    return `icon for ${this.file.mimetype} and extension ${this.file.extension}`;
  }
}


export class FilePage {
  constructor(vnode) {
    if (typeof(vnode.attrs.zoom) !== 'boolean') {
      vnode.attrs.zoom = (vnode.attrs.zoom || '').toLowerCase() === 'true';
    }

    if (typeof(vnode.attrs.monaco) !== 'boolean') {
      vnode.attrs.monaco = (vnode.attrs.monaco || 'true').toLowerCase() === 'true';
    }

    this.loading = true;
    this.file = null;
    this.error = null;
  
    this.div = null;
    this.dragging = false;
    this.height = 0;
    this.width = 0;

    this.listeners = {
      mousemove: this.onMouseMove.bind(this),
      mouseup: this.onMouseUp.bind(this),
    };
    for (let listener in this.listeners) {
      window.addEventListener(listener, this.listeners[listener]);
    }
  }

  async oninit(vnode) {
    try {
      this.file = vnode.attrs.file = await Api.fetchFile(vnode.attrs.fileId);
      this.file.name = [this.file.filename, this.file.extension].filter((v) => v).join('.');
      console.log(this.file);
    } catch(error) {
      this.error = error;
      console.error(this.error);
    }
    this.loading = false;
    m.redraw();

    if (this.file && Mimetypes.isTextType(this.file.mimetype)) {
      try {
        this.file.data = await Api.request({url: this.file.urls.cdn, deserialize: (x) => x});
        console.log('loaded data into file', this.file);
      } catch(error) {
        this.file.data = false;
        console.error('error loading data into file', error);
      }
      m.redraw();
    }
  }

  onClick(event) {
    this.dragging = true;
    this.div = event.target;
  }

  onMouseMove(event) {
    if (!this.div || !this.dragging) {return;}
    const parent = this.div.parentNode;

    let clientY, clientX;
    if (event.type.startsWith('touch')) {
      clientY = event.touches[0].clientY;
      clientX = event.touches[0].clientX;
    } else {
      clientY = event.clientY;
      clientX = event.clientX;
    }

    const rect = this.div.getBoundingClientRect();
    //this.height = Math.min(clientY - rect.top, window.innerHeight * 0.80);
    this.width = Math.min(clientX - rect.left, window.innerWidth * 0.70) + parent.offsetWidth;
    m.redraw();
  }

  onMouseUp(event) {
    this.dragging = false;
  }

  onremove(vnode) {
    this.div = null;
    for (let listener in this.listeners) {
      window.removeEventListener(listener, this.listeners[listener]);
    }
  }

  view(vnode) {
    if (this.loading) {
      return m('div', {class: 'context'}, 'loading...');
    }
    if (this.error) {
      return m('div', {class: 'context'}, this.error.message);
    }

    const date = new Date(snowflakeToTimestamp(this.file.id));
    return [
      m('div', {
        class: 'context',
        style: [
          (this.height) ? `height: ${this.height}px` : null,
          (this.width) ? `width: ${this.width}px` : null,
        ].filter((v) => v).join('; ') || undefined,
      }, [
        m('div', {class: 'thumbnail'}, [
          m(FileItem, vnode.attrs),
          m('span', {class: 'information'}, this.file.name),
          m('span', {class: 'information'}, this.file.mimetype),
        ]),
        m('div', {class: 'footer'}, [
          m('div', {class: 'sections'}, [
            m('div', {class: 'section left'}, [
              m('span', {class: 'views'}, `${this.file.views.toLocaleString()} views`),
            ]),
            m('div', {class: 'section right'}, [
              m('span', {class: 'size'}, formatBytes(this.file.size, 2)),
            ]),
          ]),
          m('div', {class: 'buttons'}, [
            /*
            m('i', {
              class: 'copy-link material-icons',
            }, 'content_copy'),
            */
            m('a', {
              class: 'download material-icons',
              href: this.file.urls.cdn + '?download=true',
              download: this.file.name,
            }, 'file_download'),
          ]),
          m('span', {class: 'timestamp'}, [
            `Uploaded on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`,
          ]),
        ]),
        (!window.isMobile) ? [
          m('div', {class: 'resizer'}, [
            m('i', {
              class: 'material-icons',
              onmousedown: (event) => this.onClick(event),
              ontouchstart: (event) => this.onClick(event),
              ontouchmove: (event) => this.onMouseMove(event),
              ontouchcancel: (event) => this.onMouseUp(event),
              ontouchend: (event) => this.onMouseUp(event),
            }, 'rounded_corner'),
          ]),
        ] : null,
      ]),
    ];
  }
}