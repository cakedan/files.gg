import m from 'mithril';

import { Api } from '../../api';
import {
  formatBytes,
  snowflakeToTimestamp,
} from '../../utils';

import {
  AudioMedia,
  ImageMedia,
  TextMedia,
  VideoMedia,
} from '../media';

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
  viewType: ViewTypes.CONTENT,
  isAtEnd: false,
  isFetching: false,
  isLoading: true,
  total: 0,
  files: [],
};


async function fetchMoreFiles() {
  Store.isFetching = true;
  try {
    const lastFile = Store.files[Store.files.length - 1];
    let response;
    if (lastFile) {
      response = await Api.fetchFiles({
        before: lastFile.id,
      });
    } else {
      response = await Api.fetchFiles();
    }

    Store.total = response.total;
    if (response.files.length) {
      for (let file of response.files) {
        file.name = [file.filename, file.extension].filter((v) => v).join('.');
        Store.files.push(file);
      }
      if (Store.files.length === response.total) {
        Store.isAtEnd = true;
      }
    }
  } catch(error) {
    console.error(error);
  }
  Store.isFetching = false;
}


export class DashboardFilesPage {
  constructor(vnode) {
    if (vnode.attrs.viewType !== undefined) {
      vnode.attrs.viewType = vnode.attrs.viewType.toLowerCase();
      if (Object.values(ViewTypes).includes(vnode.attrs.viewType)) {
        Store.viewType = vnode.attrs.viewType;
      }
    }
  }

  async oninit(vnode) {
    if (Store.isFetching || !Store.isLoading) {
      return;
    }
    Store.isLoading = true;
    Store.error = null;
    await fetchMoreFiles();
    Store.isLoading = false;
    m.redraw();
  }

  view(vnode) {
    if (Store.isLoading) {
      return m('div', {class: 'message'}, [
        m('span', 'loading...'),
      ]);
    }
    if (Store.error) {
      return m('div', {class: 'message'}, [
        m('span', `error fetching ur data lol: ${Store.error.message}`),
      ]);
    }

    return m('div', {
      class: [
        'modal',
        (window.isMobile) ? 'mobile' : null,
      ].filter((v) => v).join(' '),
    }, [
      m('div', {class: 'total'}, [
        m('span', `You have uploaded ${Store.total.toLocaleString()} files.`),
      ]),
      m.fragment({
        oncreate: async ({dom}) => {
          let percentage = 0;
          switch (Store.viewType) {
            case ViewTypes.LIST: {
              percentage = (dom.scrollLeft / (dom.scrollWidth -dom.offsetWidth)) * 100;
            }; break;
            default: {
              percentage = (dom.scrollTop / (dom.scrollHeight - dom.offsetHeight)) * 100;
            };
          }
          if (percentage < 85 || Store.isAtEnd || Store.isFetching) {
            return;
          }
          await fetchMoreFiles();
          m.redraw();
        },
      }, [
        m('div', {
          class: [
            'files',
            `view-${Store.viewType}`,
          ].join(' '),
          onscroll: async ({target}) => {
            let percentage = 0;
            switch (Store.viewType) {
              case ViewTypes.LIST: {
                percentage = (target.scrollLeft / (target.scrollWidth - target.offsetWidth)) * 100;
              }; break;
              default: {
                percentage = (target.scrollTop / (target.scrollHeight - target.offsetHeight)) * 100;
              };
            }
            if (percentage < 85 || Store.isAtEnd || Store.isFetching) {
              return;
            }
            await fetchMoreFiles();
            m.redraw();
          },
        }, [
          Store.files.map((file) => m(FileComponent, {key: file.id, file})),
          (Store.isFetching) ? [
            m('div', {class: 'loading'}, [
              m('i', {class: 'material-icons'}, ''),
              m('span', 'Fetching more...'),
            ]),
          ] : null,
        ]),
      ]),
    ]);
  }
}


class FileComponent {
  oninit(vnode) {
    this.file = vnode.attrs.file;
  }

  onupdate(vnode) {
    this.oninit(vnode);
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

  view(vnode) {
    const type = this.file.mimetype.split('/').shift();

    let media;
    if (!this.showIcon) {
      switch (type) {
        case 'image': {
          media = m(ImageMedia, {title: this.file.name}, [
            m('img', {
              alt: this.file.name,
              src: this.file.urls.cdn,
              onerror: () => this.file.showIcon = true,
            }),
          ]);
        }; break;
      }
    }

    switch (Store.viewType) {
      case ViewTypes.CONTENT: {
        const date = new Date(snowflakeToTimestamp(this.file.id));

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
              m('div', {class: 'info'}, [
                m('span', {class: 'title'}, this.file.name),
              ]),
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'Mimetype:'),
                m('span', this.file.mimetype),
              ]),
            ]),
            m('div', {class: 'field'}, [
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'URL:'),
                m('span', this.file.urls.main),
              ]),
              m('div', {class: 'info'}, [
                m('span', {class: 'category'}, 'Views:'),
                m('span', this.file.views || 0),
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
              m('span', {class: 'title'}, this.file.name),
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
              m('span', this.file.name),
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
              m('span', this.file.name),
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
                m('span', this.file.name),
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
          m('span', {class: 'filename'}, this.file.name),
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
