import m from 'mithril';

import { Api } from '../api';
import { Auth, Fingerprint } from '../auth';

import {
  formatBytes,
  InputTypes,
  Mimetypes,
} from '../utils';

import { Store as Options } from '../utils/options';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
  TextTypes,
} from './media';

import {
  CodeMirror,
  Monaco,
} from './media/text/editors';


export const Store = {
  expand: false,
  isAtEnd: false,
  isFetching: false,
  isLoading: true,
  total: -1,
  files: {
    preview: [],
    uploading: [],
    uploaded: [],
  },
  textType: null,
};


export const UploadTypes = Object.freeze({
  AUDIO: 'audio',
  FILE: 'file',
  TEXT: 'text',
  UPLOAD: 'upload',
});

export const FileTypes = Object.freeze({
  PREVIEW: 'preview',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
});


export const Tools = Object.freeze({
  get defaultTextType() {
    return (window.isMobile) ? TextTypes.CODEMIRROR : TextTypes.MONACO;
  },
  async fetchFiles(options) {
    Store.isFetching = true;
    try {
      const lastFile = Store.files.uploaded[Store.files.uploaded.length - 1];
      let response;
      if (lastFile) {
        response = await Api.fetchFiles({
          before: lastFile.response.id,
        });
      } else {
        response = await Api.fetchFiles();
      }

      if (Store.total === -1) {
        Store.total = response.total;
      }
      if (response.files.length) {
        for (let upload of response.files) {
          const file = new FileObject({
            response: upload,
            type: FileTypes.UPLOADED,
            uploadType: FileTypes.UPLOAD,
          });
          Store.files.uploaded.push(file);
        }
        if (Store.total <= Store.files.uploaded.length) {
          Store.isAtEnd = true;
        }
      }
      Store.total = response.total;
    } catch(error) {
      console.error(error);
    }
    Store.isFetching = false;
    m.redraw();
  },
  refresh() {
    Store.isAtEnd = false;
    Store.total = -1;
    for (let file of Store.files.uploading) {
      file.abort();
    }
    Store.files.uploaded.length = 0;
    m.redraw();
  },
  addFiles(files) {
    if (files.length) {
      let expand = (!Store.files.preview.length && files.length === 1);
      if (window.currentPath !== '/') {
        expand = false;
      }
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const mimetype = file.type.split('/').shift();
        if (mimetype === 'audio' || mimetype === 'image' || mimetype === 'video') {
          file.url = URL.createObjectURL(file);
        }

        const fileObj = new FileObject({
          file: file,
          expand: expand,
          type: FileTypes.PREVIEW,
          uploadType: UploadTypes.FILE,
        });
        Store.files.preview.unshift(fileObj);
      }
      m.redraw();
    }
  },
});

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  event.stopPropagation();
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.stopPropagation();
});

// need to prevent dragenter && dragover for drop to work
window.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer.files.length) {
    if (window.currentPath !== '/') {
      Store.expand = true;
    }
    Tools.addFiles(event.dataTransfer.files);
  }
});




export class FilesModal {
  constructor(vnode) {
    this.input = null;
    if (vnode.attrs.expandFiles !== undefined) {
      Store.expand = InputTypes.boolean(vnode.attrs.expandFiles, false);
    }
  }

  async oninit(vnode) {
    await Auth.waitForAuth();
    if (!Auth.isAuthed && !Fingerprint.has) {return;}
    if (Store.isFetching || !Store.isLoading) {return;}
    Store.isLoading = true;
    await Tools.fetchFiles();
    Store.isLoading = false;
    m.redraw();
  }

  flipExpand(event) {
    event.preventDefault();
    Store.expand = !Store.expand;
  }

  view(vnode) {
    return m('div', {class: 'files-modal'}, [
      m('div', {
        class: 'main-expander',
        onclick: (event) => this.flipExpand(event),
      }, [
        m('i', {class: 'material-icons'}, (Store.expand) ? 'expand_more' : 'expand_less'),
      ]),
      (Store.expand) ? [
        m('div', {
          class: 'main-expanded-content',
          onscroll: async ({target}) => {
            if (Store.isAtEnd || Store.isFetching) {return;}
            const percentage = (target.scrollTop / target.scrollHeight) * 100;
            if (75 < percentage) {
              await Tools.fetchFiles();
            }
          },
        }, [
          m('div', {class: 'picker'}, [
            m('div', {
              class: 'text',
              onclick: (event) => {
                event.preventDefault();
                this.input && this.input.click();
              },
            }, [
              m('i', {class: 'material-icons'}, 'add_circle_outline'),
              m('span', 'Select File(s)'),
            ]),
            m.fragment({
              oncreate: ({dom}) => this.input = dom,
              onremove: () => this.input = null,
            }, [
              m('input', {
                multiple: true,
                type: 'file',
                onchange: ({target}) => {
                  Tools.addFiles(target.files);
                  target.value = '';
                },
              }),
            ]),
          ]),
          (Store.files.preview.length) ? [
            m('div', {class: 'divider'}, [
              m('span', {class: 'divider-line'}),
            ]),
            m('div', {class: 'files preview'}, Store.files.preview.map((file) => {
              return m(FileComponent, {file, key: file.key});
            })),
          ] : null,
          (Store.files.uploading.length) ? [
            m('div', {class: 'divider'}, [
              m('span', {class: 'divider-text'}, `Uploading ${Store.files.uploading.length.toLocaleString()} Files`),
            ]),
            m('div', {class: 'files uploading'}, Store.files.uploading.map((file) => {
              return m(FileComponent, {file, key: file.key});
            })),
          ] : null,
          (Store.isLoading) ? [
            m('div', {class: 'modal'}, [
              m('span', 'loading...'),
            ]),
          ] : [
            (Store.files.uploaded.length) ? [
              m('div', {class: 'divider'}, [
                m('span', {class: 'divider-text'}, [
                  `${Store.total.toLocaleString()} File${(Store.total !== 1) ? 's' : ''}`,
                ]),
              ]),
              m('div', {class: 'files uploaded'}, Store.files.uploaded.map((file) => {
                return m(FileComponent, {file, key: file.key});
              })),
            ] : [
              (!Store.isFetching) ? [
                m('div', {class: 'modal'}, [
                  m('span', 'upload some files man'),
                ]),
              ] : null,
            ],
            (Store.isFetching) ? [
              m('div', {class: 'modal'}, [
                m('span', 'fetching...'),
              ]),
            ] : null,
          ],
        ]),
      ] : null,
    ]);
  }
}


export class FileComponent {
  async oninit(vnode) {
    this.file = vnode.attrs.file;

    if (vnode.attrs.onupload !== undefined) {
      this.onupload = vnode.attrs.onupload;
    }

    if (!this.isFetching && this.expand) {
      // check if this is a fresh upload, if so ignore
      if (this.file.uploadType !== UploadTypes.TEXT) {
        if (this.file.response && Mimetypes.isTextType(this.file.mimetype)) {
          if (!this.file.data) {
            this.isFetching = true;
            try {
              this.file.data = await Api.request({
                url: this.file.response.urls.cdn,
                deserialize: (x) => x,
              });
            } catch(error) {
              this.file.data = error;
            }
            this.isFetching = false;
            m.redraw();
          }
        }
      }
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  get expand() {
    return this.file.expand && !this.file.error;
  }

  flipExpand(event) {
    event.preventDefault();
    if (!this.file.error) {
      this.file.expand = !this.file.expand;
    }
  }

  upload(event) {
    this.file.upload(event);
    if (this.onupload) {
      this.onupload(event);
    }
  }

  view(vnode) {
    let media;
    if (this.file.expand) {
      if (Mimetypes.isTextType(this.file.mimetype)) {
        if (this.file.data === undefined) {
          media = m(TextMedia, {value: 'loading file data...'});
        } else if (this.file.data instanceof Error) {
          media = m(TextMedia, {
            value: [
              'couldn\'t fetch text data, sorry',
              String(this.file.data),
            ].join('\n'),
          });
        } else {
          const settings = {
            readOnly: true,
            value: this.file.data,
          };
          switch (Options.textType) {
            case TextTypes.CODEMIRROR: {
              Object.assign(settings, {
                mode: (CodeMirror.getLanguage({
                  extension: this.file.extension,
                  mimetype: this.file.mimetype,
                }) || {}).mode,
              });
            }; break;
            case TextTypes.MONACO: {
              Object.assign(settings, {
                automaticLayout: true,
                language: (Monaco.getLanguage({
                  extension: this.file.extension,
                  mimetype: this.file.mimetype,
                }) || {}).id,
                theme: 'vs-dark',
              });
            }; break;
          }
          media = m(TextMedia, {
            type: Options.textType,
            settings: settings,
          });
        }
      } else {
        if (this.file.url) {
          switch (this.file.mimetype.split('/').shift()) {
            case 'audio': {
              media = m(AudioMedia, {title: this.file.name}, [
                m('source', {
                  src: this.file.url,
                  onerror: () => this.file.revokeUrl(),
                }),
              ]);
            }; break;
            case 'image': {
              media = m(ImageMedia, {title: this.file.name}, [
                m('img', {
                  alt: this.file.name,
                  src: this.file.url,
                  onerror: () => this.file.revokeUrl(),
                }),
              ]);
            }; break;
            case 'video': {
              media = m(VideoMedia, {title: this.file.name}, [
                m('source', {
                  src: this.file.url,
                  onerror: () => this.file.revokeUrl(),
                }),
              ]);
            }; break;
          }
        }
      }
    }

    return m('div', {class: 'file'}, [
      m('div', {class: 'header'}, [
        m('div', {class: 'icon'}, [
          m('span', {class: 'material-icons'}, 'insert_drive_file'),
        ]),
        m('div', {class: 'description'}, [
          m('div', {class: 'filename'}, [
            m('span', this.file.name),
          ]),
          m('div', {class: 'filesize'}, [
            m('span', formatBytes(this.file.size, 2)),
          ]),
        ]),
        m('div', {class: 'buttons'}, [
          (this.file.type === FileTypes.PREVIEW) ? [
            m('i', {
              class: 'action-upload material-icons',
              title: 'Upload',
              onclick: (event) => this.upload(event),
            }, 'cloud_upload'),
          ] : [
            (this.file.type === FileTypes.UPLOADING) ? [
              (this.file.error) ? [
                m('i', {
                  class: 'action-retry material-icons',
                  title: 'Retry',
                  onclick: (event) => this.upload(event),
                }, 'replay'),
              ] : null,
            ] : null,
          ],
          m('i', {
            class: 'action-remove material-icons',
            title: 'Remove',
            onclick: (event) => this.file.delete(event),
          }, 'close'),
        ]),
      ]),
      (this.file.error || this.file.response) ? [
        m('div', {class: 'footer'}, [
          (this.file.error) ? [
            m('span', this.file.error.message),
          ] : [
            m('span', this.file.response.urls.main),
          ],
        ]),
      ] : null,
      m('div', {
        class: [
          'expander',
          (this.file.error) ? 'error' : null,
          (this.expand) ? 'active' : null,
        ].filter((v) => v).join(' '),
        onclick: (event) => this.flipExpand(event),
        onmousedown: (event) => event.preventDefault(),
      }, [
        (this.file.error) ? [
          m('div', {class: 'fill error'}),
        ] : [
          m('div', {
            class: [
              'fill',
              (this.file.progress !== 100) ? 'filling' : null,
            ].filter((v) => v).join(' '),
            style: `width: ${this.file.progress}%`,
          }),
        ],
        (!this.file.error) ? [
          m('i', {class: 'material-icons'}, (this.expand) ? 'expand_less' : 'expand_more'),
        ] : null,
      ]),
      (this.expand) ? [
        m('div', {class: 'expanded-content'}, [
          (media) ? [
            m('div', {class: 'thumbnail'}, media),
          ] : [
            m('span', {class: 'mimetype'}, this.file.mimetype),
          ],
        ]),
      ] : null,
    ]);
  }
}


export class FileObject {
  constructor(options) {
    options = Object.assign({
      expand: false,
      file: null,
      response: null,
      type: FileTypes.PREVIEW,
      uploadType: UploadTypes.FILE,
    }, options);

    this._key = Math.random().toString(36).substr(2, 9);

    this.file = options.file;
    this.progress = 0;
    this.type = options.type;
    this.uploadType = options.uploadType;

    this.error = null;
    this.response = options.response;
    if (this.response) {
      this.progress = 100;
    }

    this.expand = !!options.expand;
    this.cdnUrlValid = true;

    this.xhr = null;

    this._data = undefined;
  }

  get key() {
    return (this.response) ? this.response.id : this._key;
  }

  get data() {
    if (this.file) {
      switch (this.uploadType) {
        case UploadTypes.TEXT: {
          return this.file.data;
        };
      }
    }
    if (this.response) {
      return this._data;
    }
  }

  set data(value) {
    if (this.response) {
      return this._data = value;
    }
  }

  get name() {
    if (this.response) {
      return `${this.response.filename}.${this.response.extension}`;
    }

    if (this.file) {
      switch (this.uploadType) {
        case UploadTypes.FILE: {
          return this.file.name;
        };
        case UploadTypes.TEXT: {
          const filename = this.file.name || 'random';
          if (this.file.extension) {
            return `${filename}.${this.file.extension}`;
          } else {
            return filename;
          }
        };
      }
    }
    return 'Unknown';
  }

  get extension() {
    if (this.response) {
      return this.response.extension;
    }

    if (this.file) {
      switch (this.uploadType) {
        case UploadTypes.FILE: return this.file.extension;
        case UploadTypes.TEXT: return this.file.extension;
      }
    }
    return 'unknown';
  }

  get mimetype() {
    if (this.response) {
      return this.response.mimetype;
    }
    if (this.file) {
      switch (this.uploadType) {
        case UploadTypes.FILE: {
          return this.file.type;
        };
        case UploadTypes.TEXT: {
          return this.file.blob.type;
        };
      }
    }
    return 'unknown';
  }

  get url() {
    if (this.response) {
      return (this.cdnUrlValid) ? this.response.urls.cdn : null;
    }

    if (this.file) {
      switch (this.uploadType) {
        case UploadTypes.FILE: {
          return this.file.url;
        };
      }
    }
    return null;
  }

  get size() {
    if (this.response) {
      return this.response.size;
    }

    if (this.file) {
      switch (this.uploadType) {
        case UploadTypes.FILE: {
          return this.file.size;
        };
        case UploadTypes.TEXT: {
          return this.file.blob.size;
        };
      }
    }
    return 0;
  }

  get iconUrl() {
    return 'icon';
  }

  setError(error) {
    console.log(error);
    this.error = error;
    m.redraw();
  }

  setResponse(response) {
    this.response = response;
    this.progress = 100;
    m.redraw();
  }

  setXhr(xhr) {
    this.xhr = xhr;
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        this.progress = Math.ceil((event.loaded / event.total) * 100);
        m.redraw();
      };
    }
  }

  abort() {
    if (!this.xhr) {return;}
    if (this.progress === 100) {return;}
    this.xhr.abort();
    this.xhr = null;
    this.progress = 0;
    this.setError(new Error('File Upload Aborted'));
  }

  revokeUrl() {
    if (this.response) {
      this.cdnUrlValid = false;
    }
    switch (this.uploadType) {
      case UploadTypes.FILE: {
        if (this.file.url) {
          URL.revokeObjectURL(this.file.url);
          this.file.url = null;
        }
      }; break;
    }
  }

  destroy() {
    this.revokeUrl();
  }

  async upload(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (this.response) {return;}
    this.error = null;

    switch (this.type) {
      case FileTypes.PREVIEW: {
        for (let key in Store.files.preview) {
          if (Store.files.preview[key] === this) {
            Store.files.preview.splice(key, 1);
            break;
          }
        }
        Store.files.uploading.unshift(this);
        this.type = FileTypes.UPLOADING;
        m.redraw();
      }; break;
    }

    try {
      const form = new FormData();
      switch (this.uploadType) {
        case UploadTypes.FILE: {
          form.append('file', this.file);
        }; break;
        case UploadTypes.TEXT: {
          form.append('file', this.file.blob);
          form.append('filename', this.name);
        }; break;
      }

      const response = await Api.uploadFile(form, {
        config: (xhr) => this.setXhr(xhr),
        serialize: (v) => v,
      });

      for (let key in Store.files.uploading) {
        if (Store.files.uploading[key] === this) {
          Store.files.uploading.splice(key, 1);
          break;
        }
      }

      this.type = FileTypes.UPLOADED;
      Store.files.uploaded.unshift(this);
      Store.total++;
      this.setResponse(response);
    } catch(error) {
      this.setError(error);
    }
    m.redraw();
  }

  async delete(event) {
    switch (this.type) {
      case FileTypes.PREVIEW: {
        this.revokeUrl();
        for (let key in Store.files.preview) {
          if (Store.files.preview[key] === this) {
            Store.files.preview.splice(key, 1);
            break;
          }
        }
      }; break;
      case FileTypes.UPLOADING: {
        if (!this.response && this.xhr) {
          return this.abort();
        }
        this.revokeUrl();
        for (let key in Store.files.uploading) {
          if (Store.files.uploading[key] === this) {
            Store.files.uploading.splice(key, 1);
            break;
          }
        }
      }; break;
      case FileTypes.UPLOADED: {
        //actually delete file
      }; break;
    }
  }
}