import m from 'mithril';

import {
  PlayableMedia,
  MediaBar,
  MediaController,
  MediaTimestamp,
  MediaVolume,
} from './playablemedia';


export class MediaComponent extends PlayableMedia {
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
