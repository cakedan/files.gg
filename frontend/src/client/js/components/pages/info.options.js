import m from 'mithril';

import { Auth } from '../../auth';
import { Store as Options } from '../../utils/options';

import {
  TextMedia,
  TextTypes,
} from '../media';


const OptionTypes = Object.freeze({
  CUSTOMIZATION: 'customization',
  DASHBOARD: 'dashboard',
});


const Store = {
  option: OptionTypes.CUSTOMIZATION,
};


export class OptionsPage {
  oninit(vnode) {
    if (vnode.attrs.textType !== undefined) {
      Options.textType = vnode.attrs.textType;
    }
  }

  view(vnode) {
    return m('div', {class: 'option-modal'}, [
      m('div', {class: 'navigation'}, [
        m('div', {class: 'section'}, [
          m('div', {class: 'title'}, [
            m('span', 'General Options'),
          ]),
          m(OptionComponent, {
            option: OptionTypes.CUSTOMIZATION,
          }, 'Customization'),
          (Auth.isAuthed) ? [
            m('div', {class: 'divider'}, [
              m('span', {class: 'divider-line'}),
            ]),
            m('div', {class: 'title'}, [
              m('span', 'Dashboard Options'),
            ]),
            m(OptionComponent, {
              option: OptionTypes.DASHBOARD,
            }, 'Dashboard'),
          ] : null,
        ]),
      ]),
      m(OptionContent),
    ]);
  }
}


class OptionComponent {
  setType(event, option) {
    event.preventDefault();
    Store.option = option;
  }

  view(vnode) {
    return m('div', {
      class: [
        'option',
        (Store.option === vnode.attrs.option) ? 'active' : null,
      ].filter((v) => v).join(' '),
      onclick: (event) => this.setType(event, vnode.attrs.option),
    }, [
      m('span', vnode.children),
    ]);
  }
}


class OptionContent {
  view(vnode) {
    let OptionComponent = CustomizationOption;
    switch (Store.option) {
      case OptionTypes.CUSTOMIZATION: OptionComponent = CustomizationOption; break;
      case OptionTypes.DASHBOARD: OptionComponent = DashboardOption; break;
    }

    return m('div', {class: `content ${Store.option}`}, m(OptionComponent));
  }
}


class ItemComponent {
  oninit(vnode) {
    this.input = null;
  }

  view(vnode) {
    return m('div', {
      class: [
        'item',
        (vnode.attrs.selected) ? 'selected' : null,
      ].filter((v) => v).join(' '),
      onclick: () => this.input && this.input.click(),
    }, [
      m.fragment({
        oncreate: ({dom}) => this.input = dom,
        onremove: () => this.input = null,
      }, [
        m('input', {
          checked: vnode.attrs.selected,
          type: 'checkbox',
          onclick: (event) => {
            if (typeof(vnode.attrs.onclick) === 'function') {
              vnode.attrs.onclick(event);
            }
          },
        }),
      ]),
      m('span', {class: 'checkbox'}),
      m('div', {class: 'label'}, [
        m('span', vnode.children),
      ]),
    ]);
  }
}


class CustomizationOption {
  constructor() {
    this.text = [
      'Look at this cool text',
      'So cool!',
    ].join('\n');
  }

  view(vnode) {
    return m('div', {class: 'modal'}, [
      m('div', {class: 'section'}, [
        m('div', {class: 'header'}, [
          m('span', {class: 'title'}, 'Text Editor'),
          m('span', {class: 'description'}, 'Mobile will always use Code Mirror as the text editor'),
        ]),
        m('div', {class: 'fields'}, [
          m('div', {class: 'field'}, [
            m('div', {class: 'text-editor'}, [
              m(TextMedia, {
                type: Options.textType,
                value: this.text,
                onvalue: ({value}) => this.text = value,
              }),
            ]),
          ]),
          m('div', {class: 'field'}, [
            m('div', {class: 'items'}, [
              m(ItemComponent, {
                onclick: () => Options.textType = TextTypes.CODEMIRROR,
                selected: Options.textType === TextTypes.CODEMIRROR,
              }, 'Code Mirror'),
              m(ItemComponent, {
                onclick: () => Options.textType = TextTypes.MONACO,
                selected: Options.textType === TextTypes.MONACO,
              }, 'Monaco'),
            ]),
          ]),
        ]),
      ]),
    ]);
  }
}


class DashboardOption {
  view(vnode) {
    return 'dashboard settings, like the file view';
  }
}