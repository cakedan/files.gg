import m from 'mithril';

import { Api } from './api';
import { Auth, Fingerprint } from './auth';
import { Head } from './components/head';
import { Mimetypes } from './utils';

import { Navbar } from './components/navbar';
import {
  AuthLoginPage,
  ErrorPage,
  FilePage,
  HomePage,
  TermsOfServicePage,
} from './components/pages';


class RouteResolver {
  constructor(page, options) {
    this.page = page;
    options = Object.assign({}, options);

    this.authRequired = !!options.authRequired;

    if (!Array.isArray(options.class)) {
      options.class = [options.class];
    }
    this.class = ['page'].concat(...options.class).filter((v) => v).join(' ');
  }

  onmatch() {
    try {
      if (this.authRequired && !Auth.isAuthed) {
        return m.route.set('/auth/login');
      }

      return this.page;
    } catch(error) {
      console.log(error);
      return m.route.set('/info/error', null, {state: {error: error.stack}});
    }
  }

  render(vnode) {
    return [
      m(Navbar, {title: 'files.gg'}),
      m('div', {class: this.class}, vnode),
    ];
  }
}


const Routes = Object.freeze({
  '/': new RouteResolver(HomePage, {class: 'home'}),
  '/info/terms-of-service': new RouteResolver(TermsOfServicePage),
  '/info/error': new RouteResolver(ErrorPage),
  '/info/:path...': new RouteResolver(ErrorPage),
  '/auth/register': new RouteResolver(AuthLoginPage, {class: 'auth-login'}),
  '/auth/login': new RouteResolver(AuthLoginPage, {class: 'auth-login'}),
  '/auth/logout': new RouteResolver(),//pages.AuthLogout),
  '/auth/callback': new RouteResolver(),//pages.AuthCallback),
  '/auth/:path...': new RouteResolver(ErrorPage),
  '/dashboard': new RouteResolver(null, {authRequired: true}),//pages.Panel),
  '/dashboard/files': new RouteResolver(null, {authRequired: true}),//pages.PanelFiles),
  '/dashboard/:path...': new RouteResolver(ErrorPage),
  '/:fileId...': new RouteResolver(FilePage, {class: 'file'}),
});

const Store = {
  div: null,
};

export const Application = Object.freeze({
  getDiv(id) {
    if (Store.div) {
      return Store.div;
    }
    let div;
    if (id === undefined) {
      div = document.createElement('div');
      document.body.appendChild(div);
    } else {
      div = document.getElementById(id);
    }
    div.classList.add('app');
    return Store.div = div;
  },
  setPrefix(prefix) {
    m.route.prefix(prefix);
  },
  async run(id) {
    //Head.initialize();
    //const pages = await new Promise((resolve) => require(['./components/pages'], resolve));
    m.route(this.getDiv(id), '/', Routes);

    const promises = [];
    promises.push((async () => {
      try {
        await Auth.try();
      } catch(error) {
        await Fingerprint.fetch();
      }
      m.redraw();

      if (Auth.hasToken || Fingerprint.has) {
        try {
          const response = await Api.fetchFiles();
          console.log(response);
        } catch(error) {
          console.error(error);
        }
      }
    })());
    promises.push(Mimetypes.fetch());

    return Promise.all(promises);
  },
});
