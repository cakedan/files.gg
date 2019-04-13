import m from 'mithril';

import {
  PDFJS,
  PDFJSComponent,
} from './pdfjs';

import {
  MediaComponent as TextMedia,
  TextTypes,
} from '../text';


export class MediaComponent {
  async oninit(vnode) {
    if (!PDFJS.isLoaded) {
      await PDFJS.load();
      m.redraw();
    }
  }

  view(vnode) {
    if (PDFJS.isLoaded) {
      return m('div', {class: 'media-container pdf'}, [
        m(PDFJSComponent, vnode.attrs),
      ]);
    } else {
      return m(TextMedia, {
        type: TextTypes.NATIVE,
        readonly: true,
        value: 'Loading PDFJS...',
      });
    }
  }
}

/*
export class PDFMedia {
  view(vnode) {
    return m('div', {
      class: ['media-container', 'pdf'].join(' '),
    }, [
      m(PDFComponent, vnode.attrs),
    ]);
  }
}


class PDFComponent {
  view(vnode) {
    return m('object', vnode.attrs);
  }
}
*/