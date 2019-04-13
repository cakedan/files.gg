import m from 'mithril';

import { InputTypes } from '../../../../utils';
import { TextTypes } from '../index';


let importedModule;
export const Monaco = Object.freeze({
  get module() {
    return importedModule;
  },
  get languages() {
    return (this.module) ? this.module.languages.getLanguages() : [];
  },
  get themes() {
    return ['vs', 'vs-dark', 'hc-black'];
  },
  get isLoaded() {
    return !!this.module;
  },
  async load() {
    if (!this.isLoaded) {
      importedModule = await import('monaco-editor');
    }
    return this.module;
  },
  defaultLanguageId: 'plaintext',
  defaultTheme: 'vs-dark',
  getLanguage(options) {
    if (options.extension && !options.extension.startsWith('.')) {
      options.extension = '.' + options.extension;
    }
    const languages = this.languages;
    if (options.languageId || options.alias || options.extension || options.mimetype) {
      for (let language of languages) {
        if (language.id === options.languageId) {
          return language;
        }
        if (options.alias && language.aliases && language.aliases.length) {
          if (language.aliases.includes(options.alias)) {
            return language;
          }
        }
        if (options.extension && language.extensions && language.extensions.length) {
          if (language.extensions.includes(options.extension)) {
            return language;
          }
        }
        if (options.mimetype && language.mimetypes && language.mimetypes.length) {
          if (language.mimetypes.includes(options.mimetype)) {
            return language;
          }
        }
      }
    }
    return languages.find((language) => language.id === this.defaultLanguageId);
  },
});


export class MonacoComponent {
  oninit(vnode) {
    if (!Monaco.isLoaded) {
      throw new Error('Monaco isn\'t loaded!');
    }

    this.oneditor = InputTypes.func(vnode.attrs.oneditor, null);
    this.onselection = InputTypes.func(vnode.attrs.onselection, null);
    this.onvalue = InputTypes.func(vnode.attrs.onvalue, null);

    this.settings = Object.assign({
      automaticLayout: true,
      language: Monaco.defaultLanguageId,
      theme: Monaco.defaultTheme,
      value: vnode.attrs.value || '',
    }, vnode.attrs.settings);
  }

  oncreate(vnode) {
    this.editor = Monaco.module.editor.create(vnode.dom, this.settings);
    if (this.oneditor) {
      this.oneditor({
        type: TextTypes.MONACO,
        editor: this.editor,
      });
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
      this.settings.language = language;
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
    if (options.language && options.language !== this.settings.language) {
      Monaco.module.editor.setModelLanguage(this.editor.getModel(), options.language);
      this.settings.language = options.value;
    }
    if (options.theme) {
      Monaco.module.editor.setTheme(options.theme);
      this.settings.theme = options.theme;
    }
    if (options.value !== undefined && options.value !== this.editor.getValue()) {
      this.editor.setValue(options.value);
      this.settings.value = options.value;
    }
  }

  onremove(vnode) {
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }
  }

  view(vnode) {
    return m('div', {class: 'monaco'}, vnode.children);
  }
}
