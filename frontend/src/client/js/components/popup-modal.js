import m from 'mithril';


export class PopupModal {
  oninit(vnode) {
    this.class = vnode.attrs.class;
    this.title = vnode.attrs.title;
    this.buttonText = vnode.attrs.buttonText || 'Okay';
    this.show = !!vnode.attrs.show;

    this.onhide = vnode.attrs.onhide;
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  _onhide() {
    this.show = false;
    if (typeof(this.onhide) === 'function') {
      this.onhide();
    } 
  }

  view(vnode) {
    return m('div', {class: 'popup-modal'}, [
      m('div', {
        class: 'background',
        onclick: () => this._onhide(),
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
            onclick: () => this._onhide(),
          }, this.buttonText),
        ]),
      ]),
    ]);
  }
}