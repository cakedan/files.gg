import m from 'mithril';

import { Api } from '../../api';
import { Auth } from '../../auth';

import { FileModal } from '../file';

import {
  Browser,
  formatBytes,
  Mimetypes,
  snowflakeToTimestamp,
} from '../../utils';

import {
  Store as FileStore,
  UploadTypes,
  Tools as FileTools,
  FileObject,
} from '../files';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
} from '../media';


const SortTypes = Object.freeze({
  ALPHABETICAL: 'alphabetical',
  SIZE: 'size',
  UPLOADED: 'uploaded',
  VIEWS: 'views',
});

const ViewTypes = Object.freeze({
  CONTENT: 'content',
  TILES: 'tiles',
  DETAILS: 'details',
  LIST: 'list',
  ICONS: 'icons',
  LARGE_ICONS: 'large-icons',
  COZY: 'cozy',
});

const Store = {
  file: {
    id: null,
    vanity: null,
    response: null,
  },
  sortType: SortTypes.UPLOADED,
  viewType: ViewTypes.CONTENT,
};

const Tools = Object.freeze({
  setFileId(vanity, redraw) {
    const fileId = (vanity || '').split('.').shift();
    if (Store.file.id !== fileId) {
      Store.file.id = fileId;
      Store.file.vanity = vanity;
      Store.file.response = null;
      this.setRoute(!vanity, redraw);

      if (fileId) {
        this.fetchFile(fileId);
      }
    }
  },
  async fetchFile(fileId) {
    const file = FileStore.files.uploaded.find(({response}) => response.vanity === fileId);

    let response;
    if (file) {
      response = file.response;
    } else {
      try {
        response = await Api.fetchFile(fileId);
        if (!response.user || response.user.id !== Auth.me.id) {
          response = new Error('You do not own this file.');
        }
      } catch(error) {
        console.error(error);
        response = error;
      }
    }
    if (Store.file.id === fileId) {
      Store.file.response = response;
      m.redraw();
      console.log('set dashboard file', Store.file.response);
    }
  },
  async onScroll(dom) {
    if (FileStore.isAtEnd || FileStore.isFetching) {return;}
    let percentage = 0;
    switch (Store.viewType) {
      case ViewTypes.LIST: {
        percentage = (dom.scrollLeft / (dom.scrollWidth -dom.offsetWidth)) * 100;
      }; break;
      default: {
        percentage = (dom.scrollTop / (dom.scrollHeight - dom.offsetHeight)) * 100;
      };
    }
    if (75 < percentage) {
      await FileTools.fetchFiles();
    }
  },
  setRoute(removeParameters, redraw) {
    let route = '/dashboard/files';
    if (Store.file.id) {
      // Incase they do something like /dashboard/files/.aaa
      route += `/${Store.file.vanity}`;
    }
    if (route !== Browser.currentPath) {
      if (!removeParameters && m.route.get().includes('?')) {
        route += '?' + m.route.get().split('?').pop();
      }
      m.route.set(route);
    } else {
      if (redraw === undefined || redraw) {
        m.redraw();
      }
    }
  },
});


export class Route {
  constructor(vnode) {
    if (vnode.attrs.viewType !== undefined) {
      vnode.attrs.viewType = vnode.attrs.viewType.toLowerCase();
      if (Object.values(ViewTypes).includes(vnode.attrs.viewType)) {
        Store.viewType = vnode.attrs.viewType;
      }
    }
  }

  oninit(vnode) {
    if (Store.file.vanity !== vnode.attrs.fileId) {
      Tools.setFileId(vnode.attrs.fileId, false);
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  view(vnode) {
    return [
      (Store.file.id) ? m(DashboardFile, vnode.attrs) : null,
      (FileStore.isLoading) ? [
        m('div', {class: 'message'}, [
          m('span', 'loading...'),
        ]),
      ] : [
        m('div', {class: 'main-modal'}, [
          m('div', {class: 'divider'}, [
            m('span', {class: 'divider-text'}, [
              `${FileStore.total.toLocaleString()} File${(FileStore.total !== 1) ? 's' : ''}`,
            ]),
          ]),
          m.fragment({
            oncreate: ({dom}) => Tools.onScroll(dom),
          }, [
            m('div', {
              class: [
                'files',
                `view-${Store.viewType}`,
                (Store.file.id && Browser.isSafari) ? 'ios-fix' : null,
              ].filter((v) => v).join(' '),
              onscroll: ({target}) => Tools.onScroll(target),
            }, [
              FileStore.files.uploaded.map((file) => m(FileComponent, {
                file: file,
                key: file.key,
                type: Store.viewType,
              })),
              (FileStore.isFetching) ? [
                m('div', {class: 'modal'}, [
                  m('i', {class: 'material-icons'}, ''),
                  m('span', 'Fetching more...'),
                ]),
              ] : null,
            ]),
          ]),
        ]),
      ],
    ];
  }
}
Route.className = 'dashboard-files';


class FileComponent {
  oninit(vnode) {
    this.file = vnode.attrs.file;
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  onbeforeupdate(vnode, old) {
    if (vnode.attrs.file !== old.attrs.file) {
      return true;
    }
    if (vnode.attrs.type !== old.attrs.type) {
      return true;
    }
    return false;
  }

  get showIcon() {
    if (this.file.showIcon) {
      return true;
    }

    switch (Store.viewType) {
      case ViewTypes.CONTENT: return false;
      case ViewTypes.TILES: return false;
      case ViewTypes.ICONS: return false;
      case ViewTypes.LARGE_ICONS: return false;
      default: return true;
    }
  }

  showFile(event) {
    event.preventDefault();
    event.redraw = false;
    // zoom event
    if (!Browser.isMobile) {
      // if is not mobile, might be zoom request
      // PICTURE/IMG click
      switch (event.target.tagName) {
        case 'PICTURE':
        case 'IMG': return;
      }
    }
    const {vanity, extension} = this.file.response;
    Tools.setFileId([vanity, extension].filter((v) => v).join('.'));
  }

  view(vnode) {
    let media;
    if (!this.showIcon) {
      if (Mimetypes.isImageType(this.file.mimetype)) {
        media = m(ImageMedia, {
          disableZoom: Browser.isMobile,
        }, [
          m('img', {
            alt: this.file.filename,
            src: this.file.url,
            onerror: () => this.file.showIcon = true,
          }),
        ]);
      }
    }

    switch (Store.viewType) {
      case ViewTypes.CONTENT: {
        const date = new Date(snowflakeToTimestamp(this.file.response.id));

        return m('div', {
          class: 'file',
          onclick: (event) => this.showFile(event),
        }, [
          m('div', {class: 'header'}, [
            (media) ? media : [
              m('div', {class: 'icon'}, [
                m('span', {class: 'material-icons'}, 'insert_drive_file'),
              ]),
            ],
          ]),
          m('div', {class: 'fields'}, [
            m('div', {class: 'field'}, [
              m('div', {class: 'info'}, [
                m('span', {class: 'title'}, this.file.filename),
              ]),
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'Mimetype:'),
                m('span', this.file.mimetype),
              ]),
            ]),
            m('div', {class: 'field'}, [
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'URL:'),
                m('span', this.file.response.urls.main),
              ]),
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'Views:'),
                m('span', this.file.response.views || 0),
              ]),
            ]),
          ]),
          m('div', {class: 'footer'}, [
            m('div', {class: 'field'}, [
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'Uploaded:'),
                m('span', `${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`),
              ]),
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'Size:'),
                m('span', formatBytes(this.file.size, 2)),
              ]),
            ]),
          ]),
        ]);
      };
      case ViewTypes.TILES: {
        return m('div', {class: 'file'}, [
          m('div', {class: 'header'}, [
            (media) ? media : [
              m('div', {class: 'icon'}, [
                m('span', {class: 'material-icons'}, 'insert_drive_file'),
              ]),
            ],
          ]),
          m('div', {class: 'fields'}, [
            m('div', {class: 'field'}, [
              m('span', {class: 'title'}, this.file.filename),
            ]),
            m('div', {class: 'field'}, [
              m('span', this.file.mimetype),
            ]),
            m('div', {class: 'field'}, [
              m('span', formatBytes(this.file.size, 2)),
            ]),
          ]),
        ]);
      };
      case ViewTypes.DETAILS: {
        const date = new Date(snowflakeToTimestamp(this.file.id));

        return m('div', {class: 'file'}, [
          m('div', {class: 'header'}, [
            m('div', {class: 'icon'}, [
              m('span', {class: 'material-icons'}, 'insert_drive_file'),
            ]),
          ]),
          m('div', {class: 'fields'}, [
            m('div', {class: 'field filename'}, [
              m('span', this.file.filename),
            ]),
            m('div', {class: 'field timestamp'}, [
              m('span', `${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`),
            ]),
            m('div', {class: 'field mimetype'}, [
              m('span', this.file.mimetype),
            ]),
            m('div', {class: 'field filesize'}, [
              m('span', formatBytes(this.file.size, 2)),
            ]),
          ]),
        ]);
      };
      case ViewTypes.LIST: {
        return m('div', {class: 'file'}, [
          m('div', {class: 'header'}, [
            m('div', {class: 'icon'}, [
              m('span', {class: 'material-icons'}, 'insert_drive_file'),
            ]),
          ]),
          m('div', {class: 'fields'}, [
            m('div', {class: 'field'}, [
              m('span', this.file.filename),
            ]),
          ]),
        ]);
      };
      case ViewTypes.LARGE_ICONS:
      case ViewTypes.ICONS: {
        return m('div', {class: 'file'}, [
          m('div', {class: 'content'}, [
            m('div', {class: 'header'}, [
              (media) ? media : [
                m('div', {class: 'icon'}, [
                  m('span', {class: 'material-icons'}, 'insert_drive_file'),
                ]),
              ],
            ]),
            m('div', {class: 'fields'}, [
              m('div', {class: 'field'}, [
                m('span', this.file.filename),
              ]),
            ]),
          ]),
        ]);
      };
    }
    return null;

    const date = new Date(snowflakeToTimestamp(this.file.id));
    return m('div', {class: 'file'}, [
      m('div', {class: 'header'}, [
        m('div', {class: 'thumbnail'}, [
          (media) ? media : [
            m('div', {class: 'icon'}, [
              m('span', {class: 'material-icons'}, 'insert_drive_file'),
            ]),
          ],
        ]),
        m('div', {class: 'information'}, [
          m('span', {class: 'filename'}, this.file.filename),
          m('span', {class: 'filesize'}, formatBytes(this.file.size, 2)),
        ]),
      ]),
      m('div', {class: 'fields'}, [
        m('div', {class: 'url'}, [
          m('input', {readonly: true, value: this.file.urls.main}),
        ]),
        m('div', {class: 'views'}, [
          m('span', this.file.views || 0),
          m('span', {class: 'material-icons'}, 'remove_red_eye'),
        ]),
      ]),
      m('div', {class: 'footer'}, [
        m('div', {class: 'timestamp'}, [
          m('span', `Uploaded on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`),
        ]),
      ]),
    ]);
  }
}


class DashboardFile {
  get file() {
    return Store.file.response;
  }

  view(vnode) {
    return m('div', {
      class: 'dashboard-file-modal',
      onclick: (event) => {
        event.redraw = false;
        if (event.target.classList.contains('dashboard-file-modal')) {
          event.preventDefault();
          Tools.setFileId();
        }
      },
    }, [
      (this.file) ? [
        (!(this.file instanceof Error)) ? [
          m(FileModal, {
            file: this.file,
            ...vnode.attrs,
          }),
        ] : [
          m('div', {class: 'message error'}, [
            m('span', [
              'Error: ',
              this.file.message || 'lol',
            ]),
          ]),
        ],
      ] : [
        m('div', {class: 'message'}, [
          m('span', 'Loading File Data...'),
        ]),
      ],
    ]);
  }
}
