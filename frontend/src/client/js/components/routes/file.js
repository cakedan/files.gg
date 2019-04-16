import m from 'mithril';

import { Api } from '../../api';
import { FileModal } from '../file';


export class Route {
  constructor(vnode) {
    this.loading = true;
    this.file = null;
    this.error = null;
  }

  async oninit(vnode) {
    this.loading = true;
    try {
      this.file = vnode.attrs.file = await Api.fetchFile(vnode.attrs.fileId, {views: true});
      this.file.name = [this.file.filename, this.file.extension].filter((v) => v).join('.');
    } catch(error) {
      this.error = error;
    }
    this.loading = false;
    m.redraw();
  }

  view(vnode) {
    if (this.loading) {
      return m('div', {class: 'context'}, 'loading...');
    }
    if (this.error) {
      return m('div', {class: 'context'}, this.error.message);
    }

    return m(FileModal, {
      file: this.file,
      ...vnode.attrs,
    });
  }
}
Route.className = 'file-route';
