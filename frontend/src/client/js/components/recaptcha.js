import m from 'mithril';

import { Head } from './head';

export const config = {key: null};

export function recaptchaIsLoaded() {
  return !!window.grecaptcha;
};

export function loadRecaptcha() {
  if (!recaptchaIsLoaded()) {
    //add it to head
    //https://www.google.com/recaptcha/api.js?onload=redraw&render=explicit
    Head.addScript('https://www.google.com/recaptcha/api.js?onload=redraw&render=explicit', {
      async: true,
      defer: true,
    });
  }
};

export function setSiteKey(key) {
  config.key = key;
};


class RecaptchaWrapper {
  constructor(id) {
    this.id = id;
    this.isRendering = false;

    this.executionRatelimit = 1000;
    this.lastExecution = 0;
  }

  get isExecuting() {
    // 1 second ratelimit?
    return Date.now() - this.lastExecution < this.executionRatelimit;
  }

  get isLoaded() {
    return recaptchaIsLoaded();
  }

  get isRendered() {
    return this.id !== undefined && this.id !== null;
  }

  setRatelimit(ratelimit) {
    this.executionRatelimit = ratelimit;
  }

  getResponse() {
    if (this.isLoaded && this.isRendered) {
      return window.grecaptcha.getResponse(this.id);
    }
    return null;
  }

  execute() {
    if (this.isLoaded && this.isRendered && !this.isExecuting) {
      this.lastExecution = Date.now();
      window.grecaptcha.execute(this.id);
    }
  }

  render(dom, callback) {
    if (this.isRendering) {return;}
    if (this.isLoaded && !this.isRendered) {
      this.isRendering = true;
      this.id = window.grecaptcha.render(dom, {sitekey: config.key});
      this.isRendering = false;
      if (typeof(callback) === 'function') {
        callback(this);
      }
    }
  }

  destroy() {
    if (this.isLoaded && this.isRendered) {
      window.grecaptcha.reset(this.id);
    }
    this.id = null;
  }
}


export class Recaptcha {
  constructor(vnode) {
    this.dom = null;
    this.recaptcha = new RecaptchaWrapper();

    if (typeof(vnode.attrs.ongrecaptcha) === 'function') {
      vnode.attrs.ongrecaptcha(this.recaptcha);
    }
    if (typeof(vnode.attrs.ongrecaptchaload === 'function')) {
      this.ongrecaptchaload = vnode.attrs.ongrecaptchaload;
    }
  }

  async oninit(vnode) {
    if (!recaptchaIsLoaded()) {
      loadRecaptcha();
    }
  }

  oncreate(vnode) {
    this.dom = vnode.dom;
    this.recaptcha.render(this.dom, this.ongrecaptchaload);
    // render will be ignored if grecaptcha isn't loaded
  }

  onremove(vnode) {
    this.dom = null;
    this.recaptcha.destroy();
  }

  view(vnode) {
    if (this.dom) {
      this.recaptcha.render(this.dom, this.ongrecaptchaload);
    }

    return m('div', Object.assign({
      'data-theme': 'dark',
    }, vnode.attrs, {
      'data-sitekey': config.key,
      'class': 'g-recaptcha',
    }), vnode.children);
  }

  ongrecaptchaload() {}
}
