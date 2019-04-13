import m from 'mithril';


export class MediaComponent {
  constructor(vnode) {
    this.zoom = !!vnode.attrs.zoom;
  }

  view(vnode) {
    return [
      (this.zoom) ? [
        m('div', {
          class: 'media-container image zoom',
          onclick: () => this.zoom = false,
        }, [
          m('picture', vnode.children),
        ]),
      ] : null,
      m('div', {class: 'media-container image'}, [
        m('picture', {
          class: 'compact',
          onclick: () => this.zoom = true,
        }, vnode.children),
      ]),
    ];
  }
}
