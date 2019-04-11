import m from 'mithril';

import { Auth } from '../../auth';
import { InputTypes } from '../../utils';
import { Store as Options } from '../../utils/options';

import {
  TextMedia,
  TextTypes,
} from '../media';


const OptionTypes = Object.freeze({
  CUSTOMIZATION: 'customization',
  DASHBOARD: 'dashboard',
});


const Tools = Object.freeze({
  defaultOption: OptionTypes.CUSTOMIZATION,
  setOption(option) {
    if (Store.option !== option) {
      Store.option = option;
      this.setRoute();
    }
  },
  setRoute() {
    let route = '/options';
    if (Store.option !== null) {
      route += `/${Store.option}`;
    }
    if (m.route.get() !== route) {
      m.route.set(route, null, {replace: true});
    }
  },
});


const Store = {
  option: Tools.defaultOption,
};


export class Route {
  oninit(vnode) {
    if (vnode.attrs.optionType !== undefined) {
      const option = InputTypes.choices(
        Object.values(OptionTypes),
        vnode.attrs.optionType,
        Store.option,
      );
      Tools.setOption(option);
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
      m(OptionContent, vnode.attrs),
    ]);
  }
}
Route.className = 'options';


class OptionComponent {
  setType(event, option) {
    event.preventDefault();
    Tools.setOption(option);
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

    return m('div', {class: `content ${Store.option}`}, [
      m(OptionComponent, vnode.attrs),
    ]);
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

  oninit(vnode) {
    if (vnode.attrs.textType !== undefined) {
      Options.textType = vnode.attrs.textType;
    }
  }

  view(vnode) {
    return m('div', {class: 'modal'}, [
      m('div', {class: 'section'}, [
        m('div', {class: 'header'}, [
          m('span', {class: 'title'}, 'Text Editor'),
          m('span', {class: 'description'}, 'Mobile cannot use Monaco as a text editor.'),
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
                onclick: () => Options.textType = TextTypes.ACE,
                selected: Options.textType === TextTypes.ACE,
              }, 'Ace'),
              m(ItemComponent, {
                onclick: () => Options.textType = TextTypes.CODEMIRROR,
                selected: Options.textType === TextTypes.CODEMIRROR,
              }, 'Code Mirror'),
              (!window.isMobile) ? [
                m(ItemComponent, {
                  onclick: () => Options.textType = TextTypes.MONACO,
                  selected: Options.textType === TextTypes.MONACO,
                }, 'Monaco'),
              ] : null,
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