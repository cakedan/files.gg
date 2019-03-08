import m from 'mithril';


function generateUniqueKey() {
  return Date.now() + Math.random().toString(36).substring(7);
}

const Store = {
  error: null,
  key: null,
  state: null,
};
export const Recaptcha = Object.freeze({
  get grecaptcha() {
    return window && window.grecaptcha;
  },
  get isLoaded() {
    return !!(window && window.grecaptcha);
  },
  get loadState() {
    return Store.state;
  },
  get loadError() {
    return Store.error;
  },
  get url() {
    return new URL('https://www.google.com/recaptcha/api.js');
  },
  async load(language) {
    if (this.isLoaded) {
      return this.grecaptcha;
    }
    Store.state = 'loading';

    const onLoadName = 'onGRecaptchaLoad' + generateUniqueKey();
    const url = this.url;
    url.searchParams.set('render', 'explicit');
    url.searchParams.set('onload', onLoadName);
    if (language) {
      // https://developers.google.com/recaptcha/docs/language
      url.searchParams.set('hl', language);
    }

    await new Promise((resolve, reject) => {
      window[onLoadName] = () => {
        delete window[onLoadName];
        resolve();
      };

      const node = document.createElement('script');
      node.src = url.href;
      node.async = true;
      node.defer = true;
      document.head.appendChild(node);

      setTimeout(() => {
        if (!this.isLoaded) {
          reject(new Error('Captcha took longer than 5 seconds to import'));
        }
      }, 5000);
    }).then(() => {
      Store.state = 'loaded';
    }).catch((error) => {
      Store.state = 'error';
      Store.error = error;
    });
  },
  getKey() {
    return Store.key;
  },
  setKey(key) {
    return Store.key = key;
  },
});


const callbackParameters = ['callback', 'expired-callback', 'error-callback'];
function filterRenderOptions(options) {
  options = Object.assign({
    sitekey: Recaptcha.getKey(),
  }, options);
  const callbacks = [];

  for (let key of callbackParameters) {
    if (typeof(options[key] === 'function')) {
      const callback = options[key];
      const name = 'onGRecaptcha' + key.split('-').map((k) => {
        return k.slice(0, 1).toUpperCase() + k.slice(1);
      }).join('') + generateUniqueKey();

      callbacks.push(name);
      options[key] = name;
      window[name] = callback;
    }
  }

  return {callbacks, options};
}


class RecaptchaWrapper {
  constructor(id) {
    this.id = id;
    this.callbacks = [];
  }

  get isLoaded() {
    return Recaptcha.isLoaded;
  }

  get hasId() {
    return (this.id !== undefined && this.id !== null);
  }

  render(dom, unfilteredOptions) {
    if (!Recaptcha.isLoaded) {return;}
    this.reset();

    const {callbacks, options} = filterRenderOptions(unfilteredOptions);
    this.callbacks = callbacks;
    this.id = Recaptcha.grecaptcha.render(dom, options);
  }

  reset() {
    while (this.callbacks.length) {
      const name = this.callbacks.shift();
      delete window[name];
    }
    if (this.hasId && Recaptcha.isLoaded) {
      Recaptcha.grecaptcha.reset(this.id);
    }
    this.id = null;
  }

  getResponse() {
    if (!Recaptcha.isLoaded || !this.hasId) {
      return null;
    }
    return Recaptcha.grecaptcha.getResponse(this.id);
  }

  execute() {
    if (!Recaptcha.isLoaded || !this.hasId) {
      return null;
    }
    return Recaptcha.grecaptcha.execute(this.id);
  }
}


export class RecaptchaComponent {
  constructor(vnode) {
    this.recaptcha = new RecaptchaWrapper();

    if (typeof(vnode.attrs.ongrecaptcha) === 'function') {
      vnode.attrs.ongrecaptcha(this.recaptcha);
    }
  }

  async oncreate(vnode) {
    this.loading = true;
    if (!Recaptcha.isLoaded) {
      await Recaptcha.load();
      m.redraw();
    }
    this.loading = false;

    this.recaptcha.render(vnode.dom, vnode.attrs);
  }

  onremove(vnode) {
    this.recaptcha.reset();
  }

  view(vnode) {
    return m('div', {
      class: [
        'g-recaptcha',
        vnode.attrs.class,
      ].filter((v) => v).join(' '),
    }, [
      (this.loading) ? [
        'loading recaptcha...',
      ] : [
        'recaptcha here',
      ],
      vnode.children,
    ]);
  }
}
