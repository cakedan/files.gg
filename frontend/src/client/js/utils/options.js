import * as InputTypes from './inputtypes';

import { TextTypes } from '../components/media';


export const Tools = Object.freeze({
  refresh() {
    Options.textType = this.textType;
  },
  get textType() {
    if (localStorage && localStorage.getItem('textType')) {
      try {
        const textType = JSON.parse(localStorage.getItem('textType'));
        if (InputTypes.choices(Object.values(TextTypes), textType)) {
          return textType;
        }
      } catch(error) {}
      localStorage.removeItem('textType');
    }
    return (window.isMobile) ? TextTypes.CODEMIRROR : TextTypes.MONACO;
  },
  set textType(value) {
    const textType = InputTypes.choices(Object.values(TextTypes), value);
    if (textType) {
      localStorage.setItem('textType', JSON.stringify(value));
    }
  },
});


const Options = {
  textType: Tools.textType,
};


export const Store = {
  get textType() {
    return (window.isMobile) ? TextTypes.CODEMIRROR : Options.textType;
  },
  set textType(value) {
    Tools.textType = value;
    Options.textType = Tools.textType;
  },
};
