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
          onclick: () => {
            if (!vnode.attrs.disableZoom) {
              if (typeof(vnode.attrs.onzoom) === 'function') {
                const payload = {};
                vnode.attrs.onzoom(payload);
                if (payload.cancel) {
                  return;
                }
              }
              this.zoom = true;
            }
          },
        }, [
          m.fragment({
            oncreate: ({dom}) => {
              if (typeof(vnode.attrs.ondimensions) === 'function') {
                if (dom.complete) {
                  vnode.attrs.ondimensions({
                    dom: dom,
                    height: dom.height,
                    width: dom.width,
                    naturalHeight: dom.naturalHeight,
                    naturalWidth: dom.naturalWidth,
                  });
                } else {
                  dom.onload = () => {
                    vnode.attrs.ondimensions({
                      dom: dom,
                      height: dom.height,
                      width: dom.width,
                      naturalHeight: dom.naturalHeight,
                      naturalWidth: dom.naturalWidth,
                    });
                  };
                }
              }
            },
          }, vnode.children),
        ]),
      ]),
    ];
  }
}
