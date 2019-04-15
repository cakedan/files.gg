import m from 'mithril';

import { formatTime } from '../../../utils';

export class PlayableMedia {
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


class MediaChild {
  constructor(vnode) {
    this.media = vnode.attrs.media;
  }

  onupdate(vnode) {
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

  set interacting(value) {
    this._hovering = value;
    this._dragging = value;
    if (this.oninteract) {
      this.oninteract(this.interacting);
    }
    return this.interacting;
  }

  get hovering() {
    return this._hovering;
  }

  set hovering(value) {
    this._hovering = value;
    if (this.oninteract) {
      this.oninteract(this.interacting);
    }
    return this._hovering;
  }

  get dragging() {
    return this._dragging;
  }

  set dragging(value) {
    this._dragging = value
    if (this.oninteract) {
      this.oninteract(this.interacting);
    }
    return this._dragging;
  }
}



export class MediaController extends MediaChild {
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


export class MediaTimestamp extends MediaChild {
  view(vnode) {
    return m('div', {class: 'timestamp'}, [
      m('span', {class: 'current'}, this.media.currentTime),
      '/',
      m('span', {class: 'duration'}, this.media.duration),
    ]);
  }
}


export class MediaBar extends MediaHoverDragChild {
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


export class MediaVolume extends MediaHoverDragChild {
  constructor(vnode) {
    super(vnode);

    this.div = null;
    this.lastVolume = this.media.volume || 100;

    this.listeners = {
      mousemove: this.onHover.bind(this),
      mouseup: this.onMouseUp.bind(this),
      touchcancel: this.onTouchEnd.bind(this),
      touchend: this.onTouchEnd.bind(this),
      touchmove: this.onTouchMove.bind(this),
    };
    for (let listener in this.listeners) {
      window.addEventListener(listener, this.listeners[listener]);
    }
  }

  get isMute() {
    return (this.media.volume === 0);
  }

  onClick(event) {
    this.interacting = true;
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

  onMouseUp(event) {
    this.dragging = false;
  }

  onTouchEnd(event) {
    this.interacting = false;
  }

  onTouchMove(event) {
    if (this.hovering) {
      this.interacting = true;
      this.onHover(event);
    }
  }

  muteOrUnmute(event) {
    if (event.target.className !== 'volume') {return;}

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
        onmouseleave: () => this.hovering = false,
        onmousemove: () => this.hovering = true,
        ontouchstart: () => this.hovering = !this.hovering,
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
        m('i', {class: 'material-icons'}, [
          (this.isMute) ? 'volume_off' : 'volume_up',
        ]),
      ]),
    ];
  }
}
