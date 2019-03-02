import m from 'mithril';

const defaultMetaTags = {
  title: 'File Uploader',
  description: 'Upload some files',
  'theme-color': '#43b581',
  favicon: null,
};


class HeadWrapper {
  constructor(dom) {
    this.dom = dom || document.head;

    this.metaTags = {};
    this.scriptTags = {};
    this.html = [];

    this.initialized = false;
    this.clearMeta();
  }

  clearMeta() {
    this.metaTags = {};
    this.setMetas(defaultMetaTags);
    return this;
  }

  setMeta(key, value) {
    const metatag = {};
    metatag[key] = value;
    return this.setMetas(metatag);
  }

  setMetas(metaTags) {
    const anyChange = Object.keys(metaTags).map((key) => {
      if (!metaTags[key]) {
        return false;
      }
      this.metaTags[key] = metaTags[key];
      return true;
    }).some((v) => v);

    if (anyChange) {
      m.redraw();
    }
    return this;
  }

  addScript(url, properties) {
    this.scriptTags[url] = properties;
    m.redraw();
  }

  initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    for (let i = 0; i < this.dom.childNodes.length; i++) {
      const node = this.dom.childNodes[i];
      if (!node.attributes || !node.attributes.length) {continue;}

      switch (node.tagName.toLowerCase()) {
        case 'link': {
          const rel = (node.rel || '').toLowerCase();
          const href = (node.href || '');

          if (rel === 'icon') {
            this.setMeta('favicon', href);
            continue;
          }
          if (rel === 'alternate') {
            this.setMeta('oembed', href);
            continue;
          }
        }; break;
        case 'meta': {
          const property = node.name || node.property;
          if (property) {
            this.setMeta(property, node.content);
            continue;
          }
        }; break;
        case 'title': {
          this.setMeta('title', node.innerText);
        }; continue;
      }

      this.html.push(node.outerHTML);
    }

    m.mount(this.dom, HeadComponent);
  }
}


export const Head = new HeadWrapper();


class HeadComponent {
  get htmlComponents() {
    return Head.html.map((html) => m.trust(html));
  }

  get metaComponents() {
    return Object.entries(Head.metaTags).map(([key, value]) => {
      switch (key) {
        case 'title': {
          return m('title', value);
        };
        case 'oembed': {
          return m('link', {
            rel: 'alternate',
            type: 'application/json+oembed',
            href: value,
          });
        };
        case 'favicon': {
          return m('link', {
            rel: 'icon',
            href: value,
          });
        };
        default: {
          return m('meta', {
            name: key,
            content: value,
          });
        };
      }
    });
  }

  get scriptComponents() {
    return Object.entries(Head.scriptTags).map(([src, attributes]) => {
      return m('script', Object.assign({src}, attributes));
    });
  }

  view(vnode) {
    return [
      this.htmlComponents,
      this.metaComponents,
      this.scriptComponents,
      vnode.children,
    ];
  }
}