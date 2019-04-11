import m from 'mithril';

import { Api } from '../../api';
import { Auth, Fingerprint } from '../../auth';
import { Tools as FileTools } from '../files';


export class Route {
  async oninit(vnode) {
    this.redirect = vnode.attrs.redirect || '/';
    if (!Auth.isAuthed) {
      return m.route.set(this.redirect);
    }
    try {
      await Api.logout();
    } catch(error) {
      console.error(error);
    }
    Auth.clear();
    m.route.set(this.redirect);

    if (!Fingerprint.has) {
      try {
        await Fingerprint.fetch();
      } catch(error) {
        console.error(error);
      }
    }
    FileTools.refresh();
  }

  view(vnode) {}
}
Route = 'auth-logout';
