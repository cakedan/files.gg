import m from 'mithril';
import md5 from 'crypto-js/md5';

import {
  Browser,
  Mimetypes,
  InputTypes,
} from '../../utils';

import { Store as Options } from '../../utils/options';

import {
  TextMedia,
  TextTypes,
} from '../media';

import {
  CodeMirror,
  Monaco,
} from '../media/text/editors';

import {
  Store as FileStore,
  UploadTypes,
  Tools as FileTools,
  FileComponent,
  FileObject,
} from '../files';


const Tools = Object.freeze({
  defaultFilename: '{random}-{random}',
  get defaultLanguageId() {
    switch (Options.textType) {
      case TextTypes.CODEMIRROR: return CodeMirror.defaultLanguageId;
      case TextTypes.MONACO: return Monaco.defaultLanguageId;
    }
  },
  defaultUploadType: UploadTypes.FILE,
  setRoute() {
    const params = new URLSearchParams();
    if (Store.upload.settings.type === UploadTypes.TEXT) {
      const languageId = Store.upload.types[UploadTypes.TEXT].options.languageId;
      if (languageId !== this.defaultLanguageId) {
        params.append('language', languageId);
      }
    }
    if (Store.upload.settings.type !== this.defaultUploadType) {
      params.append('type', Store.upload.settings.type);
    }
    const route = [Browser.currentPath, params.toString()].filter((v) => v).join('?');
    if (route !== m.route.get()) {
      m.route.set(route, null, {replace: true});
    }
  }
});

const Store = {
  upload: {
    types: {
      [UploadTypes.AUDIO]: {},
      [UploadTypes.FILE]: {
        files: [],
      },
      [UploadTypes.TEXT]: {
        data: '',
        hashes: {
          current: null,
          last: null,
        },
        lastLanguageId: null,
        options: {
          filename: null,
          extension: 'txt',
          language: null,
          languageId: null,
          type: 'text/plain',
        },
      },
    },
    settings: {
      type: Tools.defaultUploadType,
      vanity: null,
    },
  },
  isLoading: true,
  showUploads: false,
};


export class Route {
  constructor(vnode) {
    if (vnode.attrs.type !== undefined) {
      Store.upload.settings.type = InputTypes.choices(
        Object.values(UploadTypes),
        String(vnode.attrs.type).toLowerCase(),
        Tools.defaultUploadType,
      );
    }

    if (vnode.attrs.language === undefined) {
      Store.upload.types.text.options.languageId = Tools.defaultLanguageId;
    } else {
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
          (Browser.isMobile) ? 'horizontal' : 'vertical',
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
              if (FileStore.isAtEnd || FileStore.isFetching) {return;}
              const percentage = (target.scrollTop / target.scrollHeight) * 100;
              if (75 < percentage) {
                await FileTools.fetchFiles();
              }
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
                m('span', {class: 'divider-text'}, [
                  `${FileStore.total.toLocaleString()} File${(FileStore.total !== 1) ? 's' : ''}`,
                ]),
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
Route.className = 'home';


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
    Tools.setRoute();
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
            FileTools.addFiles(target.files);
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

  async oninit(vnode) {
    super.oninit.call(this, vnode);

    if (Mimetypes.isLoading) {
      await Mimetypes.wait();
      const language = this.options.language;
      this.options.language = null;
      this.setLanguage(language);
    }
  }

  get canUpload() {
    if (this.upload.hashes.current === this.upload.hashes.last) {
      if (this.upload.lastLanguageId === this.options.languageId) {
        return false;
      }
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

  setLanguage(language) {
    if (language && this.options.language !== language) {
      this.options.language = language;
      switch (Options.textType) {
        case TextTypes.CODEMIRROR: {
          const languageId = language.id;
          if (this.options.languageId !== languageId) {
            this.options.languageId = languageId;
            Tools.setRoute();
          }

          if (language.mime) {
            this.options.type = language.mime;
          } else if (language.mimes && language.mimes.length) {
            this.options.type = language.mimes[0];
          } else {
            this.options.type = 'text/plain';
          }
          const mimetype = Mimetypes.get(this.options.type);
          if (mimetype) {
            const ext = mimetype.extensions.sort((x, y) => y.priority - x.priority)[0];
            if (ext) {
              this.options.extension = ext.extension;
            } else {
              this.options.extension = 'txt';
            }
          } else {
            if (language.ext && language.ext) {
              this.options.extension = language.ext.sort((x, y) => x.length - y.length)[0];
            } else {
              this.options.extension = languageId;
            }
          }
        }; break;
        case TextTypes.MONACO: {
          const languageId = language.id;
          if (this.options.languageId !== languageId) {
            this.options.languageId = languageId;
            Tools.setRoute();
          }
          if (language.mimetypes && language.mimetypes.length) {
            this.options.type = language.mimetypes[0];
          } else {
            this.options.type = 'text/plain';
          }

          if (this.options.type === 'text/plain') {
            let extension;
            if (language.extensions && language.extensions.length) {
              extension = language.extensions[0].split('.').pop();
            } else {
              extension = languageId;
            }
            const mimetype = Mimetypes.getFromExtension(extension);
            if (mimetype) {
              this.options.type = mimetype.mimetype;;
            }
          }

          if (language.extensions && language.extensions.length) {
            this.options.extension = language.extensions[0].split('.').pop();
          } else {
            this.options.extension = languageId;
          }
        }; break;
      }
    }
  }

  async tryUpload() {
    if (!this.canUpload) {return;}
    this.upload.hashes.last = this.upload.hashes.current;
    this.upload.lastLanguageId = this.options.languageId;

    const filename = this.upload.options.filename || Tools.defaultFilename;
    const blob = new Blob([this.upload.data], {type: this.upload.options.type});
    const file = new FileObject({
      file: {
        blob: blob,
        data: this.upload.data,
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
    const settings = {};
    switch (Options.textType) {
      case TextTypes.CODEMIRROR: {
        Object.assign(settings, {
          mode: (this.options.language) ? this.options.language.mode : null,
          value: this.data,
        });
      }; break;
      case TextTypes.MONACO: {
        Object.assign(settings, {
          language: (this.options.language) ? this.options.language.id : Monaco.defaultLanguageId,
          value: this.data,
        });
      }; break;
      case TextTypes.NATIVE: {
        Object.assign(settings, {
          value: this.data,
        });
      }; break;
    }
    return m('div', {class: 'upload-modal text'}, [
        m('div', {class: 'header'}, [
          m('div', {class: 'languages'}, [
            m('select', {
              onchange: ({target}) => {
                if (target.selectedOptions.length) {
                  switch (Options.textType) {
                    case TextTypes.CODEMIRROR: {
                      const language = CodeMirror.getLanguage({
                        languageId: target.selectedOptions[0].value,
                      });
                      this.setLanguage(language);
                    }; break;
                    case TextTypes.MONACO: {
                      const language = Monaco.getLanguage({
                        languageId: target.selectedOptions[0].value,
                      });
                      this.setLanguage(language);
                    }; break;
                  }
                }
              },
            }, [
              (Options.textType === TextTypes.CODEMIRROR) ? [
                CodeMirror.languages.map((language) => {
                  return m('option', {
                    selected: (this.options.languageId === language.id),
                    value: language.id,
                  }, language.name);
                }),
              ] : [
                (Options.textType === TextTypes.MONACO) ? [
                  Monaco.languages.map((language) => {
                    return m('option', {
                      selected: (this.options.languageId === language.id),
                      value: language.id,
                    }, language.id);
                  }),
                ] : null,
              ],
            ]),
          ]),
          m('div', {
            class: [
              'submit',
              (!this.canUpload) ? 'disabled' : null,
            ].filter((v) => v).join(' '),
            title: (this.canUpload) ? 'Upload' : ((!this.upload.data) ? 'Text Required' : 'Already Uploaded'),
            onclick: () => this.canUpload && this.tryUpload(),
          }, [
            m('i', {class: 'material-icons'}, 'cloud_upload'),
          ]),
        ]),
        m(TextMedia, {
          type: Options.textType,
          settings: settings,
          onload: (event) => {
            const language = event.module.getLanguage({
              mimetype: this.options.languageId,
              languageId: this.options.languageId,
              extension: this.options.languageId,
              alias: this.options.languageId,
            });
            this.setLanguage(language);
          },
          onvalue: ({value}) => this.data = value,
        }),
        m('div', {class: 'footer'}, [
          m(FilenameInput),
        ]),
    ]);
  }
}


class FilenameInput {
  get options() {
    return Store.upload.types[UploadTypes.TEXT].options;
  }

  get filename() {
    return this.options.filename || Tools.defaultFilename;
  }

  set filename(value) {
    return this.options.filename = value;
  }

  get extension() {
    return this.options.extension;
  }

  set extension(value) {
    return this.options.extension = value;
  }

  view(vnode) {
    return m('div', {class: 'filename'}, [
      m('span', `${this.filename}.${this.extension}`),
    ]);
  }
}