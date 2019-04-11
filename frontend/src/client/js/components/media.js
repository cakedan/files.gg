import m from 'mithril';

import {
  formatTime,
  InputTypes,
} from '../utils';


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
    return (this.isCreated) ? this.media.volume * 100 : window.savedVolume;
  }

  set volume(volume) {
    window.savedVolume = volume;
    if (this.isCreated) {
      this.media.volume = (volume / 100);
      m.redraw();
    }
  }

  destroy() {
    this.media = null;
  }

  set(media) {
    this.media = media;
    this.media.volume = (window.savedVolume / 100);
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
  }

  oninit(vnode) {
    if (vnode.attrs.volume !== undefined) {
      window.savedVolume = vnode.attrs.volume;
      delete vnode.attrs.volume;
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
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

    if (typeof(vnode.attrs.oninteract) === 'function') {
      this.oninteract = vnode.attrs.oninteract;
    }
  }

  get interacting() {
    return this.hovering || this.dragging;
  }

  get hovering() {
    return this._hovering;
  }

  set hovering(value) {
    this._hovering = value
    this.oninteract(this.interacting);
    return this._hovering;
  }

  get dragging() {
    return this._dragging;
  }

  set dragging(value) {
    this._dragging = value
    this.oninteract(this.interacting);
    return this._dragging;
  }

  oninteract() {}
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
            (this.interacting) ? null : 'hidden',
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
              (this.interacting) ? 'active' : null,
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
        (this.interacting) ? [
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
        m('audio', Object.assign({}, vnode.attrs, {
          onloadedmetadata: m.redraw,
          ontimeupdate: m.redraw,
          preload: 'metadata',
        }), vnode.children),
      ]),
      m('div', {class: 'media-controls'}, [
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


export class VideoMedia extends Media {
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
    if (document.fullscreenElement) {
      return;
    }
    // user just unfullscreened the browser
    if (this.fullscreen) {
      this.fullscreen = false;
      m.redraw();
    }
  }

  onKeyDown(event) {
    if (event.key === 'Escape') {
      this.fullscreen = false;
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
            oninteract: (interacting) => this.interacting.media = interacting,
          }),
          m(MediaVolume, {
            media: this.media,
            oninteract: (interacting) => this.interacting.volume = interacting,
          }),
          m('div', {
            class: 'fullscreen',
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


import {
  Ace,
  AceComponent,
} from './ace';

import {
  CodeMirror,
  CodeMirrorComponent,
} from './codemirror';

import {
  Monaco,
  MonacoComponent,
} from './monaco';


export const TextTypes = Object.freeze({
  ACE: 'ace',
  CODEMIRROR: 'codemirror',
  MONACO: 'monaco',
  NATIVE: 'native',
});

export const MobileTextTypes = Object.freeze({
  ACE: TextTypes.ACE,
  CODEMIRROR: TextTypes.CODEMIRROR,
  NATIVE: TextTypes.NATIVE,
});


export class TextMedia {
  async oninit(vnode) {
    this.type = InputTypes.choices(Object.values(TextTypes), vnode.attrs.type, TextTypes.NATIVE);

    const editor = this.module;
    if (editor) {
      if (!editor.isLoaded) {
        await editor.load();
        m.redraw();
      }
      if (typeof(vnode.attrs.onload) === 'function') {
        vnode.attrs.onload({type: this.type, module: editor});
      }
    }
  }

  get module() {
    switch (this.type) {
      case TextTypes.ACE: return Ace;
      case TextTypes.CODEMIRROR: return CodeMirror;
      case TextTypes.MONACO: return Monaco;
      default: return null;
    }
  }

  onupdate(vnode) {
    const type = InputTypes.choices(Object.values(TextTypes), vnode.attrs.type, TextTypes.NATIVE);
    if (this.type !== type) {
      this.oninit(vnode);
      m.redraw();
    }
  }

  view(vnode) {
    let type = TextTypes.NATIVE;

    const editor = this.module;
    if (editor && editor.isLoaded) {
      type = this.type;
    }

    return m('div', {
      class: ['media-container', 'text', `type-${type}`].join(' '),
    }, [
      m(TextComponent, Object.assign({}, vnode.attrs, {
        type: this.type,
      })),
    ]);
  }
}


class TextComponent {
  view(vnode) {
    switch (vnode.attrs.type) {
      case TextTypes.ACE: {
        if (Ace.isLoaded) {
          return m(AceComponent, vnode.attrs);
        } else {
          return m(TextComponent, 'Loading Ace...');
        }
      };
      case TextTypes.CODEMIRROR: {
        if (CodeMirror.isLoaded) {
          return m(CodeMirrorComponent, vnode.attrs);
        } else {
          return m(TextComponent, 'Loading CodeMirror...');
        }
      };
      case TextTypes.MONACO: {
        if (Monaco.isLoaded) {
          return m(MonacoComponent, vnode.attrs);
        } else {
          return m(TextComponent, 'Loading Monaco...');
        }
      };
    }

    return m('pre', [
      m('code', {class: 'text'}, [
        vnode.attrs.value || (vnode.attrs.settings || {}).value,
      ]),
    ]);
  }
}
