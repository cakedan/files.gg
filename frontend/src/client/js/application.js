import m from 'mithril';

import Auth from './auth';
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


class Application {
  constructor() {
    this.routes = {};
  }

  setPrefix(prefix) {
    m.route.prefix(prefix);
  }

  async run(id) {
    //const pages = await new Promise((resolve) => require(['./components/pages'], resolve));

    let div;
    if (id === undefined) {
      div = document.createElement('div');
      document.body.appendChild(div);
    } else {
      div = document.getElementById(id);
    }
    div.classList.add('app');

    m.route(div, '/', {
      '/': new RouteResolver(HomePage, {class: 'home'}),
      '/info/terms-of-service': new RouteResolver(TermsOfServicePage),//pages.InfoTOS),
      '/info/error': new RouteResolver(ErrorPage),
      '/info/:path...': new RouteResolver(ErrorPage),
      '/auth/login': new RouteResolver(AuthLoginPage),//pages.AuthLogin),
      '/auth/logout': new RouteResolver(),//pages.AuthLogout),
      '/auth/callback': new RouteResolver(),//pages.AuthCallback),
      '/auth/:path...': new RouteResolver(ErrorPage),
      '/dashboard': new RouteResolver(null, {authRequired: true}),//pages.Panel),
      '/dashboard/files': new RouteResolver(null, {authRequired: true}),//pages.PanelFiles),
      '/dashboard/:path...': new RouteResolver(ErrorPage),
      '/:fileId...': new RouteResolver(FilePage, {class: 'file'}),
    });

    const promises = [];

    promises.push((async () => {
      Auth.get();
      if (Auth.hasToken) {
        try {
          await Auth.try();
        } catch(error) {}
      }
      m.redraw();
    })());

    promises.push(Mimetypes.fetch());

    return Promise.all(promises);
  }
}

export default new Application();
