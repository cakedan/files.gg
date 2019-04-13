import m from 'mithril';

import { InputTypes } from '../../../../utils';
import { TextTypes } from '../index';


export class NativeComponent {
  constructor(vnode) {
    this.oneditor = InputTypes.func(vnode.attrs.oneditor, null);
    this.onselection = InputTypes.func(vnode.attrs.onselection, null);
    this.onvalue = InputTypes.func(vnode.attrs.onvalue, null);

    this.attributes = {
      oninput: ({target}) => {
        if (this.onvalue) {
          const payload = {value: target.value};
          this.onvalue(payload);
          if (payload.redraw || payload.redraw === undefined) {
            m.redraw();
          }
        }
      },
      autocapitalize: 'false',
      autocorrect: 'false',
      spellcheck: false,
    };
  }

  oninit(vnode) {
    const attributes = Object.assign({}, vnode.attrs, vnode.attrs.settings);
    for (let key in attributes) {
      switch (key) {
        case 'oneditor':
        case 'onselection':
        case 'onvalue': {
          this[key] = InputTypes.func(attributes[key], null);
        }; break;
        case 'readonly':
        case 'value': {
          this.attributes[key] = attributes[key];
        }; break;
      }
    }
  }

  onupdate(vnode) {
    this.oninit(vnode);
  }

  view(vnode) {
    return m('div', {class: 'native'}, [
      m.fragment({
        oncreate: ({dom}) => {
          if (this.oneditor) {
            this.oneditor({
              type: TextTypes.NATIVE,
              editor: dom,
            });
          }
        },
      }, [
        m('textarea', this.attributes),
      ]),
    ]);
  }
}
