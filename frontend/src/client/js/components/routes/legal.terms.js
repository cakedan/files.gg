export class Route {
  oninit(vnode) {
    console.log(vnode, vnode.attrs);
  }

  view(vnode) {
    return 'dont upload illegal stuff bro (template)';
  }
}
Route.className = 'legal-terms';
