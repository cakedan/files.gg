import m from 'mithril';

import { Api } from './api';
import { Auth, Fingerprint } from './auth';
import { Head } from './components/head';
import { Mimetypes } from './utils';

import { FilesModal } from './components/files';
import { Navbar } from './components/navbar';
import {
  AuthForgotRoute,
  AuthLoginRoute,
  AuthLogoutRoute,
  AuthVerifyRoute,
  DashboardConfigsRoute,
  DashboardFilesRoute,
  ErrorRoute,
  FileRoute,
  HomeRoute,
  LegalTermsRoute,
  OptionsRoute,
} from './components/routes';


class RouteResolver {
  constructor(component, options) {
    this.component = component;
    options = Object.assign({}, options);

    this.authRequired = !!options.authRequired;
    this.className = [
      'route',
      this.component && this.component.className,
    ].filter((v) => v).join(' ');
  }

  async onmatch(args, requestedPath) {
    try {
      if (this.authRequired) {
        await Auth.waitForAuth();
        if (!Auth.isAuthed) {
          return m.route.set('/auth/login', null, {state: {redirect: requestedPath}});
        }
      }
      return this.component;
    } catch(error) {
      console.error(error);
      return m.route.set('/info/error', null, {state: {error: error.stack}});
    }
  }

  render(vnode) {
    return [
      m(Navbar),
      m('div', {class: this.className}, vnode),
      m(FilesModal, vnode.attrs),
    ];
  }
}


const Routes = Object.freeze({
  '/': new RouteResolver(HomeRoute, {class: 'home'}),
  '/auth/register': new RouteResolver(AuthLoginRoute, {class: 'auth-login'}),
  '/auth/login': new RouteResolver(AuthLoginRoute, {class: 'auth-login'}),
  '/auth/logout': new RouteResolver(AuthLogoutRoute, {class: 'auth-logout'}),
  //'/auth/callback/:token': new RouteResolver(AuthCallbackRoute), // for oauth2 logins
  '/auth/forgot/:token': new RouteResolver(AuthForgotRoute, {class: 'auth-forgot'}),
  '/auth/verify/:token': new RouteResolver(AuthVerifyRoute, {class: 'auth-verify'}),
  '/auth/:path...': new RouteResolver(ErrorRoute),
  '/dashboard': new RouteResolver(DashboardFilesRoute, {authRequired: true, class: 'dashboard-files'}),
  '/dashboard/configs': new RouteResolver(DashboardConfigsRoute, {authRequired: true, class: 'dashboard-configs'}),
  '/dashboard/files': new RouteResolver(DashboardFilesRoute, {authRequired: true, class: 'dashboard-files'}),
  '/dashboard/files/:fileId...': new RouteResolver(DashboardFilesRoute, {authRequired: true, class: 'dashboard-files'}),
  '/dashboard/:path...': new RouteResolver(ErrorRoute, {authRequired: true}),
  '/details/error': new RouteResolver(ErrorRoute),
  '/details/:path...': new RouteResolver(ErrorRoute),
  '/legal/report': new RouteResolver(),
  '/legal/terms': new RouteResolver(LegalTermsRoute),
  '/legal/:path...': new RouteResolver(ErrorRoute),
  '/options': new RouteResolver(OptionsRoute),
  '/options/:optionType': new RouteResolver(OptionsRoute),
  '/options/:optionType/:path...': new RouteResolver(ErrorRoute),
  '/:fileId...': new RouteResolver(FileRoute, {class: 'file'}),
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
    promises.push((async () => {
      await Mimetypes.fetch();
      m.redraw();
    })());

    return Promise.all(promises);
  },
});
