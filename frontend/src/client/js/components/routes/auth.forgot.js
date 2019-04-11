export class Route {
  oninit(vnode) {
    this.loading = true;
    this.token = vnode.attrs.token;
    console.log(vnode.attrs);
    // Api.verify(this.token);
  }

  view(vnode) {
    return (this.loading) ? [
      'verifying token...',
    ] : [
      'verified token',
    ];
  }
}
Route.className = 'auth-forgot';
