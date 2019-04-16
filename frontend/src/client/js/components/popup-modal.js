import m from 'mithril';

import { InputTypes } from '../utils';


export class PopupModal {
  oninit(vnode) {
    this.class = vnode.attrs.class;
    this.title = vnode.attrs.title;
    this.buttonText = vnode.attrs.buttonText || 'Okay';
    this.show = !!vnode.attrs.show;

    this._onhide = InputTypes.func(vnode.attrs.onhide);
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  onhide() {
    this.show = false;
    if (this._onhide) {
      this._onhide();
    }
  }

  view(vnode) {
    return m('div', {class: 'modal-popup'}, [
      m('div', {
        class: 'background',
        onclick: () => this.onhide(),
      }),
      m('div', {
        class: [
          'modal',
          this.class,
        ].filter((v) => v).join(' '),
      }, [
        m('div', {class: 'title'}, this.title),
        m('div', {class: 'body'}, vnode.children),
        m('div', {class: 'footer'}, [
          m('span', {
            class: 'button',
            onclick: () => this.onhide(),
          }, this.buttonText),
        ]),
      ]),
    ]);
  }
}
