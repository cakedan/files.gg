export class ErrorPage {
  oninit(vnode) {
    this.error = vnode.attrs.error;
  }

  view(vnode) {
    if (window.currentPath === '/info/error' && this.error !== undefined) {
      return this.error.toString();
    }
    return '404 man lmao';
  }
}
