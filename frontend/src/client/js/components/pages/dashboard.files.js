import m from 'mithril';

import { Api } from '../../api';
import {
  formatBytes,
  snowflakeToTimestamp,
} from '../../utils';

const Store = {
  isAtEnd: false,
  isFetching: false,
  isLoading: true,
  total: 0,
  files: [],
};


export class DashboardFilesPage {
  async oninit(vnode) {
    if (Store.isFetching || !Store.isLoading) {
      return;
    }
    Store.isLoading = true;
    Store.error = null;
    Store.isFetching = true;
    try {
      const response = await Api.fetchFiles();
      Store.total = response.total;
      for (let file of response.files) {
        file.name = [file.filename, file.extension].filter((v) => v).join('.');
        Store.files.push(file);
      }
      console.log(response);
    } catch(error) {
      console.error(error);
      Store.error = error;
    }
    Store.isFetching = false;
    Store.isLoading = false;
    m.redraw();
  }

  async onScroll(event) {
    console.log(event);
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
      m('div', {
        class: 'files',
        onscroll: async ({target}) => {
          const percentage = (target.scrollTop / (target.scrollHeight - target.offsetHeight)) * 100;
          if (percentage < 85) {
            return;
          }
          if (Store.isAtEnd || Store.isFetching) {
            return;
          }
          Store.isFetching = true;
          try {
            const lastFile = Store.files[Store.files.length - 1];
            const response = await Api.fetchFiles({
              before: lastFile.id,
            });
            Store.total = response.total;
            if (response.files.length) {
              for (let file of response.files) {
                file.name = [file.filename, file.extension].filter((v) => v).join('.');
                Store.files.push(file);
              }
              if (Store.files.length === response.total) {
                Store.isAtEnd = true;
              }
              m.redraw();
            }
          } catch(error) {
            console.error(error);
          }
          Store.isFetching = false;
        },
      }, [
        Store.files.map((file) => m(FileComponent, {file})),
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

  view(vnode) {
    const date = new Date(snowflakeToTimestamp(this.file.id));
    return m('div', {class: 'file'}, [
      m('div', {class: 'header'}, [
        m('div', {class: 'thumbnail'}, [
          m('div', {class: 'icon'}, [
            m('span', {class: 'material-icons'}, 'insert_drive_file'),
          ]),
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
