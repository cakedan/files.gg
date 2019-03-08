import m from 'mithril';


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

    if (typeof(vnode.attrs.onvalue) === 'function') {
      this.onvalue = vnode.attrs.onvalue;
    } else {
      this.onvalue = null;
    }

    vnode.attrs.settings = Object.assign({
      language: 'javascript',
      value: vnode.attrs.value,
    }, vnode.attrs.settings);

    this.class = vnode.attrs.settings.class || 'monaco';
    this.language = vnode.attrs.settings.language;
  }

  oncreate(vnode) {
    this.editor = monaco.editor.create(vnode.dom, vnode.attrs.settings);
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

    this.editor.onDidChangeModelLanguage((language, old) => {
      this.language = language;
    });
  }

  onbeforeupdate(vnode, old) {
    for (let key in vnode.attrs) {
      if (key === 'options') {
        for (let k in vnode.attrs[key]) {
          if (vnode.attrs[key][k] !== old.attrs[key][k]) {
            return true;
          }
        }
      } else if (vnode.attrs[key] !== old.attrs[key]) {
        return true;
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
