import Bowser from 'bowser';
import m from 'mithril';


const browser = Bowser.getParser(window.navigator.userAgent || '');
export const Browser = Object.freeze({
  get browser() {
    return browser;
  },
  get currentPath() {
    return m.route.get().split('?').shift().split('#').shift();
  },
  get isMobile() {
    return window.innerWidth <= 992;
  },
  get isInternetExplorer() {
    return this.satisfies({'internet explorer': '>=0'});
  },
  get isSafari() {
    return this.satisfies({safari: '>=0'});
  },
  satisfies() {
    return this.browser.satisfies(...arguments);
  },
  dimensions: {
    get small() {
      return window.innerWidth <= 992;
    },
  },
});


//temporary
Object.defineProperty(window, 'isMobile', {
  get: () => Browser.isMobile,
});
