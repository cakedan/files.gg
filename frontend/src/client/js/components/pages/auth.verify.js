import m from 'mithril';

import { Api } from '../../api';
import { Auth } from '../../auth';


export class AuthVerifyPage {
  async oninit(vnode) {
    this.loading = true;
    this.error = null;

    try {
      await Api.verify(vnode.attrs.token);
    } catch(error) {
      if ('errors' in error) {
        this.error = new Error(error.errors.token);
      } else {
        this.error = error;
      }
      console.error(error, Object.assign({}, error));
    }
    this.loading = false;
    m.redraw();
  }

  view(vnode) {
    return m('div', {class: 'auth-verify'}, [
      (this.loading) ? [
        m('span', 'verifying...'),
      ] : [
        (this.error) ? [
          m('span', this.error.message),
        ] : [
          m('span', 'Successfully verified your account.'),
        ],
      ],
    ]);
  }
}
