import m from 'mithril';

import { Api } from '../../api';
import { Head } from '../head';
import { formatBytes } from '../../utils';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
} from '../media';


const defaultMimetype = 'application/octet-stream';

const Store = {
  upload: {
    types: {
      audio: {},
      file: {
        files: [],
      },
      text: {
        data: null,
        hashCurrent: null,
        hashLast: null,
        options: {
          filename: 'random',
          extension: 'txt',
          language: null,
          languageId: null,
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
  uploads: [],
};

const uploadTypes = ['audio', 'file', 'text'];


export class HomePage {
  constructor(vnode) {
    if (vnode.attrs.type !== undefined) {
      vnode.attrs.type = vnode.attrs.type.toLowerCase();
      if (uploadTypes.includes(vnode.attrs.type)) {
        Store.upload.settings.type = vnode.attrs.type;
      }
    }

    if (vnode.attrs.language !== undefined) {
      Store.upload.types.text.options.languageId = vnode.attrs.language;
    }
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
        (Store.showUpload) ? [
          m('div', {class: 'uploads'}, [
            Store.uploads.map((upload) => {
              if (upload.response) {
                return m('span', upload.response.urls.main);
              } else {
                if (upload.error) {
                  return m('span', `uploading failed: reason '${upload.error}'`);
                } else {
                  return m('span', `uploading ${upload.type}... ${upload.progress}%`);
                }
              }
            }),
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
        (Store.uploads.length) ? [
          m('div', {class: 'flipper'}, [
            m('span', {
              onclick: () => Store.showUpload = !Store.showUpload,
            }, `Show ${(Store.showUploads) ? 'Introduction' : 'Files'}`),
          ]),
        ] : null,
      ]),
    ]);
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
      case 'audio': UploadComponent = AudioUpload; break;
      case 'file': UploadComponent = FileUpload; break;
      case 'text': UploadComponent = TextUpload; break;
    }

    return m('div', {class: 'upload'}, [
      m('div', {class: 'types'}, [
        uploadTypes.map((type) => {
          return m('span', {
            class: (this.type === type) ? 'active' : undefined,
            onmousedown: () => this.type = type,
          }, type.slice(0, 1).toUpperCase() + type.slice(1));
        }),
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

  get upload() {
    return Store.upload.types[this.type];
  }

  get canUpload() {
    return false;
  }
}

class AudioUpload extends UploadType {
  oninit(vnode) {
    this.type = 'audio';
  }

  view(vnode) {
    return m('div', {class: 'upload-modal audio'}, [
      'audio upload',
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

  revokeUrl() {
    if (this.file.url) {
      URL.revokeObjectURL(this.file.url);
      this.file.url = null;
    }
  }

  upload() {

  }

  remove() {
    this.revokeUrl();
    console.log(this.id, Store.upload.types.file.files);
    console.log(Store.upload.types.file.files.splice(this.id, 1));
    console.log(this.id, Store.upload.types.file.files);
    m.redraw();
  }

  view(vnode) {
    if (!this.file) {
      return 'error';
    }

    let media;
    if (this.expand && this.file.url) {
      if (this.mimetype === 'audio') {
        media = m(AudioMedia, {
          src: this.file.url,
          onerror: () => this.revokeUrl(),
        });
      } else if (this.mimetype === 'image') {
        media = m(ImageMedia, {
          src: this.file.url,
          onerror: () => this.revokeUrl(),
        });
      } else if (this.mimetype === 'video') {
        media = m(VideoMedia, {
          src: this.file.url,
          onerror: () => this.revokeUrl(),
        });
      }
    }
  
    return m('div', {class: 'file'}, [
      m('div', {class: 'information'}, [
        m('div', {class: 'icon'}, [
          'icon',
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
          class: 'expander deactive',
          onmousedown: () => this.expand = false,
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
          onmousedown: () => this.expand = true,
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


class FileUpload extends UploadType {
  oninit(vnode) {
    this.type = 'file';

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
    if (value.mimetype === 'image' || value.mimetype === 'video') {
      value.url = URL.createObjectURL(value);
    }
    this.files.push(value);
  }

  view(vnode) {
    return m('div', {class: 'upload-modal file'}, [
      (this.files.length) ? [
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
              m('span', {
                class: 'material-icons',
                onmousedown: () => this.input && this.input.click(),
              }, 'add_circle_outline'),
              m('span', 'Select Files'),
            ]),
            m(FileInput, {
              multiple: 'true',
              type: 'file',
              onchange: ({target}) => this.addFiles(target.files),
              ondom: (dom) => this.input = dom,
            }),
          ]),
        ]),
        m('div', {class: 'settings'}, [

        ]),
      ] : [
        m('div', {
          class: 'drag-n-drop picker',
          onmousedown: () => this.input && this.input.click(),
        }, [
          m('div', {class: 'content'}, [
            m('span', 'Select Files'),
          ]),
          m(FileInput, {
            multiple: 'true',
            type: 'file',
            onchange: ({target}) => this.addFiles(target.files),
            ondom: (dom) => this.input = dom,
          }),
        ]),
      ],
    ]);
  }
}


class TextUpload extends UploadType {
  oninit(vnode) {
    this.type = 'text';
  }

  get canUpload() {
    if (this.upload.hashCurrent === this.upload.hashLast) {
      return false;
    }
    return !!this.upload.data;
  }

  view(vnode) {
    return m('div', {class: 'upload-modal text'}, [
      'text upload',
    ]);
  }
}

/*
const Store = {
  audio: {},
  file: {
    file: null,
    lastFile: null,
  },
  text: {
    data: null,
    hashCurrent: null,
    hashLast: null,
    options: {
      filename: 'random',
      extension: 'txt',
      language: null,
      languageId: null,
      type: 'text/plain',
    },
  },
  settings: {
    vanity: null,
  },
  uploads: [],
};


export class HomePage {
  view(vnode) {
    return [
      m(UploadField, vnode.attrs),
      m('div', {class: 'uploads'}, Store.uploads.map((upload) => {
        if (upload.response) {
          return m('span', upload.response.urls.main);
        } else {
          if (upload.error) {
            return m('span', `uploading failed: reason '${upload.error}'`);
          } else {
            return m('span', `uploading ${upload.type}... ${upload.progress}%`);
          }
        }
      })),
    ];
  }
}


const uploadTypes = ['audio', 'file', 'text'];


class UploadField {
  oninit(vnode) {
    this.type = 'file';

    vnode.attrs.type = (vnode.attrs.type || '').toLowerCase();
    if (uploadTypes.includes(vnode.attrs.type)) {
      this.type = vnode.attrs.type;
    }

    Store.text.options.languageId = vnode.attrs.language;
  }

  get canUpload() {
    switch (this.type) {
      case 'audio': return false;
      case 'file': {
        if (Store.file.file === Store.file.lastFile) {
          return false;
        }
        return !!Store.file.file;
      }; break;
      case 'text': {
        if (Store.text.hashCurrent === Store.text.hashLast) {
          return false;
        }
        return !!Store.text.data;
      };
      default: return false;
    }
  }

  async tryUpload() {
    if (!this.canUpload) {return;}

    const upload = {
      error: null,
      hash: null,
      progress: 0,
      response: null,
      type: this.type,
    };
    Store.uploads.unshift(upload);

    switch (this.type) {
      case 'audio': return;
      case 'file': {
        try {
          Store.file.lastFile = Store.file.file;

          const form = new FormData();
          form.append('file', Store.file.file);
          upload.response = await Api.uploadFile(form, {
            config: (xhr) => {
              if (xhr.upload) {
                xhr.upload.onprogress = (event) => {
                  upload.progress = Math.ceil((event.loaded / event.total) * 100);
                  m.redraw();
                };
              }
            },
            serialize: (v) => v,
          });
          m.redraw();
        } catch(error) {
          upload.error = error;
        }
      }; break;
      case 'text': {
        upload.hash = Store.text.hashCurrent;
        Store.text.hashLast = upload.hash;

        try {
          upload.response = await Api.uploadFile(Store.text.data, {
            headers: {'content-type': Store.text.options.type},
            query: {type: 'raw'},
            config: (xhr) => {
              if (xhr.upload) {
                xhr.upload.onprogress = (event) => {
                  upload.progress = Math.ceil((event.loaded / event.total) * 100);
                  m.redraw();
                };
              }
            },
            serialize: (v) => v,
          });
          m.redraw();
        } catch(error) {
          upload.error = error;
        }
      }; break;
    }
    console.log('right after upload', upload);
  }

  view(vnode) {
    let UploadComponent = FileUpload;
    switch (this.type) {
      case 'audio': UploadComponent = AudioUpload; break;
      case 'file': UploadComponent = FileUpload; break;
      case 'text': UploadComponent = TextUpload; break;
    }

    return m('div', {class: 'upload'}, [
      m('div', {class: 'upload-types'}, [
        uploadTypes.map((type) => {
          return m('span', {
            class: (this.type === type) ? 'active' : undefined,
            onmousedown: () => this.type = type,
          }, type.slice(0, 1).toUpperCase() + type.slice(1));
        }),
      ]),
      m('div', {class: 'upload-type'}, [
        m(UploadComponent),
      ]),
      m('div', {class: 'options'}, [
        (this.canUpload) ? [
          m('span', {
            class: 'submit',
            onmousedown: () => this.tryUpload(),
          }, 'Upload'),
        ] : [
          m('span', {class: 'submit disabled'}, 'Upload'),
        ],
      ]),
    ]);
  }
}


class AudioUpload {
  view(vnode) {
    return m('div', {class: 'audio'}, [
      'audio upload',
    ]);
  }
}


class File {
  oninit(vnode) {
    this.file = vnode.attrs.file;
  }

  onupdate(vnode) {
    this.file = vnode.attrs.file;
  }

  get mimetype() {
    return this.file.mimetype;
  }

  get iconUrl() {
    // || icon url
    return null;
  }

  revokeUrl() {
    if (this.file.url) {
      URL.revokeObjectURL(this.file.url);
      this.file.url = null;
    }
  }

  view(vnode) {
    if (!this.file) {return 'error';}

    if (this.file.url) {
      if (this.mimetype === 'audio') {
        return m(AudioMedia, {
          src: this.file.url,
          onerror: () => this.revokeUrl(),
        });
      } else if (this.mimetype === 'image') {
        return m(ImageMedia, {
          src: this.file.url,
          onerror: () => this.revokeUrl(),
        });
      } else if (this.mimetype === 'video') {
        return m(VideoMedia, {
          src: this.file.url,
          onerror: () => this.revokeUrl(),
        });
      }
    } else {
      //icon
      return this.file.name;
    }
  }
}


class FileUpload {
  get file() {
    return Store.file.file;
  }

  set file(value) {
    if (this.file && this.file.url) {
      URL.revokeObjectURL(this.file.url);
    }

    value.mimetype = value.type.split('/').shift();
    if (value.mimetype === 'image' || value.mimetype === 'video') {
      value.url = URL.createObjectURL(value);
    }

    return Store.file.file = value;
  }

  view(vnode) {
    return m('div', {class: 'file'}, [
      m('div', {class: 'picker'}, [
        m('input', {
          id: 'file',
          type: 'file',
          onchange: ({target}) => {
            if (target.files.length) {
              this.file = target.files[0];
              m.redraw();
            }
          },
        }),
        m('label', {for: 'file'}, 'Pick File'),
      ]),
      (this.file) ? [
        m('div', {class: 'thumbnail'}, [
          m(File, {file: this.file}),
          m('span', `file size: ${formatBytes(this.file.size, 2)}`),
        ]),
      ] : null,
    ]);
  }
}

function hexString(buffer) {
  const byteArray = new Uint8Array(buffer);

  const hexCodes = [...byteArray].map(value => {
    const hexCode = value.toString(16);
    const paddedHexCode = hexCode.padStart(2, '0');
    return paddedHexCode;
  });

  return hexCodes.join('');
}


function digestMessage(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return window.crypto.subtle.digest('SHA-1', data);
}


import { Monaco } from '../monaco';


class TextUpload {
  get data() {
    return Store.text.data;
  }

  set data(value) {
    Store.text.data = value;

    digestMessage(value).then(hexString).then((digest) => {
      Store.text.hashLast = Store.text.hashCurrent;
      Store.text.hashCurrent = digest;
      m.redraw();
    });

    return value;
  }

  get options() {
    return Store.text.options;
  }

  view(vnode) {
    return [
      m('div', {class: 'languages'}, [
        m('select', {
          onchange: ({target}) => {
            if (target.selectedOptions.length) {
              this.options.languageId = target.selectedOptions[0].value;
            }
          },
        }, [
          Monaco.languages.map((language) => {
            const selected = ((this.options.languageId) ? this.options.languageId : 'plaintext') === language.id;
            if (selected) {
              if (this.options.language !== language) {
                this.options.language = language;
                if (language.mimetypes) {
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
    ];
  }
}
*/