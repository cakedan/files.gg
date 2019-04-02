import m from 'mithril';

import { Api } from '../../api';
import {
  formatBytes,
  InputTypes,
  Mimetypes,
  snowflakeToTimestamp,
} from '../../utils';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
  TextTypes,
} from '../media';

import { CodeMirror } from '../codemirror';
import { Monaco } from '../monaco';


const Store = {
  line: null,
  textType: null,
  zoom: false,
};


const Tools = Object.freeze({
  get defaultTextType() {
    return (window.isMobile) ? TextTypes.CODEMIRROR: TextTypes.MONACO;
  },
  setRoute() {
    const params = new URLSearchParams();
    if (Store.textType !== this.defaultTextType) {
      params.append('textType', Store.textType);
    }
    if (Store.line !== null) {
      params.append('line', Store.line);
    }
    if (Store.zoom) {
      params.append('zoom', Store.zoom);
    }
    const route = [window.currentPath, params.toString()].filter((v) => v).join('?');
    if (route !== m.route.get()) {
      m.route.set(route, null, {replace: true});
    }
  },
});


export class FilePage {
  constructor(vnode) {
    Store.line = InputTypes.number(vnode.attrs.line, null);
    Store.textType = InputTypes.choices(Object.values(TextTypes), vnode.attrs.textType, Tools.defaultTextType);
    Store.zoom = InputTypes.boolean(vnode.attrs.zoom, false);

    this.loading = true;
    this.file = null;
    this.error = null;

    this.div = null;
    this.dragging = false;
    this.height = null;
    this.width = null;

    this.listeners = {
      mousemove: this.onMouseMove.bind(this),
      mouseup: this.onMouseUp.bind(this),
    };
    for (let listener in this.listeners) {
      window.addEventListener(listener, this.listeners[listener]);
    }
  }

  async oninit(vnode) {
    this.loading = true;
    try {
      this.file = vnode.attrs.file = await Api.fetchFile(vnode.attrs.fileId, {views: true});
      this.file.name = [this.file.filename, this.file.extension].filter((v) => v).join('.');
    } catch(error) {
      this.error = error;
    }
    this.loading = false;
    m.redraw();

    if (this.file && Mimetypes.isTextType(this.file.mimetype)) {
      try {
        this.file.data = await Api.request({url: this.file.urls.cdn, deserialize: (x) => x});
      } catch(error) {
        this.file.data = error;
      }
      console.log(this.file);
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
    this.width = Math.max(this.width, 0);
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
          (this.height !== null) ? `height: ${this.height}px` : null,
          (this.width !== null) ? `width: ${this.width}px` : null,
        ].filter((v) => v).join('; ') || undefined,
      }, [
        m('div', {class: 'thumbnail'}, [
          m(FileItem, {file: this.file, key: this.file.id}),
          m('div', {class: 'information'}, [
            m('span', this.file.name),
            m('span', this.file.mimetype),
          ]),
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
            m('i', {
              class: 'material-icons',
              onmousedown: (event) => this.onClick(event),
              ontouchstart: (event) => this.onClick(event),
              ontouchmove: (event) => this.onMouseMove(event),
              ontouchcancel: (event) => this.onMouseUp(event),
              ontouchend: (event) => this.onMouseUp(event),
            }, 'texture'),
          ]),
        ] : null,
      ]),
    ];
  }
}


class FileItem {
  oninit(vnode) {
    this.file = vnode.attrs.file;
    this.dimensions = {};
    this.showIcon = false;
  }

  get language() {
    switch (Store.textType) {
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
        return m(ImageMedia, {zoom: Store.zoom}, [
          m('img', {
            alt: this.file.name,
            src: this.file.urls.cdn,
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      if (Mimetypes.isTextType(this.file.mimetype)) {
        if (this.file.data === undefined) {
          return m(TextMedia, {value: 'loading file data...'});
        } else if (this.file.data instanceof Error) {
          return m(TextMedia, {
            value: [
              'couldn\'t fetch text data, sorry',
              String(this.file.data),
            ].join('\n'),
          });
        } else {
          const settings = {};
          switch (Store.textType) {
            case TextTypes.CODEMIRROR: {
              Object.assign(settings, {
                mode: this.language,
                readOnly: true,
                value: this.file.data,
              });
            }; break;
            case TextTypes.MONACO: {
              Object.assign(settings, {
                automaticLayout: true,
                language: this.language,
                readOnly: true,
                theme: 'vs-dark',
                value: this.file.data,
              });
            }; break;
          }
  
          return m(TextMedia, {
            type: Store.textType,
            settings: settings,
            oneditor: ({type, editor}) => {
              switch (type) {
                case TextTypes.CODEMIRROR: {
                  if (Store.line !== null) {
                    editor.setCursor(Store.line + 20);
                    editor.setSelection({
                      line: Store.line - 1,
                      ch: 0,
                    }, {
                      line: Store.line,
                      ch: 0,
                    });
                  }
                }; break;
                case TextTypes.MONACO: {
                  if (Store.line !== null) {
                    editor.revealLineInCenter(Store.line);
                    editor.setSelection(new Monaco.module.Range(Store.line, 1, Store.line + 1, 1));
                  }
                }; break;
              }
            },
            onselection: (event) => {
              switch (Store.textType) {
                case TextTypes.CODEMIRROR: {
                  if (event.line) {
                    Store.line = event.line + 1;
                  } else {
                    Store.line = null;
                  }
                  Tools.setRoute();
                }; break;
                case TextTypes.MONACO: {
                  const selection = event.selection;
                  if (
                    (selection.endColumn === 1) &&
                    (selection.startColumn === 1) &&
                    (selection.endLineNumber - selection.startLineNumber === 1)
                  ) {
                    Store.line = selection.startLineNumber;
                  } else {
                    Store.line = null;
                  }
                  Tools.setRoute();
                }; break;
              }
            },
          });
        }
      }

      if (Mimetypes.isVideoType(this.file.mimetype)) {
        return m(VideoMedia, {title: this.file.name}, [
          m('source', {
            src: this.file.urls.cdn,
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      this.showIcon = true;
    }
    // return thumbnail/icon
    return `icon for ${this.file.mimetype} and extension ${this.file.extension}`;
  }
}