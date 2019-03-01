import Bowser from 'bowser';

Object.defineProperty(window, 'browser', {
  value: Bowser.getParser(window.navigator.userAgent || ''),
});

import m from 'mithril';

import Application from './application';
import Api from './api';

Object.defineProperty(window, 'isMobile', {
  get: () => window.innerWidth <= 992,
});

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
        volume = savedVolume;
      }
    }
    return volume;
  },
  set: (volume) => {
    if (typeof(volume) !== 'number') {
      throw new TypeError('Volume has to be a number');
    }
    localStorage.setItem('savedVolume', volume);
  },
});

// for monaco
window.addEventListener('resize', () => m.redraw());

document.addEventListener('DOMContentLoaded', () => {
  Api.setBaseUrl('https://api.files.gg');
  Application.setPrefix('');
  Application.run();
});
