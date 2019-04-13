import m from 'mithril';


let importedModule;
export const PDFJS = Object.freeze({
  get module() {
    return importedModule;
  },
  get isLoaded() {
    return !!this.module;
  },
  async load() {
    if (!this.isLoaded) {
      const pdfjs = await import('../../../bootstrap/pdfjs');
      importedModule = pdfjs.default;
    }
    return this.module;
  },
});


export class PDFJSComponent {
  constructor(vnode) {
    if (!PDFJS.isLoaded) {
      throw new Error('pdf.js is not loaded');
    }
    if (vnode.attrs.url === undefined) {
      throw new Error('Must define a URL to use pdf.js');
    }

    this.dom = null;
    this.lastScale = null;
  }

  async oninit(vnode) {
    if (vnode.attrs.url === this.url) {return;}
    this.url = vnode.attrs.url;

    const task = PDFJS.module.getDocument(this.url);
    this.document = await Promise.resolve(task.promise);
    await this.render();
  }

  async onupdate(vnode) {
    if (vnode.attrs.url !== this.url) {
      await this.oninit(vnode);
    } else {
      await this.render();
    }
  }

  oncreate(vnode) {
    this.dom = vnode.dom;
    this.render();
  }

  onremove(vnode) {
    this.dom = null;
  }

  async render() {
    if (!this.document || !this.dom) {return;}
    if (this.isRendering) {return;}
    this.isRendering = true;

    let scale = 0.8;
    if (window.isMobile) {
      scale = 0.5;
    }
    if (this.lastScale === scale) {return;}
    this.lastScale = scale;

    for (let i = 0; i < this.document.numPages; i++) {
      const page = await this.document.getPage(i + 1);

      const pageView = new PDFJS.module.pdfjsViewer.PDFPageView({
        container: this.dom,
        id: i,
        scale: scale,
        defaultViewport: page.getViewport(scale),
        textLayerFactory: new PDFJS.module.pdfjsViewer.DefaultTextLayerFactory(),
        annotationLayerFactory: new PDFJS.module.pdfjsViewer.DefaultAnnotationLayerFactory(),
      });
      pageView.setPdfPage(page);
      pageView.draw();
    }

    this.isRendering = false;
  }

  view(vnode) {
    return m('div', {class: 'pdfjs-document'});
  }
}
