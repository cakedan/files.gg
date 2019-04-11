import m from 'mithril';

import { InputTypes } from '../utils';
import { TextTypes } from './media';


let importedModule;
export const Ace = Object.freeze({
  get module() {
    return importedModule;
  },
  get languages() {
    return (this.module) ? this.module.bootstrap.modes : [];
  },
  get themes() {
    return (this.module) ? this.module.bootstrap.themes : [];
  },
  get isLoaded() {
    return !!this.module;
  },
  async load() {
    if (!this.isLoaded) {
      const ace = await import('../bootstrap/ace');
      importedModule = ace.default;
    }
    return this.module;
  },
  defaultLanguageId: 'text',
  defaultTheme: 'tomorrow_night',
  getLanguage(options) {
    if (options.languageId) {
      options.languageId.toLowerCase().replace(/-/g, '_');
    }
    const languages = this.languages;
    if (options.languageId || options.extension || options.mimetype) {
      for (let language of languages) {
        if (language.id === options.languageId) {
            return language;
        }
        if (language.mimetype === options.mimetype) {
          return language;
        }
      }
    }
    return languages.find((language) => language.id === this.defaultLanguageId);
  },
});


export class AceComponent {
  oninit(vnode) {
    if (!Ace.isLoaded) {
      throw new Error('Ace isn\'t loaded');
    }

    this.oneditor = InputTypes.func(vnode.attrs.oneditor, null);
    this.onselection = InputTypes.func(vnode.attrs.onselection, null);
    this.onvalue = InputTypes.func(vnode.attrs.onvalue, null);

    this.settings = Object.assign({
      mode: Ace.defaultLanguageId,
      theme: Ace.defaultTheme,
      value: vnode.attrs.value || '',
    }, vnode.attrs.settings);
  }

  oncreate(vnode) {
    const settings = Object.assign({}, this.settings);
    settings.mode = Ace.module.tools.idToMode(settings.mode);
    settings.theme = Ace.module.tools.idToTheme(settings.theme);

    this.editor = Ace.module.edit(vnode.dom, settings);

    if (this.oneditor) {
      this.oneditor({
        type: TextTypes.ACE,
        editor: this.editor,
      });
    }

    this.editor.on('change', (event) => {
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

    this.editor.on('changeSelectionStyle', (event) => {
      console.log('selection', event);
    });
  }

  onupdate(vnode) {
    const options = Object.assign({
      value: vnode.attrs.value
    }, vnode.attrs.settings);

    if (options.mode !== undefined && options.mode !== this.settings.mode) {
      Ace.module.loadMode(this.editor, options.mode);
      this.settings.mode = options.mode;
    }

    if (options.theme !== undefined && options.theme !== this.settings.theme) {
      Ace.module.loadTheme(this.editor, options.theme);
      this.settings.theme = options.theme;
    }

    if (options.value !== undefined && options.value !== this.editor.getValue()) {
      this.editor.setValue(options.value);
      this.settings.value = options.value;
    }
  }

  onremove(vnode) {
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
  }

  view(vnode) {
    return m('div', {class: 'ace-editor'});
  }
}
