import m from 'mithril';

import { InputTypes } from '../utils';
import { TextTypes } from './media';


let importedModule;
export const CodeMirror = Object.freeze({
  get module() {
    return importedModule;
  },
  get languages() {
    return (this.module && this.module.modeInfo) ? this.module.modeInfo : [];
  },
  get isLoaded() {
    return !!this.module;
  },
  async load() {
    if (!this.isLoaded) {
      const codeMirror = await import('../bootstrap/codemirror');
      importedModule = codeMirror.default;
      for (let language of this.languages) {
        language.id = language.name.toLowerCase().replace(/ /g, '-');
      }
    }
    return this.module;
  },
  defaultLanguageId: 'plain-text',
  defaultTheme: 'tomorrow-night-bright',
  getLanguage(options) {
    if (options.extension && options.extension.startsWith('.')) {
      options.extension = options.extension.slice(1);
    }
    if (options.languageId) {
      options.languageId.toLowerCase().replace(/ /g, '-');
    }
    const languages = this.languages;
    if (options.languageId || options.extension || options.mimetype) {
      for (let language of languages) {
        if (language.id === options.languageId) {
            return language;
        }
        if (language.ext && language.ext.length && options.extension) {
          if (language.ext.includes(options.extension)) {
            return language;
          }
        }
        if (options.mimetype) {
          if (language.mime !== 'null' && language.mime === options.mimetype) {
            return language;
          }
          if (language.mimes && language.mimes.length && language.mimes.includes(options.mimetype)) {
            return language;
          }
        }
      }
    }
    return languages.find((language) => language.mode === this.defaultLanguageId);
  },
});


export class CodeMirrorComponent {
  oninit(vnode) {
    if (!CodeMirror.isLoaded) {
      throw new Error('CodeMirror isn\'t loaded!');
    }

    this.oneditor = InputTypes.func(vnode.attrs.oneditor, null);
    this.onselection = InputTypes.func(vnode.attrs.onselection, null);
    this.onvalue = InputTypes.func(vnode.attrs.onvalue, null);

    this.settings = Object.assign({
      mode: CodeMirror.defaultLanguageId,
      lineNumbers: true,
      theme: CodeMirror.defaultTheme,
      value: vnode.attrs.value || '',
    }, vnode.attrs.settings);
  }

  oncreate(vnode) {
    this.editor = CodeMirror.module(vnode.dom, this.settings);
    CodeMirror.module.loadMode(this.editor, this.settings.mode);
    if (this.oneditor) {
      this.oneditor({
        type: TextTypes.CODEMIRROR,
        editor: this.editor,
      });
    }

    this.editor.on('change', (editor, event) => {
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

    this.editor.on('cursorActivity', (editor) => {
      if (this.onselection) {
        this.onselection(editor.getCursor());
      }
    });
  }

  onupdate(vnode) {
    const options = Object.assign({
      value: vnode.attrs.value
    }, vnode.attrs.settings);

    if (options.mode !== undefined && options.mode !== this.editor.options.mode) {
      CodeMirror.module.loadMode(this.editor, options.mode);
      this.settings.mode = options.mode;
    }

    if (options.value !== undefined && options.value !== this.editor.getValue()) {
      this.editor.setValue(options.value);
      this.settings.value = options.value;
    }
  }

  view(vnode) {
    return m('div', {class: 'codemirror'});
  }
}
