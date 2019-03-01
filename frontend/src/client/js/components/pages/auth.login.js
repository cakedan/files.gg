import Auth from '../../auth';


export class AuthLoginPage {
  oninit(vnode) {
    console.log(vnode, vnode.attrs);
  }

  view(vnode) {
    return 'login please';
  }
}
