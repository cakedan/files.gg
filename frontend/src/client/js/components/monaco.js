import m from 'mithril';

import { InputTypes } from '../utils';


let monaco;
export const Monaco = Object.freeze({
  get monaco() {
    return monaco;
  },
  get languages() {
    return (monaco) ? monaco.languages.getLanguages() : [];
  },
  get isLoaded() {
    return !!monaco;
  },
  async load() {
    if (!this.isLoaded) {
      monaco = await import('monaco-editor');
    }
    return monaco;
  },
});


export class MonacoComponent {
  oninit(vnode) {
    if (!monaco) {
      throw new Error('Monaco isn\'t loaded!');
    }

    this.oneditor = InputTypes.func(vnode.attrs.oneditor, null);
    this.onselection = InputTypes.func(vnode.attrs.onselection, null);
    this.onvalue = InputTypes.func(vnode.attrs.onvalue, null);

    vnode.attrs.settings = Object.assign({
      language: 'javascript',
      value: vnode.attrs.value,
    }, vnode.attrs.settings);

    this.class = vnode.attrs.settings.class || 'monaco';
    this.language = vnode.attrs.settings.language;
  }

  oncreate(vnode) {
    this.editor = monaco.editor.create(vnode.dom, vnode.attrs.settings);
    if (this.oneditor) {
      this.oneditor(this.editor);
    }

    this.editor.onDidChangeModelContent((event) => {
      if (!this.onvalue) {return;}

      const payload = {
        editor: this.editor,
        value: this.editor.getValue(),
      };
      this.onvalue(payload);
      if (payload.redraw === undefined || payload.redraw) {
        m.redraw();
      }
    });

    this.editor.onDidChangeCursorSelection((event) => {
      if (this.onselection) {
        this.onselection(event);
      }
    });

    this.editor.onDidChangeModelLanguage((language, old) => {
      this.language = language;
    });
  }

  onbeforeupdate(vnode, old) {
    for (let key in vnode.attrs) {
      if (key.startsWith('on')) {
        continue;
      }

      if (key === 'settings') {
        for (let k in vnode.attrs[key]) {
          if (k === 'value') {
            if (!this.editor || vnode.attrs[key][k] !== this.editor.getValue()) {
              return true;
            }
          } else {
            if (vnode.attrs[key][k] !== old.attrs[key][k]) {
              return true;
            }
          }
        }
      } else {
        if (vnode.attrs[key] !== old.attrs[key]) {
          return true;
        }
      }
    }
    return false;
  }

  onupdate(vnode) {
    const options = Object.assign({
      value: vnode.attrs.value
    }, vnode.attrs.settings);

    this.editor.updateOptions(options);
    if (options.language && options.language !== this.language) {
      monaco.editor.setModelLanguage(this.editor.getModel(), options.language);
    }
    if (options.theme) {
      monaco.editor.setTheme(options.theme);
    }
    if (options.value !== undefined && options.value !== this.editor.getValue()) {
      this.editor.setValue(options.value);
    }
  }

  onremove(vnode) {
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
  }

  view(vnode) {
    return m('div', {class: this.class}, vnode.children);
  }
}
