import m from 'mithril';
import md5 from 'crypto-js/md5';

import { Head } from '../head';

import { InputTypes } from '../../utils';

import { TextMedia } from '../media';
import { Monaco } from '../monaco';

import {
  Store as FileStore,
  UploadTypes,
  Tools,
  FileComponent,
  FileObject,
} from '../files';


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
  isLoading: true,
  showUploads: false,
};


export class HomePage {
  constructor(vnode) {
    if (vnode.attrs.type !== undefined) {
      vnode.attrs.type = vnode.attrs.type.toString().toLowerCase();
      if (Object.values(UploadTypes).includes(vnode.attrs.type)) {
        Store.upload.settings.type = vnode.attrs.type;
      }
    }

    if (vnode.attrs.language !== undefined) {
      Store.upload.types.text.options.languageId = vnode.attrs.language;
    }

    if (vnode.attrs.showUploads !== undefined) {
      Store.showUploads = InputTypes.boolean(vnode.attrs.showUploads, false);
    }
  }

  view(vnode) {
    return m('div', {class: 'main-modal'}, [
      m(UploadModal, vnode.attrs),
      m('div', {
        class: [
          'divider',
          (window.isMobile) ? 'horizontal' : 'vertical',
        ].join(' '),
      }, [
        m('span', {class: 'divider-line'}),
      ]),
      m('div', {class: 'embed information'}, [
        (Store.showUploads) ? [
          m('div', {
            class: 'files-wrapper',
            onscroll: async ({target}) => {
              // if like 80% through, fetch more files if not at end
              // scrollTop and scrollHeight
              const percentage = (target.scrollTop / target.scrollHeight) * 100;
              if (percentage < 85) {return;}
              if (FileStore.isAtEnd || FileStore.isFetching) {return;}
              await Tools.fetchFiles();
            },
          }, [
            (FileStore.files.uploading.length) ? [
              m('div', {class: 'divider'}, [
                m('span', {class: 'divider-text'}, `Uploading ${FileStore.files.uploading.length.toLocaleString()} Files`),
              ]),
              m('div', {class: 'files'}, FileStore.files.uploading.map((file) => {
                return m(FileComponent, {file, key: file.key});
              })),
            ] : null,
            (FileStore.files.uploaded.length) ? [
              m('div', {class: 'divider'}, [
                m('span', {class: 'divider-text'}, `Uploaded ${FileStore.total.toLocaleString()} Files`),
              ]),
              m('div', {class: 'files'}, FileStore.files.uploaded.map((file) => {
                return m(FileComponent, {file, key: file.key});
              })),
            ] : null,
          ]),
        ] : [
          m('div', {class: 'introduction'}, [
            m('div', {class: 'content'}, [
              m('div', {class: 'header'}, [
                m('span', {class: 'title'}, 'Some File Uploader'),
                m('span', {class: 'description'}, 'Just upload some files, more updates coming soon.'),
              ]),
              m('div', {class: 'footer'}),
            ]),
          ]),
        ],
        (FileStore.files.uploaded.length) ? [
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

    return m('div', {class: 'embed upload'}, [
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

  view(vnode) {
    return m('div', {class: 'upload-modal file'}, [
      (FileStore.files.preview.length) ? [
        m('div', {class: 'selected-files'}, [
          m('div', {class: 'files-wrapper'}, [
            m('div', {class: 'files'}, FileStore.files.preview.map((file) => {
              return m(FileComponent, {
                file: file,
                key: file.key,
                onupload: () => Store.showUploads = true,
              });
            })),
          ]),
          m('div', {class: 'selector'}, [
            m('div', {
              class: 'picker',
              title: 'Select File(s)',
              onclick: () => this.input && this.input.click(),
            }, [
              m('div', {class: 'text'}, [
                m('span', {class: 'material-icons'}, 'add_circle_outline'),
                m('span', 'Select File(s)'),
              ]),
            ]),
          ]),
          m('div', {class: 'settings'}, [

          ]),
        ]),
      ] : [
        m('div', {
          class: 'drag-n-drop picker',
          onclick: () => this.input && this.input.click(),
        }, [
          m('div', {class: 'content'}, [
            m('div', {class: 'header'}, [
              m('span', {class: 'title'}, 'Drag n Drop Files'),
              m('span', {class: 'description'}, 'or click here'),
            ]),
            m('div', {class: 'fields'}, [
              m('div', {class: 'field'}, [
                m('span', {class: 'button'}, 'Select File(s)'),
              ]),
            ]),
          ]),
        ]),
      ],
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

    const filename = this.upload.options.filename || '{random}-{random}';
    const blob = new Blob([this.upload.data], {type: this.upload.options.type});
    const file = new FileObject({
      file: {
        blob: blob,
        extension: this.upload.options.extension,
        name: filename,
      },
      uploadType: UploadTypes.TEXT,
    });

    Store.showUploads = true;
    await file.upload();
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
              const selected = (
                (this.options.languageId === language.id) ||
                (language.extensions || []).includes(`.${this.options.languageId}`) ||
                (language.aliases || []).some((alias) => alias.toLowerCase() === this.options.languageId)
              );
              if (selected) {
                if (this.options.language !== language) {
                  this.options.language = language;
                  if (this.options.languageId !== language.id) {
                    this.options.languageId = language.id;
                    this.setRoute();
                  }
                  if (language.mimetypes) {
                    this.options.type = language.mimetypes[0];
                  } else {
                    this.options.type = 'text/plain';
                  }
                  if (language.extensions) {
                    this.options.extension = (language.extensions[0] || 'txt').split('.').pop();
                  } else {
                    this.options.extension = 'txt';
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
