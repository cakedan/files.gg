import { Head } from '../head';


export class ErrorPage {
  oninit(vnode) {
    this._error = vnode.attrs.error;

    Head.setMetas({
      title: '¯\_(ツ)_/¯',
      description: this.error,
    });
  }

  get error() {
    if (window.currentPath === '/info/error' && this.error !== undefined) {
      return this.error.toString();
    }
    return '404 man lmao';
  }

  view(vnode) {
    return this.error;
  }
}
