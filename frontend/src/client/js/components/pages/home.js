import m from 'mithril';
import md5 from 'crypto-js/md5';

import { Api } from '../../api';
import { Auth, Fingerprint } from '../../auth';

import { Head } from '../head';
import { formatBytes } from '../../utils';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
} from '../media';

import { Monaco } from '../monaco';


const UploadTypes = Object.freeze({
  AUDIO: 'audio',
  FILE: 'file',
  TEXT: 'text',
});

const defaultLanguageId = 'plaintext';
const defaultMimetype = 'application/octet-stream';
const defaultUploadType = UploadTypes.FILE;

const Store = {
  upload: {
    types: {
      [UploadTypes.AUDIO]: {},
      [UploadTypes.FILE]: {
        files: [],
      },
      [UploadTypes.TEXT]: {
        data: null,
        hashes: {
          current: null,
          last: null,
        },
        options: {
          filename: null,
          extension: 'txt',
          language: null,
          languageId: defaultLanguageId,
          type: 'text/plain',
        },
      },
    },
    settings: {
      type: 'file',
      vanity: null,
    },
  },
  showUploads: false,
  uploads: {
    isAtEnd: false,
    isFetching: false,
    total: 0,
    files: [],
    uploading: [],
  },
};


export class HomePage {
  constructor(vnode) {
    if (vnode.attrs.type !== undefined) {
      vnode.attrs.type = vnode.attrs.type.toLowerCase();
      if (vnode.attrs.type in Object.values(UploadTypes)) {
        Store.upload.settings.type = vnode.attrs.type;
      }
    }

    if (vnode.attrs.language !== undefined) {
      Store.upload.types.text.options.languageId = vnode.attrs.language;
    }
  }

  async oninit(vnode) {
    await Auth.waitForAuth();

    if (!Auth.isAuthed && !Fingerprint.has) {
      return;
    }

    Store.uploads.isFetching = true;
    try {
      const response = await Api.fetchFiles();
      if (response.total === response.files.length) {
        Store.uploads.isAtEnd = true;
      }
      if (response.files.length) {
        Store.uploads.total = response.total;
        for (let upload of response.files) {
          const file = new FileObject({
            response: upload,
            type: 'upload',
          });
          Store.uploads.files.push(file);
        }
        if (Store.uploads.files.length === response.total) {
          Store.uploads.files.isAtEnd = true;
        }
        m.redraw();
      }
    } catch(error) {
      console.error(error);
    }
    Store.uploads.isFetching = false;
  }

  view(vnode) {
    return m('div', {
      class: [
        'modal',
        (window.isMobile) ? 'mobile' : null,
      ].filter((v) => v).join(' '),
    }, [
      m(UploadModal, vnode.attrs),
      m('div', {class: 'divider'}),
      m('div', {class: 'information'}, [
        (Store.showUploads) ? [
          m('div', {
            class: 'uploads',
            onscroll: async ({target}) => {
              // if like 80% through, fetch more files if not at end
              // scrollTop and scrollHeight
              const percentage = (target.scrollTop / target.scrollHeight) * 100;
              if (percentage < 85) {
                return;
              }
              if (Store.uploads.isAtEnd || Store.uploads.isFetching) {
                return;
              }
              Store.uploads.isFetching = true;
              try {
                const lastFile = Store.uploads.files[Store.uploads.files.length - 1];
                const response = await Api.fetchFiles({
                  before: lastFile.response.id,
                });
                Store.uploads.total = response.total;
                if (response.files.length) {
                  for (let upload of response.files) {
                    const file = new FileObject({
                      response: upload,
                      type: 'upload',
                    });
                    Store.uploads.files.push(file);
                  }
                  if (Store.uploads.files.length === response.total) {
                    Store.uploads.isAtEnd = true;
                  }
                  m.redraw();
                }
              } catch(error) {
                console.error(error);
              }
              Store.uploads.isFetching = false;
            },
          }, [
            (Store.uploads.uploading.length) ? [
              m('div', {class: 'uploads-divider'}, [
                m('span', `Uploading ${Store.uploads.uploading.length.toLocaleString()} Files`),
              ]),
              Store.uploads.uploading.map((file) => m(UploadedFile, {file})),
            ] : null,
            (Store.uploads.files.length) ? [
              m('div', {class: 'uploads-divider'}, [
                m('span', `Uploaded ${Store.uploads.total.toLocaleString()} Files`),
              ]),
              Store.uploads.files.map((file) => m(UploadedFile, {file})),
            ] : null,
          ]),
        ] : [
          m('div', {class: 'introduction'}, [
            m('div', {class: 'header'}, [
              m('div', {class: 'text'}, [
                m('span', {class: 'title'}, 'Some File Uploader'),
                m('span', {class: 'description'}, 'Just upload some files, more updates coming soon.'),
              ]),
            ]),
            m('div', {class: 'footer'}),
          ]),
        ],
        (Store.uploads.files.length) ? [
          m('div', {class: 'flipper'}, [
            m('span', {
              onclick: () => Store.showUploads = !Store.showUploads,
            }, `Show ${(Store.showUploads) ? 'Introduction' : 'Files'}`),
          ]),
        ] : null,
      ]),
    ]);
  }
}


class UploadedFile {
  oninit(vnode) {
    this.file = vnode.attrs.file;

    if (vnode.attrs.expand !== undefined) {
      this.expand = vnode.attrs.expand;
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  get expand() {
    return this.file.expand;
  }

  set expand(value) {
    return this.file.expand = !!value;
  }

  setExpand(event, expand) {
    event.preventDefault();
    return this.expand = expand;
  }

  remove() {
    if (this.file.error) {
      for (let key in Store.uploads.uploading) {
        if (Store.uploads.uploading[key] === this.file) {
          Store.uploads.uploading.splice(key, 1);
          m.redraw();
          break;
        }
      }
      return this.file.destroy();
    }
    if (this.file.progress !== 100) {
      return this.file.abort();
    }
    // delete file from api now
  }

  async retry() {
    if (!this.file.error) {return;}
    this.file.error = null;

    // retry upload
    try {
      const form = new FormData();

      switch (this.file.type) {
        case UploadTypes.FILE: {
          form.append('file', this.file.file);
        }; break;
        case UploadTypes.TEXT: {
          form.append('file', this.file.file.blob);
          form.append('filename', this.file.name);
        }; break;
      }

      const response = await Api.uploadFile(form, {
        config: (xhr) => this.file.setXhr(xhr),
        serialize: (v) => v,
      });

      for (let key in Store.uploads.uploading) {
        if (Store.uploads.uploading[key] === this.file) {
          Store.uploads.uploading.splice(key, 1);
          break;
        }
      }

      Store.uploads.files.unshift(this.file);
      Store.uploads.total++;
      this.file.setResponse(response);
    } catch(error) {
      this.file.setError(error);
    }
    m.redraw();
  }

  view(vnode) {
    // remember to revoke upload.file.url if exists if delete
    if (!this.file) {
      return 'error';
    }

    let media;
    if (this.expand && this.file.url) {
      switch (this.file.mimetype.split('/').shift()) {
        case 'audio': {
          media = m(AudioMedia, {
            title: this.file.name,
            src: this.file.url,
            onerror: () => this.file.revokeUrl(),
          });
        }; break;
        case 'image': {
          media = m(ImageMedia, {
            title: this.file.name,
            src: this.file.url,
            onerror: () => this.file.revokeUrl(),
          });
        }; break;
        case 'video': {
          media = m(VideoMedia, {
            title: this.file.name,
            src: this.file.url,
            onerror: () => this.file.revokeUrl(),
          });
        }; break;
      }
    }

    return m('div', {class: 'uploaded-file'}, [
      m('div', {class: 'information'}, [
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
          (this.file.error) ? [
            m('span', {
              class: 'action-retry material-icons',
              title: 'Retry',
              onclick: () => this.retry(),
            }, 'replay'),
          ] : null,
          // retry button?
          m('span', {
            class: 'action-remove material-icons',
            title: 'Remove',
            onclick: () => this.remove(),
          }, 'close'),
        ]),
      ]),
      m('div', {class: 'upload-progress'}, [
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
      (!this.file.error) ? [
        (this.expand) ? [
          m('div', {
            class: 'expander deactivate',
            onmousedown: (event) => this.setExpand(event, false),
          }, [
            m('span', {class: 'material-icons'}, 'expand_less'),
          ]),
          m('div', {class: 'expanded-content'}, [
            (media) ? [
              m('div', {class: 'thumbnail'}, media),
            ] : [
              m('span', {class: 'mimetype'}, this.file.mimetype),
            ],
          ]),
        ] : [
          m('div', {
            class: 'expander',
            onmousedown: (event) => this.setExpand(event, true),
          }, [
            m('span', {class: 'material-icons'}, 'expand_more'),
          ]),
        ],
      ] : null,
    ]);
  }
}


class UploadTypeButton {
  get type() {
    return Store.upload.settings.type;
  }

  set type(value) {
    return Store.upload.settings.type = value;
  }

  view(vnode) {
    const type = vnode.attrs.type;
    return m('span', {
      class: (this.type === type) ? 'active' : undefined,
      onclick: () => this.type = type,
    }, vnode.children);
  }
}


class UploadModal {
  get type() {
    return Store.upload.settings.type;
  }

  set type(value) {
    return Store.upload.settings.type = value;
  }

  view(vnode) {
    let UploadComponent = FileUpload;
    switch (this.type) {
      case UploadTypes.AUDIO: UploadComponent = AudioUpload; break;
      case UploadTypes.FILE: UploadComponent = FileUpload; break;
      case UploadTypes.TEXT: UploadComponent = TextUpload; break;
    }

    return m('div', {class: 'upload'}, [
      m('div', {class: 'types'}, [
        m(UploadTypeButton, {type: UploadTypes.AUDIO}, 'Audio'),
        m(UploadTypeButton, {type: UploadTypes.FILE}, 'File'),
        m(UploadTypeButton, {type: UploadTypes.TEXT}, 'Text'),
      ]),
      m('div', {class: 'component'}, [
        m(UploadComponent),
      ]),
    ]);
  }
}


class UploadType {
  constructor(vnode) {
    this.type = vnode.attrs.type;
  }

  oninit(vnode) {
    this.setRoute();
  }

  setRoute() {
    const params = new URLSearchParams();
    if (this.type === UploadTypes.TEXT) {
      if (this.upload.options.languageId !== defaultLanguageId) {
        params.append('language', this.upload.options.languageId);
      }
    }
    if (this.type !== defaultUploadType) {
      params.append('type', this.type);
    }

    const route = ['/', params.toString()].join('?');
    m.route.set(route, null, {replace: true});
  }

  get upload() {
    return Store.upload.types[this.type];
  }

  get canUpload() {
    return false;
  }
}


class AudioUpload extends UploadType {
  constructor(vnode) {
    vnode.attrs.type = UploadTypes.AUDIO;
    super(vnode);
  }

  view(vnode) {
    return m('div', {class: 'upload-modal audio'}, [
      m('span', 'Coming Soon'),
    ]);
  }
}


class FileUpload extends UploadType {
  constructor(vnode) {
    vnode.attrs.type = UploadTypes.FILE;
    super(vnode);

    this.input = null;
  }

  get files() {
    return this.upload.files;
  }

  addFiles(files) {
    if (!this.files.length && files.length === 1) {
      files[0].expand = true;
    }
    for (let i = 0; i < files.length; i++) {
      this.addFile(files[i]);
    }
    m.redraw();
  }

  addFile(value) {
    value.mimetype = value.type.split('/').shift();
    if (value.mimetype === 'audio' || value.mimetype === 'image' || value.mimetype === 'video') {
      value.url = URL.createObjectURL(value);
    }
    this.files.push(value);
  }

  view(vnode) {
    return m('div', {class: 'upload-modal file'}, [
      (this.files.length) ? [
        m('div', {class: 'selected-files'}, [
          m('div', {class: 'files'}, [
            this.files.map((file, id) => {
              return m(FileComponent, {file, id});
            }),
          ]),
          m('div', {class: 'selector'}, [
            m('div', {
              class: 'picker',
              title: 'Select Files',
              onmousedown: () => this.input && this.input.click(),
            }, [
              m('div', {class: 'text'}, [
                m('span', {class: 'material-icons'}, 'add_circle_outline'),
                m('span', 'Select Files'),
              ]),
            ]),
          ]),
          m('div', {class: 'settings'}, [

          ]),
        ]),
      ] : [
        m('div', {
          class: 'drag-n-drop picker',
          onmousedown: () => this.input && this.input.click(),
        }, [
          m('div', {class: 'content'}, [
            m('span', 'Select Files'),
          ]),
        ]),
      ],
      m(FileInput, {
        multiple: 'true',
        type: 'file',
        onchange: ({target}) => {
          this.addFiles(target.files);
          target.value = '';
        },
        ondom: (dom) => this.input = dom,
      }),
    ]);
  }
}


class TextUpload extends UploadType {
  constructor(vnode) {
    vnode.attrs.type = UploadTypes.TEXT;
    super(vnode);
  }

  get canUpload() {
    if (this.upload.hashes.current === this.upload.hashes.last) {
      return false;
    }
    return !!this.upload.data;
  }

  get data() {
    return this.upload.data;
  }

  set data(value) {
    this.upload.data = value;
    this.upload.hashes.last = this.upload.hashes.current;
    this.upload.hashes.current = md5(value).toString();

    return value;
  }

  get options() {
    return this.upload.options;
  }

  async tryUpload() {
    if (!this.canUpload) {
      return;
    }
    this.upload.hashes.last = this.upload.hashes.current;

    let filename = 'random';
    if (this.upload.options.filename) {
      filename = [this.upload.options.filename, this.upload.options.extension].filter((v) => v).join('.');
    }

    const blob = new Blob([this.upload.data], {type: this.upload.options.type});
    const file = new FileObject({
      file: {
        blob: blob,
        extension: this.upload.options.extension,
        name: filename,
      },
      type: UploadTypes.TEXT,
    });
    Store.uploads.uploading.unshift(file);
    Store.upload.types.file.files.splice(this.id, 1);
    Store.showUploads = true;
    m.redraw();

    try {
      const form = new FormData();
      form.append('file', blob);
      form.append('filename', filename);

      const response = await Api.uploadFile(form, {
        config: (xhr) => file.setXhr(xhr),
        serialize: (v) => v,
      });

      for (let key in Store.uploads.uploading) {
        if (Store.uploads.uploading[key] === file) {
          Store.uploads.uploading.splice(key, 1);
          break;
        }
      }

      Store.uploads.files.unshift(file);
      Store.uploads.total++;
      file.setResponse(response);
    } catch(error) {
      file.setError(error);
    }
    m.redraw();
  }

  view(vnode) {
    return m('div', {class: 'upload-modal text'}, [
        m('div', {class: 'languages'}, [
          m('select', {
            onchange: ({target}) => {
              if (target.selectedOptions.length) {
                let languageId = target.selectedOptions[0].value;
                if (!Monaco.languages.some((language) => language.id === languageId)) {
                  languageId = 'plaintext';
                }
                if (this.options.languageId !== languageId) {
                  this.options.languageId = languageId;
                  this.setRoute();
                }
              }
            },
          }, [
            Monaco.languages.map((language) => {
              const selected = this.options.languageId === language.id;
              if (selected) {
                if (this.options.language !== language) {
                  this.options.language = language;
                  if (language.mimetypes) {
                    this.options.extension = (language.extensions[0] || 'txt').split('.').pop();
                    this.options.type = language.mimetypes[0];
                  } else {
                    this.options.extension = 'txt';
                    this.options.type = 'text/plain';
                  }
                }
              }

              return m('option', {
                selected: selected,
                value: language.id,
              }, language.id);
            }),
          ]),
        ]),
        m(TextMedia, {
          onvalue: ({value}) => this.data = value,
          settings: {
            automaticLayout: true,
            language: (this.options.language) ? this.options.language.id : 'plaintext',
            theme: 'vs-dark',
            value: this.data,
          },
        }),
        m('div', {class: 'submit'}, [
          (this.canUpload) ? [
            m('span', {
              title: 'Upload',
              onclick: () => this.tryUpload(),
            }, 'Upload'),
          ] : [
            m('span', {
              class: 'disabled',
              title: (!this.upload.data) ? 'Text Required' : 'Already Uploaded',
            }, 'Upload'),
          ],
        ]),
    ]);
  }
}


class FileComponent {
  oninit(vnode) {
    this.file = vnode.attrs.file;
    this.id = vnode.attrs.id;

    if (vnode.attrs.expand !== undefined) {
      this.expand = vnode.attrs.expand;
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  get expand() {
    return this.file.expand;
  }

  set expand(value) {
    return this.file.expand = !!value;
  }

  get mimetype() {
    return this.file.mimetype;
  }

  get iconUrl() {
    return null;
  }

  setExpand(event, expand) {
    event.preventDefault();
    return this.expand = expand;
  }

  revokeUrl() {
    if (this.file.url) {
      URL.revokeObjectURL(this.file.url);
      this.file.url = null;
    }
  }

  async upload() {
    const file = new FileObject({
      expand: this.expand,
      file: this.file,
      type: UploadTypes.FILE,
    });
    Store.uploads.uploading.unshift(file);
    Store.upload.types.file.files.splice(this.id, 1);
    Store.showUploads = true;
    m.redraw();

    try {
      const form = new FormData();
      form.append('file', this.file);
      const response = await Api.uploadFile(form, {
        config: (xhr) => file.setXhr(xhr),
        serialize: (v) => v,
      });

      for (let key in Store.uploads.uploading) {
        if (Store.uploads.uploading[key] === file) {
          Store.uploads.uploading.splice(key, 1);
          break;
        }
      }

      Store.uploads.files.unshift(file);
      Store.uploads.total++;
      file.setResponse(response);
    } catch(error) {
      file.setError(error);
    }
    m.redraw();
  }

  remove() {
    this.revokeUrl();
    Store.upload.types.file.files.splice(this.id, 1);
    m.redraw();
  }

  view(vnode) {
    if (!this.file) {
      return 'error';
    }

    let media;
    if (this.expand && this.file.url) {
      switch (this.file.mimetype) {
        case 'audio': {
          media = m(AudioMedia, {
            title: this.file.name,
            src: this.file.url,
            onerror: () => this.revokeUrl(),
          });
        }; break;
        case 'image': {
          media = m(ImageMedia, {
            title: this.file.name,
            src: this.file.url,
            onerror: () => this.revokeUrl(),
          });
        }; break;
        case 'video': {
          media = m(VideoMedia, {
            title: this.file.name,
            src: this.file.url,
            onerror: () => this.revokeUrl(),
          });
        }; break;
      }
    }
  
    return m('div', {class: 'file'}, [
      m('div', {class: 'information'}, [
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
          m('span', {
            class: 'action-upload material-icons',
            title: 'Upload',
            onclick: () => this.upload(),
          }, 'cloud_upload'),
          m('span', {
            class: 'action-remove material-icons',
            title: 'Remove',
            onclick: () => this.remove(),
          }, 'close'),
        ]),
      ]),
      (this.expand) ? [
        m('div', {
          class: 'expander deactivate',
          onmousedown: (event) => this.setExpand(event, false),
        }, [
          m('span', {class: 'material-icons'}, 'expand_less'),
        ]),
        m('div', {class: 'expanded-content'}, [
          (media) ? [
            m('div', {class: 'thumbnail'}, media),
          ] : [
            m('span', {class: 'mimetype'}, this.file.type),
          ],
        ]),
      ] : [
        m('div', {
          class: 'expander',
          onmousedown: (event) => this.setExpand(event, true),
        }, [
          m('span', {class: 'material-icons'}, 'expand_more'),
        ]),
      ],
    ]);
  }
}


// use fragments instead, it was glitching out tho
class FileInput {
  oninit(vnode) {
    this.ondom = vnode.attrs.ondom;

    this._dom = null;
  }

  get dom() {
    return this._dom;
  }

  set dom(value) {
    this._dom = value;
    if (typeof(this.ondom) === 'function') {
      this.ondom(value);
    }
    return this._dom;
  }

  oncreate(vnode) {
    this.dom = vnode.dom;
  }

  onremove(vnode) {
    this.dom = null;
  }

  view(vnode) {
    return m('input', vnode.attrs);
  }
}


class FileObject {
  constructor(options) {
    options = Object.assign({
      expand: false,
      file: null,
      response: null,
      type: UploadTypes.FILE,
    }, options);

    this.file = options.file;
    this.progress = 0;
    this.type = options.type;

    this.error = null;
    this.response = options.response;
    if (this.response) {
      this.progress = 100;
    }

    this.expand = !!options.expand;
    this.cdnUrlValid = true;

    this.xhr = null;
  }

  get name() {
    if (this.response) {
      return `${this.response.filename}.${this.response.extension}`;
    }

    if (this.file) {
      switch (this.type) {
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

  get mimetype() {
    if (this.response) {
      return this.response.mimetype;
    }
    if (this.file) {
      switch (this.type) {
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
      if (this.cdnUrlValid) {
        return this.response.urls.cdn;
      } else {
        return null;
      }
    }

    if (this.file) {
      switch (this.type) {
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
      switch (this.type) {
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
    switch (this.type) {
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
}
