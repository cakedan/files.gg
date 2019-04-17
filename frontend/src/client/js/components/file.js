import m from 'mithril';

import { Api } from '../api';
import {
  formatBytes,
  InputTypes,
  Mimetypes,
  snowflakeToTimestamp,
} from '../utils';

import {
  Store as Options,
} from '../utils/options';

import {
  AudioMedia,
  ImageMedia,
  PDFMedia,
  TextMedia,
  VideoMedia,
  TextTypes,
} from './media';

import {
  CodeMirror,
  Monaco,
} from './media/text/editors';


const Tools = Object.freeze({
  setRoute(options) {
    const params = new URLSearchParams();
    if (options.line !== null) {
      params.append('line', options.line);
    }
    const route = [window.currentPath, params.toString()].filter((v) => v).join('?');
    if (route !== m.route.get()) {
      m.route.set(route, null, {replace: true});
    }
  },
});


const PDF_MAX_SIZE = 10485760;
const TEXT_MAX_SIZE = 10485760;


export class FileModal {
  constructor(vnode) {
    if (vnode.attrs.textType !== undefined) {
      Options.textType = vnode.attrs.textType;
    }

    this.file = null;

    this.div = null;
    this.dragging = {height: false, width: false};
    this.height = null;
    this.width = null;

    this.listeners = {
      mousemove: this.onMouseMove.bind(this),
      mouseup: this.onMouseUp.bind(this),
      touchmove: this.onMouseMove.bind(this),
      touchcancel: this.onMouseUp.bind(this),
      touchend: this.onMouseUp.bind(this),
    };
  }

  async oninit(vnode) {
    if (vnode.attrs.file !== undefined && this.file !== vnode.attrs.file) {
      this.file = vnode.attrs.file;
      if (this.file.data === undefined) {
        if (Mimetypes.isTextType(this.file.mimetype)) {
          if (this.file.size < TEXT_MAX_SIZE) {
            this.file.data = null;
            try {
              this.file.data = await Api.request({url: this.file.urls.cdn, deserialize: (x) => x});
            } catch(error) {
              this.file.data = error;
            }
            console.log(this.file);
            m.redraw();
          }
        }
      }
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  oncreate(vnode) {
    this.div = vnode.dom;
    for (let listener in this.listeners) {
      window.addEventListener(listener, this.listeners[listener]);
    }
  }

  onremove(vnode) {
    this.div = null;
    for (let listener in this.listeners) {
      window.removeEventListener(listener, this.listeners[listener]);
    }
  }

  onMouseDown(event, height, width) {
    if (height) {
      this.dragging.height = true;
    }
    if (width) {
      this.dragging.width = true;
    }
  }

  onMouseMove(event) {
    if (!this.div) {return;}

    if (this.dragging.height || this.dragging.width) {
      let clientY, clientX;
      if (event.type.startsWith('touch')) {
        clientY = event.touches[0].clientY;
        clientX = event.touches[0].clientX;
      } else {
        clientY = event.clientY;
        clientX = event.clientX;
      }

      const rect = this.div.getBoundingClientRect();
      if (this.dragging.height) {
        const top = this.div.offsetHeight + rect.top;
        this.height = Math.min(clientY - top, window.innerHeight * 0.80) + this.div.offsetHeight;
        this.height = Math.max(this.height, 0);
      }
      if (this.dragging.width) {
        const left = this.div.offsetWidth + rect.left;
        this.width = Math.min(clientX - left, window.innerWidth * 0.70) + this.div.offsetWidth;
        this.width = Math.max(this.width, 0);
      }
      if (this.height === null) {
        this.height = this.div.offsetHeight;
      }
      if (this.width === null) {
        this.width = this.div.offsetWidth;
      }
      m.redraw();
    }
  }

  onMouseUp(event) {
    this.dragging.height = false;
    this.dragging.width = false;
  }

  view(vnode) {
    const date = new Date(snowflakeToTimestamp(this.file.id));
    return m('div', {
      class: 'modal-file',
      style: [
        (this.height !== null) ? `height: ${this.height}px` : null,
        (this.width !== null) ? `width: ${this.width}px` : null,
      ].filter((v) => v).join('; ') || undefined,
    }, [
      m('div', {class: 'thumbnail'}, [
        m(FileThumbnail, {
          file: this.file,
          key: this.file.id,
          onload: (event) => {
            console.log(event);
            if (this.height === null) {
              this.height = this.div.offsetHeight;
            }
            if (this.width === null) {
              this.width = this.div.offsetWidth;
            }
          },
          ...vnode.attrs,
        }),
      ]),
      m('div', {class: 'information'}, [
        m('span', this.file.name),
        m('span', this.file.mimetype),
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
            title: 'Download',
          }, 'file_download'),
        ]),
        m('span', {class: 'timestamp'}, [
          `Uploaded on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`,
        ]),
      ]),
      (!window.isMobile) ? [
        m('div', {class: 'resizer'}, [
          m('div', {
            class: 'height',
            onmousedown: (event) => this.onMouseDown(event, true, false),
            ontouchstart: (event) => this.onMouseDown(event, true, false),
          }),
          m('div', {
            class: 'width',
            onmousedown: (event) => this.onMouseDown(event, false, true),
            ontouchstart: (event) => this.onMouseDown(event, false, true),
          }),
          m('i', {
            class: 'both',
            onmousedown: (event) => this.onMouseDown(event, true, true),
            ontouchstart: (event) => this.onMouseDown(event, true, true),
          }, 'texture'),
        ]),
      ] : null,
    ]);
  }
}

class FileThumbnail {
  oninit(vnode) {
    console.log(vnode);
    this.file = vnode.attrs.file;
    this.line = InputTypes.number(vnode.attrs.line, null);

    this._showIcon = false;
  }

  onupdate(vnode) {
    if (vnode.attrs.line !== undefined) {
      this.line = InputTypes.number(vnode.attrs.line, null);
    }
  }

  get showIcon() {
    return this._showIcon;
  }

  set showIcon(value) {
    this._showIcon = !!value;
    m.redraw();
  }

  get language() {
    switch (Options.textType) {
      case TextTypes.CODEMIRROR: {
        const options = {
          languageId: this.file.extension,
          extension: this.file.extension,
          alias: this.file.extension,
        };
        if (this.file.mimetype !== 'text/plain') {
          options.mimetype = this.file.mimetype;
        }
        return (CodeMirror.getLanguage(options) || {}).mode;
      };
      case TextTypes.MONACO: {
        const options = {
          languageId: this.file.extension,
          extension: this.file.extension,
          alias: this.file.extension,
        };
        if (this.file.mimetype !== 'text/plain') {
          options.mimetype = this.file.mimetype;
        }
        return (Monaco.getLanguage(options) || {}).id;
      };
    }
  }

  view(vnode) {
    if (!this.showIcon) {
      // maybe parse xml/json, or add a button for it
      if (Mimetypes.isAudioType(this.file.mimetype)) {
        return m(AudioMedia, {title: this.file.name}, [
          m('source', {
            src: this.file.urls.cdn,
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      if (Mimetypes.isImageType(this.file.mimetype)) {
        return m(ImageMedia, [
          m('img', {
            alt: this.file.name,
            src: this.file.urls.cdn,
            onload: vnode.attrs.onload,
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      if (Mimetypes.isPDFType(this.file.mimetype)) {
        if (this.file.size < PDF_MAX_SIZE) {
          return m(PDFMedia, {
            type: this.file.mimetype,
            url: this.file.urls.cdn,
            onerror: () => this.showIcon = true,
          });
        }
      }

      if (Mimetypes.isTextType(this.file.mimetype)) {
        if (this.file.size < TEXT_MAX_SIZE) {
          if (this.file.data === undefined || this.file.data === null) {
            return m(TextMedia, {
              value: 'Loading File Data...',
            });
          } else if (this.file.data instanceof Error) {
            return m(TextMedia, {
              value: [
                'Failed to fetch File Data',
                String(this.file.data) || 'Unknown Error',
              ].join('\n'),
            });
           } else {
            const settings = {
              value: this.file.data,
            };

            switch (Options.textType) {
              case TextTypes.CODEMIRROR: {
                Object.assign(settings, {
                  mode: this.language,
                  readOnly: true,
                });
              }; break;
              case TextTypes.MONACO: {
                Object.assign(settings, {
                  language: this.language,
                  readOnly: true,
                });
              }; break;
              case TextTypes.NATIVE: {
                Object.assign(settings, {
                  readonly: true,
                });
              }; break;
            }
    
            return m(TextMedia, {
              type: Options.textType,
              settings: settings,
              oneditor: ({type, editor}) => {
                switch (type) {
                  case TextTypes.CODEMIRROR: {
                    if (this.line !== null) {
                      editor.setCursor(this.line + 20);
                      editor.setSelection({
                        line: this.line - 1,
                        ch: 0,
                      }, {
                        line: this.line,
                        ch: 0,
                      });
                    }
                  }; break;
                  case TextTypes.MONACO: {
                    if (this.line !== null) {
                      editor.revealLineInCenter(this.line);
                      editor.setSelection(new Monaco.module.Range(this.line, 1, this.line + 1, 1));
                    }
                  }; break;
                }
              },
              onselection: (event) => {
                switch (Options.textType) {
                  case TextTypes.CODEMIRROR: {
                    if (event.line) {
                      this.line = event.line + 1;
                    } else {
                      this.line = null;
                    }
                    Tools.setRoute({line: this.line});
                  }; break;
                  case TextTypes.MONACO: {
                    const selection = event.selection;
                    if (
                      (selection.endColumn === 1) &&
                      (selection.startColumn === 1) &&
                      (selection.endLineNumber - selection.startLineNumber === 1)
                    ) {
                      this.line = selection.startLineNumber;
                    } else {
                      this.line = null;
                    }
                    Tools.setRoute({line: this.line});
                  }; break;
                }
              },
            });
          }
        }
      }

      if (Mimetypes.isVideoType(this.file.mimetype)) {
        return m(VideoMedia, {title: this.file.name}, [
          m('source', {
            src: this.file.urls.cdn,
            onload: vnode.attrs.onload,
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      this.showIcon = true;
    }

    return m('div', {class: 'mime-icon'}, [
      m('i', {class: 'material-icons'}, 'insert_drive_file'),
    ]);
  }
}