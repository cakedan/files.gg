import m from 'mithril';

import {
  CodeMirror,
  CodeMirrorComponent,
  Monaco,
  MonacoComponent,
  NativeComponent,
} from './editors';

import { InputTypes } from '../../../utils';


export const TextTypes = Object.freeze({
  CODEMIRROR: 'codemirror',
  MONACO: 'monaco',
  NATIVE: 'native',
});

export const MobileTextTypes = Object.freeze({
  CODEMIRROR: TextTypes.CODEMIRROR,
  NATIVE: TextTypes.NATIVE,
});


export class MediaComponent {
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
      class: [
        'media-container',
        'text',
        `type-${type}`,
      ].join(' '),
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
      case TextTypes.CODEMIRROR: {
        if (CodeMirror.isLoaded) {
          return m(CodeMirrorComponent, vnode.attrs);
        }
        vnode.attrs.readonly = true;
      };
      case TextTypes.MONACO: {
        if (Monaco.isLoaded) {
          return m(MonacoComponent, vnode.attrs);
        }
        vnode.attrs.readonly = true;
      };
    }

    return m(NativeComponent, vnode.attrs);
  }
}
