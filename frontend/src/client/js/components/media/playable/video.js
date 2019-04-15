import m from 'mithril';

import {
  PlayableMedia,
  MediaBar,
  MediaController,
  MediaTimestamp,
  MediaVolume,
} from './playablemedia';


export class MediaComponent extends PlayableMedia {
  constructor(vnode) {
    super(vnode);

    this.hovering = true;
    this.interacting = {media: false, volume: false};

    this.fullscreen = false;

    this.useCustomControls = !window.browser.satisfies({
      safari: '>=0',
    });

    this.listeners = {
      fullscreenchange: this.onFullscreenChange.bind(this),
      keydown: this.onKeyDown.bind(this),
    };
    for (let listener in this.listeners) {
      document.addEventListener(listener, this.listeners[listener]);
    }
  }

  get showControls() {
    return this.hovering || this.interacting.media || this.interacting.volume;
  }

  onFullscreenChange(event) {
    if (!document.fullscreenElement) {
      // user just unfullscreened the browser
      if (this.fullscreen) {
        this.fullscreen = false;
        m.redraw();
      }
    }
  }

  onKeyDown(event) {
    if (event.key === 'Escape') {
      this.fullscreen = false;
    }
  }

  setInteracting(type, interacting) {
    if (this.interacting[type] !== interacting) {
      this.interacting[type] = interacting;
      m.redraw();
    }
  }

  onremove(vnode) {
    super.onremove.call(this, vnode);

    for (let listener in this.listeners) {
      document.removeEventListener(listener, this.listeners[listener]);
    }
  }

  view(vnode) {
    if (this.useCustomControls) {
      return m('div', {
        class: [
          'media-container',
          'video',
          (this.fullscreen) ? 'fullscreen' : null,
        ].filter((v) => v).join(' '),
        onmousemove: () => this.hovering = true,
        onmouseleave: () => this.hovering = false,
        onclick: (event) => {
          if (event.target.classList.contains('media-container')) {
            if (this.fullscreen) {
              this.fullscreen = false;
              m.redraw();
              if (document.fullscreenEnabled && document.fullscreenElement) {
                document.exitFullscreen();
              }
            }
          }
        },
      }, [
        m.fragment({
          oncreate: (vnode) => this.media.set(vnode.dom),
          onremove: () => this.media.destroy(),
        }, [
          m('video', Object.assign({}, vnode.attrs, {
            onclick: () => this.media.playOrPause(),
            onloadedmetadata: m.redraw,
            ontimeupdate: m.redraw,
            preload: 'metadata',
            playsinline: true,
          }), vnode.children),
        ]),
        m('div', {
          class: [
            'media-controls',
            (this.showControls) ? 'active' : null,
          ].filter((v) => v).join(' '),
          onmousedown: () => this.hovering = true,
          onmousemove: () => this.hovering = true,
          onmouseleave: () => this.hovering = false,
        }, [
          m(MediaController, {media: this.media}),
          m(MediaTimestamp, {media: this.media}),
          m(MediaBar, {
            media: this.media,
            oninteract: (interacting) => this.setInteracting('media', interacting),
          }),
          m(MediaVolume, {
            media: this.media,
            oninteract: (interacting) => this.setInteracting('volume', interacting),
          }),
          m('div', {
            class: 'controller-fullscreen',
            onclick: () => {
              this.fullscreen = !this.fullscreen;
              m.redraw();
              if (document.fullscreenEnabled) {
                if (this.fullscreen) {
                  if (!document.fullscreenElement) {
                    document.body.requestFullscreen().catch(() => {});
                  }
                } else {
                  if (document.fullscreenElement) {
                    document.exitFullscreen();
                  }
                }
              }
            },
          }, [
            (this.fullscreen) ? [
              m('i', {class: 'material-icons'}, 'fullscreen_exit'),
            ] : [
              m('i', {class: 'material-icons'}, 'fullscreen'),
            ],
          ]),
        ]),
      ]);
    } else {
      return m('div', {class: 'media-container video'}, [
        m('video', Object.assign(vnode.attrs, {
          controls: true,
          playsinline: true,
        }), vnode.children),
      ]);
    }
  }
}
