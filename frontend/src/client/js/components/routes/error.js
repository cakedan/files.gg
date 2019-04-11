import { Head } from '../head';


export class Route {
  oninit(vnode) {
    this._error = vnode.attrs.error;

    /*
    Head.setMetas({
      title: '¯\_(ツ)_/¯',
      description: this.error,
    });
    */
  }

  get error() {
    if (window.currentPath === '/details/error' && this.error !== undefined) {
      return this.error.toString();
    }
    return '404 man lmao';
  }

  view(vnode) {
    return this.error;
  }
}
Route.className = 'error';
