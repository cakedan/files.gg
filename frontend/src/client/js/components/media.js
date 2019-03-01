import m from 'mithril';

import { formatTime } from '../utils';


class MediaWrapper {
  constructor(media) {
    this.media = media;
  }

  get isCreated() {
    return !!this.media;
  }

  get isPaused() {
    return !this.media || this.media.paused;
  }

  get isAtEnd() {
    return !this.media || this.media.ended;
  }

  get currentTime() {
    if (this.isCreated) {
      if (!Number.isNaN(this.media.currentTime)) {
        const hour = (3600 <= this.media.duration);
        return formatTime(this.media.currentTime * 1000, {hour});
      }
    }
    return '--';
  }

  get currentTimePercentage() {
    if (this.isCreated) {
      if (!Number.isNaN(this.media.duration)) {
        return (this.media.currentTime / this.media.duration * 100);
      }
    }
    return 0;
  }

  get duration() {
    if (this.isCreated) {
      if (!Number.isNaN(this.media.duration)) {
        const hour = (3600 <= this.media.duration);
        return formatTime(this.media.duration * 1000, {hour});
      }
    }
    return '--';
  }

  set time(time) {
    if (this.isCreated) {
      this.media.currentTime = time;
      m.redraw();
    }
  }

  get volume() {
    return (this.isCreated) ? this.media.volume * 100 : 100;
  }

  set volume(volume) {
    window.savedVolume = volume;
    if (this.isCreated) {
      this.media.volume = volume / 100;
      m.redraw();
    }
  }

  destroy() {
    this.media = null;
  }

  set(media) {
    this.media = media;
    this.media.volume = window.savedVolume / 100;
    m.redraw();
  }

  playOrPause() {
    if (this.isCreated) {
      if (this.media.paused) {
        this.media.play();
      } else {
        this.media.pause();
      }
    }
  }

  setTime(time) {
    this.time = time;
  }

  setVolume(volume) {
    this.volume = volume;
  }
}


class Media {
  constructor(vnode) {
    this.media = new MediaWrapper();

    if (vnode.attrs.volume === undefined) {
      vnode.attrs.volume = window.savedVolume;
    } else {
      window.savedVolume = vnode.attrs.volume;
    }
  }

  onremove(vnode) {
    this.media.destroy();
  }
}


class MediaChild {
  constructor(vnode) {
    this.media = vnode.attrs.media;
  }
}


class MediaHoverDragChild extends MediaChild {
  constructor(vnode) {
    super(vnode);

    this._hovering = false;
    this._dragging = false;

    if (typeof(vnode.attrs.ondrag) === 'function') {
      this.ondrag = vnode.attrs.ondrag;
    }
    if (typeof(vnode.attrs.onhover) === 'function') {
      this.onhover = vnode.attrs.onhover;
    }
  }

  get hovering() {
    return this._hovering;
  }

  set hovering(value) {
    this._hovering = value
    this.onhover(this._hovering);
    return this._hovering;
  }

  get dragging() {
    return this._dragging;
  }

  set dragging(value) {
    this._dragging = value
    this.ondrag(this._dragging);
    return this._dragging;
  }

  ondrag() {}
  onhover() {}
}



class MediaController extends MediaChild {
  view(vnode) {
    return m('div', {class: 'controller'}, [
      m('span', {
        onclick: () => this.media.playOrPause(),
      }, (this.media.isCreated) ? [
        (this.media.isPaused) ? [
          (!this.media.isAtEnd) ? [
            m('i', {class: 'material-icons'}, 'play_arrow'),
          ] : [
            m('i', {class: 'material-icons'}, 'replay'),
          ],
        ] : [
          m('i', {class: 'material-icons'}, 'pause'),
        ],
      ] : [
        m('i', {class: 'material-icons'}, 'block'),
      ]),
    ]);
  }
}


class MediaTimestamp extends MediaChild {
  view(vnode) {
    return m('div', {class: 'timestamp'}, [
      m('span', {class: 'current'}, this.media.currentTime),
      '/',
      m('span', {class: 'duration'}, this.media.duration),
    ]);
  }
}


class MediaBar extends MediaHoverDragChild {
  constructor(vnode) {
    super(vnode);

    this.div = null;

    this.seekPercent = 0;
    this.seekTime = 0;

    this.listeners = {
      mousemove: this.onHover.bind(this),
      mouseup: this.onMouseUp.bind(this),
    };
    for (let listener in this.listeners) {
      window.addEventListener(listener, this.listeners[listener]);
    }
  }

  get progress() {
    return this.media.currentTimePercentage;
  }

  get seekTimeFormatted() {
    let hour = false;
    if (this.media.isCreated) {
      hour = (3600 <= this.media.media.duration);
    }
    return formatTime(this.seekTime * 1000, {hour, ms: true});
  }

  get shouldShow() {
    return this.hovering || this.dragging;
  }

  onClick(event) {
    this.dragging = true;
    this.onHover(event);
  }

  onHover(event) {
    event.preventDefault();
    if (!this.div || !this.media.isCreated) {return;}
    if (!this.hovering && !this.dragging) {return;}

    let clientX;
    if (event.type.startsWith('touch')) {
      clientX = event.touches[0].clientX;
    } else {
      clientX = event.clientX;
    }

    const rect = this.div.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), this.div.clientWidth);

    const seek = (x / this.div.clientWidth);
    this.seekPercent = seek * 100;
    this.seekTime = (this.media.media.duration || 0) * seek;

    if (this.dragging) {
      this.media.setTime(this.seekTime);
    }
  }

  onMouseUp(event) {
    if (!this.hovering) {
      this.resetSeek();
    }
    this.dragging = false;
  }

  resetSeek() {
    this.hovering = false;
    this.seekPercent = 0;
    this.seekTime = 0;
  }


  oncreate(vnode) {
    this.div = vnode.dom;
  }

  onremove(vnode) {
    this.div = null;
    for (let listener in this.listeners) {
      window.removeEventListener(listener, this.listeners[listener]);
    }
  }

  view(vnode) {
    return m('div', {
      class: 'media-bar',
      onmousedown: (event) => this.onClick(event),
      onmouseleave: () => this.resetSeek(),
      onmousemove: () => this.hovering = true,
      onmouseup: () => this.dragging = false,
      ontouchstart: (event) => this.onClick(event),
      ontouchmove: (event) => this.onHover(event),
      ontouchcancel: () => this.dragging = false,
      ontouchend: () => this.dragging = false,
    }, [
      m('div', {class: 'media-interactive-bar'}, [
        m('div', {
          class: 'seek',
          style: `width: ${this.seekPercent}%`,
        }),
        m('div', {
          class: [
            'seek-timestamp',
            (this.shouldShow) ? null : 'hidden',
          ].filter((v) => v).join(' '),
          style: `left: ${this.seekPercent}%`,
        }, this.seekTimeFormatted),
        m('div', {
          class: 'progress',
          style: `width: ${this.progress}%`,
        }, [
          m('span', {
            class: [
              'bubble',
              (this.shouldShow) ? 'active' : null,
            ].filter((v) => v).join(' '),
          }),
        ]),
      ]),
    ]);
  }
}


class MediaVolume extends MediaHoverDragChild {
  constructor(vnode) {
    super(vnode);

    this.div = null;
    this.lastVolume = this.volume || 100;

    this.listeners = {
      mousemove: this.onHover.bind(this),
      mouseup: this.onMouseUp.bind(this),
    };
    for (let listener in this.listeners) {
      window.addEventListener(listener, this.listeners[listener]);
    }
  }

  get isMute() {
    return (this.media.volume === 0);
  }

  get shouldShow() {
    return this.hovering || this.dragging;
  }

  onClick(event) {
    this.dragging = true;
    this.onHover(event);
  }

  onHover(event) {
    event.preventDefault();
    if (!this.div) {return;}
    if (!this.hovering && !this.dragging) {return;}

    if (this.dragging) {
      let clientY;
      if (event.type.startsWith('touch')) {
        clientY = event.touches[0].clientY;
      } else {
        clientY = event.clientY;
      }

      const rect = this.div.getBoundingClientRect();
      const y = Math.min(Math.max(0, clientY - rect.top), this.div.clientHeight);
      const seek = (y / this.div.clientHeight);
      this.media.setVolume(100 - (seek * 100));
    }
  }

  onMouseUp(event, force) {
    if (event.target.className === 'material-icons') {
      if (!force) {return;}
    }
    this.hovering = false;
    this.dragging = false;
  }

  muteOrUnmute(event) {
    if (event.target.className !== 'material-icons') {return;}

    if (this.isMute) {
      if (this.lastVolume === 0) {
        this.lastVolume = 100;
      }
      this.media.setVolume(this.lastVolume);
    } else {
      this.lastVolume = this.media.volume;
      this.media.setVolume(0);
    }
  }

  onremove(vnode) {
    this.div = null;
    for (let listener in this.listeners) {
      window.removeEventListener(listener, this.listeners[listener]);
    }
  }

  view(vnode) {
    return [
      m('div', {
        class: 'volume',
        onmousedown: (event) => this.muteOrUnmute(event),
        onmousemove: () => this.hovering = true,
        ontouchstart: () => this.hovering = !this.hovering,
        ontouchmove: (event) => this.onClick(event),
        ontouchcancel: (event) => this.onMouseUp(event, true),
        ontouchend: (event) => this.onMouseUp(event, true),
      }, [
        (this.shouldShow) ? [
          m('div', {
            class: 'volume-area',
            onmousemove: () => this.hovering = true,
            onmouseleave: () => this.hovering = false,
          }),
          m.fragment({
            oncreate: (vnode) => this.div = vnode.dom,
            onremove: (vnode) => this.div = null,
          }, [
            m('div', {
              class: 'interactive-slider',
              onmousedown: (event) => this.onClick(event),
              onmousemove: () => this.hovering = true,
              ontouchstart: (event) => this.onClick(event),
              ontouchmove: (event) => this.onHover(event),
              ontouchcancel: () => this.dragging = false,
              ontouchend: () => this.dragging = false,
            }, [
              m('span', {class: 'background'}),
              m('div', {
                class: 'volume-slider',
                style: `height: ${this.media.volume}%`,
              }, [
                m('span', {
                  class: [
                    'bubble',
                    (this.dragging) ? 'active' : null,
                  ].filter((v) => v).join(' '),
                }),
              ]),
            ]),
          ]),
        ] : null,
        (this.isMute) ? [
          m('i', {class: 'material-icons'}, 'volume_off'),
        ] : [
          m('i', {class: 'material-icons'}, 'volume_up'),
        ],
      ]),
    ];
  }
}



export class AudioMedia extends Media {
  view(vnode) {
    return m('div', {class: 'media-container audio'}, [
      m.fragment({
        oncreate: (vnode) => this.media.set(vnode.dom),
        onremove: () => this.media.destroy(),
      }, [
        m('audio', {
          onloadedmetadata: m.redraw,
          ontimeupdate: m.redraw,
          preload: 'metadata',
        }, [
          m('source', vnode.attrs),
        ]),
      ]),
      m('div', {
        class: 'controls'}, [
        m(MediaController, {media: this.media}),
        m(MediaTimestamp, {media: this.media}),
        m(MediaBar, {media: this.media}),
        m(MediaVolume, {media: this.media}),
      ]),
    ]);
  }
}


export class ImageMedia {
  constructor(vnode) {
    this.zoom = !!vnode.attrs.zoom;
  }

  view(vnode) {
    return m('div', {class: 'media-container image'}, [
      (this.zoom) ? [
        m('div', {
          class: 'zoom',
          onclick: () => this.zoom = false,
        }, [
          m('img', vnode.attrs),
        ]),
      ] : null,
      m('img', Object.assign({
        class: 'compact',
        onclick: () => this.zoom = true,
      }, vnode.attrs)),
    ]);
  }
}


export class VideoMedia extends Media {
  constructor(vnode) {
    super(vnode);

    this.hovering = true;
    this.show = {media: {}, volume: {}};

    this.fullscreen = false;

    this.useCustomControls = !window.browser.satisfies({
      safari: '>=0',
    });
  }

  get showControls() {
    return this.hovering ||
      (this.show.media.dragging || this.show.media.hovering) ||
      (this.show.volume.dragging || this.show.volume.hovering);
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
        onmousedown: (event) => {
          if (event.target.classList.contains('media-container')) {
            if (this.fullscreen) {
              this.fullscreen = false;
              m.redraw();
              if (document.fullscreenEnabled) {
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
          m('video', {
            onmousedown: () => this.media.playOrPause(),
            onloadedmetadata: m.redraw,
            ontimeupdate: m.redraw,
            preload: 'metadata',
            playsinline: true,
          }, [
            m('source', vnode.attrs),
          ]),
        ]),
        m('div', {
          class: [
            'controls',
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
            ondrag: (dragging) => this.show.media.dragging = dragging,
            onhover: (hovering) => this.show.media.hovering = hovering,
          }),
          m(MediaVolume, {
            media: this.media,
            ondrag: (dragging) => this.show.volume.dragging = dragging,
            onhover: (hovering) => this.show.volume.hovering = hovering,
          }),
          m('div', {
            class: 'fullscreen',
            onmousedown: () => {
              this.fullscreen = !this.fullscreen;
              m.redraw();
              if (document.fullscreenEnabled) {
                if (this.fullscreen) {
                  document.body.requestFullscreen();
                } else {
                  document.exitFullscreen();
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
        m('video', {
          controls: true,
          playsinline: true,
        }, [
          m('source', vnode.attrs),
        ]),
      ]);
    }
  }
}



import {
  Monaco,
  monacoIsLoaded,
  requireMonaco,
} from './monaco';


export class TextMedia {
  oninit(vnode) {
    const useMonaco = (vnode.attrs.useMonaco === undefined) || vnode.attrs.useMonaco;
    if (useMonaco) {
      if (!monacoIsLoaded()) {
        requireMonaco().then(m.redraw);
      }
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  view(vnode) {
    const useMonaco = (vnode.attrs.useMonaco === undefined) || vnode.attrs.useMonaco;

    return m('div', {class: 'media-container text'}, [
      (useMonaco) ? [
        (monacoIsLoaded()) ? [
          m(Monaco, Object.assign({
            class: 'monaco',
          }, vnode.attrs)),
        ] : [
          m('pre', [
            m('code', {class: 'text'}, 'loading monaco...'),
          ]),
        ],
      ] : [
        m('pre', [
          m('code', {class: 'text'}, vnode.attrs.value || (vnode.attrs.settings || {}).value),
        ]),
      ],
    ]);
  }
}