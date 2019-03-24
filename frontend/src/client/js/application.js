import m from 'mithril';

import { Api } from './api';
import { Auth, Fingerprint } from './auth';
import { Head } from './components/head';
import { Mimetypes } from './utils';

import { Navbar } from './components/navbar';
import {
  AuthForgotPage,
  AuthLoginPage,
  AuthLogoutPage,
  AuthVerifyPage,
  DashboardConfigsPage,
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

    if (Array.isArray(options.class)) {
      options.class = ['page', ...options.class];
    } else {
      options.class = ['page', options.class];
    }
    this.class = options.class.filter((v) => v).join(' ');
  }

  async onmatch(args, requestedPath) {
    // on match can be a promise, it'll wait to resolve it
    // wait for auth if auth required?

    try {
      if (this.authRequired) {
        await Auth.waitForAuth();
        if (!Auth.isAuthed) {
          return m.route.set('/auth/login', null, {state: {redirect: requestedPath}});
        }
      }
      return this.page;
    } catch(error) {
      console.error(error);
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
  '/auth/logout': new RouteResolver(AuthLogoutPage, {class: 'auth-logout'}),
  //'/auth/callback/:token': new RouteResolver(AuthCallbackPage), // for oauth2 logins
  '/auth/forgot/:token': new RouteResolver(AuthForgotPage, {class: 'auth-forgot'}),
  '/auth/verify/:token': new RouteResolver(AuthVerifyPage, {class: 'auth-verify'}),
  '/auth/:path...': new RouteResolver(ErrorPage),
  '/dashboard': new RouteResolver(null, {authRequired: true}),
  '/dashboard/configs': new RouteResolver(DashboardConfigsPage, {authRequired: true, class: 'dashboard-configs'}),
  '/dashboard/files': new RouteResolver(null, {authRequired: true}),
  '/dashboard/:path...': new RouteResolver(ErrorPage, {authRequired: true}),
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
    // Head.initialize();
    // make the auth async, but also when they go to /dashboard and aren't authed yet, wait or something
    m.route(this.getDiv(id), '/', Routes);

    const promises = [];
    promises.push((async () => {
      try {
        await Auth.try();
      } catch(error) {}

      if (!Auth.isAuthed) {
        await Fingerprint.fetch();
        m.redraw();
      }
    })());
    promises.push(Mimetypes.fetch());

    return Promise.all(promises);
  },
});
