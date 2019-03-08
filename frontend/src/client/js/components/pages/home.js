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
  oninit(vnode) {
    /*
    Head.setMetas({
      title: 'File Uploader',
    });
    */
  }

  view(vnode) {
    return [
      m(UploadField, vnode.attrs),
      m('div', {class: 'uploads'}, Store.uploads.map((upload) => {
        if (upload.response) {
          return m('span', upload.response.urls.main);
        } else {
          return m('span', `uploading ${upload.type}... ${upload.progress}%`);
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
              /*
              onmousedown: () => {
                console.log(language);
                this.options.language = language;
                if (language.mimetypes) {
                  this.options.type = language.mimetypes[0];
                  //iterate through all of the mimetypes and match vs ours
                } else {
                  this.options.extension = 'txt';
                  this.options.type = 'text/plain';
                }
                m.redraw();
              },
              */
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
