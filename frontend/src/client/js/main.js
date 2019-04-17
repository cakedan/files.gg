import '../assets/favicon.ico';

import m from 'mithril';


Object.defineProperty(window, 'currentPath', {
  get: () => m.route.get().split('?').shift(),
});

Object.defineProperty(window, 'savedVolume', {
  get: () => {
    let volume = 100;
    if (localStorage.getItem('savedVolume')) {
      const savedVolume = parseFloat(localStorage.getItem('savedVolume'));
      if (Number.isNaN(savedVolume)) {
        localStorage.removeKey('savedVolume');
      } else {
        volume = Math.max(Math.min(savedVolume, 100), 0);
        if (savedVolume !== volume) {
          localStorage.setItem('savedVolume', volume);
        }
      }
    }
    return volume;
  },
  set: (volume) => {
    if (typeof(volume) !== 'number') {
      throw new TypeError('Volume has to be a number');
    }
    volume = Math.max(Math.min(volume, 100), 0);
    localStorage.setItem('savedVolume', volume);
    return volume;
  },
});

// for monaco
window.addEventListener('resize', () => m.redraw());


import { Application } from './application';
import { Recaptcha } from './components/recaptcha';
import { Tools as OptionTools } from './utils/options';

document.addEventListener('DOMContentLoaded', () => {
  OptionTools.refresh();
  Recaptcha.setKey('6Ld9nFcUAAAAAACsN328JLBsqikCn2wbTQDTVj4J');

  Application.setPrefix('');
  Application.run();
});
