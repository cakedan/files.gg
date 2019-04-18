import m from 'mithril';
import { formatRelative } from 'date-fns';

import { Api } from '../api';
import {
  Browser,
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
    const route = [Browser.currentPath, params.toString()].filter((v) => v).join('?');
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
    this.dragging = {top: false, bottom: false, left: false, right: false};
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

  get canResize() {
    return !Browser.isMobile && !Browser.isInternetExplorer;
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

  onMouseDown(event, sides) {
    for (let side of sides) {
      this.dragging[side] = true;
    }
  }

  onMouseMove(event) {
    if (!this.div) {return;}

    if (this.dragging.top || this.dragging.bottom || this.dragging.left || this.dragging.right) {
      let clientY, clientX;
      if (event.type.startsWith('touch')) {
        clientY = event.touches[0].clientY;
        clientX = event.touches[0].clientX;
      } else {
        clientY = event.clientY;
        clientX = event.clientX;
      }

      const rect = this.div.getBoundingClientRect();
      if (this.dragging.top || this.dragging.bottom) {
        const maxHeight = window.innerHeight * 0.80;
        const minHeight = 0;

        if (this.dragging.top) {
          const top = rect.top;
          this.height = Math.min((clientY - top) * -1, maxHeight);
        }
        if (this.dragging.bottom) {
          const top = this.div.clientHeight + rect.top;
          this.height = Math.min(clientY - top, maxHeight);
        }
        this.height += this.div.clientHeight;
        this.height = Math.max(this.height, minHeight);
      }
      if (this.dragging.left || this.dragging.right) {
        const maxWidth = window.innerWidth * 0.70;
        const minWidth = 0;

        if (this.dragging.left) {
          const left = rect.left;
          this.width = Math.min((clientX - left) * -1, maxWidth);
        }
        if (this.dragging.right) {
          const left = this.div.clientWidth + rect.left;
          this.width = Math.min(clientX - left, maxWidth);
        }
        this.width += this.div.clientWidth;
        this.width = Math.max(this.width, minWidth);
      }
      if (this.height === null) {
        this.height = this.div.clientHeight;
      }
      if (this.width === null) {
        this.width = this.div.clientWidth;
      }
      m.redraw();
    }
  }

  onMouseUp(event) {
    for (let side in this.dragging) {
      this.dragging[side] = false;
    }
  }

  view(vnode) {
    const date = new Date(snowflakeToTimestamp(this.file.id));
    const uploadedText = `Uploaded ${formatRelative(date, new Date())}`;
    /*
    if (Browser.isMobile) {
      uploadedText = `Uploaded ${formatRelative(date, new Date())}`;
    } else {
      uploadedText = `Uploaded on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
    }
    */
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
          ondimensions: (event) => {
            // resize div so image/vidoes dont have the extra space for large images
            if (this.height === null || this.width === null) {
              const footerHeight = 146;
              let maxHeight = window.innerHeight * 0.90;
              let minHeight = 180;
              let maxWidth = window.innerWidth * 0.90;
              let minWidth = 400;

              if (Browser.isMobile) {
                maxHeight += 300;
                minWidth = 280;
              }

              let maxMediaHeight = maxHeight - footerHeight;
              let minMediaHeight = minHeight - footerHeight;
              let maxMediaWidth = maxWidth;
              let minMediaWidth = minWidth;

              const ratio = event.naturalHeight / event.naturalWidth;

              let height = event.naturalHeight;
              let width = event.naturalWidth;
              if (maxMediaHeight < event.naturalHeight || maxMediaWidth < event.naturalWidth) {
                // Scale Down
                // Height or Width bigger than max
                console.log('scale down');
                if (maxMediaHeight < event.naturalHeight && maxMediaWidth < event.naturalWidth) {
                  // Height and Width both bigger than max, scale both
                  console.log('scale both down');
                  if (maxMediaHeight < maxMediaWidth) {
                    // max height smaller than width, scale width
                    console.log('max height smaller than width, scale width');
                    height = maxMediaHeight;
                    width = height / ratio;
                  } else {
                    // max width smaller than height, scale height
                    console.log('max width smaller than height, scale height');
                    width = maxMediaWidth;
                    height = width * ratio;
                  }
                } else if (maxMediaHeight < event.naturalHeight) {
                  // Height bigger than max, scale width
                  console.log('height bigger than max, scale width');
                  height = maxMediaHeight;
                  width = height / ratio;
                } else if (maxMediaWidth < event.naturalWidth) {
                  // Width bigger than max, scale height
                  console.log('width bigger than max, scale height');
                  width = maxMediaWidth;
                  height = width * ratio;
                }
              } else if (event.naturalHeight < minMediaHeight || event.naturalWidth < minMediaWidth) {
                // Scale Up
                // Height or Width smaller than min
                console.log('scale up');
                if (event.naturalHeight < minMediaHeight && event.naturalWidth < minMediaWidth) {
                  // Height and Width smaller than min, scale both
                  console.log('scale both up');
                  if (minMediaHeight < minMediaWidth) {
                    // min height smaller than width, scale width
                    console.log('min height smaller than width, scale width');
                    height = minMediaHeight;
                    width = height / ratio;
                  } else {
                    // min width smaller than height, scale height
                    console.log('min width smaller than height, scale height');
                    width = minMediaWidth;
                    height = width * ratio;
                  }
                } else if (event.naturalHeight < minMediaHeight) {
                  // Height smaller than min, scale width
                  console.log('height smaller than min, scale width');
                  height = minMediaHeight;
                  width = height / ratio;
                } else if (event.naturalWidth < minMediaWidth) {
                  // Width smaller than min, scale height
                  console.log('width smaller than min, scale height');
                  width = minMediaWidth;
                  height = width * ratio;
                }
              } else {
                console.log('perfect');
              }
              console.log('scaled', {
                height: event.naturalHeight,
                width: event.naturalWidth,
              }, 'to', {height, width});
              this.height = height + footerHeight;
              this.width = width;
              /*
              // IDK MAN, RATIOS WRONG
              // 1920 x 888 === 873 x 888 should be 873 x 336.2375
              // 1017 x 1920 === 873 x 1728 should be 873 x 1372.5073746312685
              // 241 x 241 === 546 x 400 (minimum is 400x400, if under minimum then use minimum)
              // 1080 x 178 === 873 x 400 (but is 2426.9662921348317 x 400 rn lol)

              if (event.naturalHeight < event.naturalWidth) {
                // height smaller than width, change width first
                if (width < event.naturalWidth && height < event.naturalHeight) {
                  // is all good
                }
                if (width < event.naturalWidth) {
                  // width is smaller than naturalWidth, scale height
                  const percentage = (width / event.naturalWidth);
                  height = event.naturalHeight * percentage;
                }
                if (height < event.naturalHeight) {
                  // height is smaller than naturalHeight, scale width
                }
              }
              */
              /*
              if (maxMediaHeight < event.naturalHeight) {
                height = maxMediaHeight + footerHeight;
                width = event.naturalWith * (maxMediaHeight / event.naturalHeight);
              }
              */
              

              /*
              const height = this.div.clientHeight;
              const width = this.div.clientWidth;

              const imageHeight = height - 146;
              const imageWidth = width;

              if (event.naturalHeight < event.naturalWidth) {
                // height smaller than width, change only width

                if (imageWidth < event.naturalWidth) {
                  // image is smaller than the natural width, scale
                  const percentage = imageHeight / event.naturalHeight;
                  this.width = event.naturalWidth * percentage;
                }
              } else {
                // width smaller than height, change only height

                if (imageHeight < event.naturalHeight) {
                  const percentage = imageWidth / event.naturalWidth;
                  this.height = event.naturalHeight * percentage;
                }
              }
              if (this.height === null) {
                this.height = height;
              }
              if (this.width === null) {
                this.width = width;
              }
              // split
              if (event.naturalHeight < event.naturalWidth) {
                // height smaller

                if (event.naturalWidth < width) {
                  this.width = width;
                } else {
                  // 146 is the bottom portion of the file preview
                  const imageHeight = height - 146;
                  const percentage = imageHeight / event.naturalHeight;
                  this.width = event.naturalWidth * percentage;
                }
                this.height = height;
              } else {
                // width smaller
                if (event.naturalHeight < height) {
                  this.height = height;
                } else {
                  const imageWidth = width;
                  const percentage = imageWidth / event.naturalWidth;
                  this.height = event.naturalHeight * percentage;
                }
                this.width = width;
              }
              */
              m.redraw();
            }
          },
          ...vnode.attrs,
        }),
      ]),
      m('div', {class: 'footer'}, [
        m('div', {class: 'information'}, [
          m('span', this.file.filename),
          m('span', this.file.mimetype),
        ]),
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
            download: this.file.filename,
            title: 'Download',
          }, 'file_download'),
        ]),
        m('span', {class: 'timestamp'}, uploadedText),
      ]),
      (this.canResize) ? [
        m('div', {class: 'resizer'}, [
          m('div', {
            class: 'height top',
            onmousedown: (event) => this.onMouseDown(event, ['top']),
            ontouchstart: (event) => this.onMouseDown(event, ['top']),
          }),
          m('div', {
            class: 'height bottom',
            onmousedown: (event) => this.onMouseDown(event, ['bottom']),
            ontouchstart: (event) => this.onMouseDown(event, ['bottom']),
          }),
          m('div', {
            class: 'width left',
            onmousedown: (event) => this.onMouseDown(event, ['left']),
            ontouchstart: (event) => this.onMouseDown(event, ['left']),
          }),
          m('div', {
            class: 'width right',
            onmousedown: (event) => this.onMouseDown(event, ['right']),
            ontouchstart: (event) => this.onMouseDown(event, ['right']),
          }),
          m('i', {
            class: 'both',
            onmousedown: (event) => this.onMouseDown(event, ['right', 'bottom']),
            ontouchstart: (event) => this.onMouseDown(event, ['right', 'bottom']),
          }, 'texture'),
        ]),
      ] : null,
    ]);
  }
}

class FileThumbnail {
  oninit(vnode) {
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
        return m(AudioMedia, {title: this.file.filename}, [
          m('source', {
            src: this.file.urls.cdn,
            onerror: () => this.showIcon = true,
          }),
        ]);
      }

      if (Mimetypes.isImageType(this.file.mimetype)) {
        return m(ImageMedia, {
          ondimensions: vnode.attrs.ondimensions,
        }, [
          m('img', {
            alt: this.file.filename,
            src: this.file.urls.cdn,
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
        return m(VideoMedia, {
          ondimensions: vnode.attrs.ondimensions,
          title: this.file.filename,
        }, [
          m('source', {
            src: this.file.urls.cdn,
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
