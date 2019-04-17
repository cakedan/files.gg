import m from 'mithril';

import { Auth } from '../auth';
import { Browser } from '../utils';

import branding from '../../assets/branding.png';


class MobileDropdown {
  oninit(vnode) {
    this.active = !!vnode.attrs.active;
  }

  view(vnode) {
    return [
      m('a', {
        class: 'trigger',
        onclick: () => this.active = !this.active,
      }, [
        m('i', {class: 'material-icons'}, 'menu'),
      ]),
      (this.active) ? m.fragment({
        onbeforeremove: (vnode) => {
          //animation of removal
        },
      }, [
        m('div', {
          class: 'sidenav-overlay',
          onclick: () => this.active = false,
        }),
        m('ul', {
          class: 'sidenav',
          onclick: ({target}) => {
            if (!target.classList.contains('sidenav')) {
              this.active = false;
            }
          },
        }, vnode.children),
      ]) : null,
    ];
  }
}


class UserDropdown {
  oninit(vnode) {
    this.user = vnode.attrs.user || {};
    this.active = vnode.attrs.active;
    this.dropdownLocation = 0;
  }

  view(vnode) {
    return vnode.children;
  }
}


class NavbarLink {
  oninit(vnode) {
    vnode.attrs.oncreate = m.route.link;
    vnode.attrs.onupdate = m.route.link;
  }

  view(vnode) {
    if (vnode.attrs.href === Browser.currentPath) {
      vnode.attrs.class = [vnode.attrs.class, 'active'].filter((v) => v).join(' ');
    }
    return m('a', vnode.attrs, vnode.children);
  }
}


export class Navbar {
  view(vnode) {
    return m('nav', [
      (Browser.isMobile) ? [
        m('div', {class: 'mobile'}, [
          m(MobileDropdown, [
            m('li', [
              m(NavbarLink, {href: '/legal/terms'}, 'Terms'),
            ]),
            m('li', [
              m(NavbarLink, {href: '/options'}, 'Options'),
            ]),
            m('div', {class: 'divider'}),
            (Auth.isAuthed) ? [
              m('li', [
                m(NavbarLink, {href: '/dashboard'}, 'Dashboard'),
              ]),
              m('li', [
                m(NavbarLink, {href: '/auth/logout'}, 'Logout'),
              ]),
            ] : [
              m('li', [
                m(NavbarLink, {href: '/auth/login'}, 'Login'),
              ]),
            ],
          ]),
          m(NavbarLink, {href: '/', class: 'brand'}, [
            m('img', {src: branding}),
          ]),
        ]),
      ] : [
        m('div', {class: 'desktop'}, [
          m(NavbarLink, {href: '/', class: 'brand'}, [
            m('img', {src: branding}),
          ]),
          m('ul', {class: 'left'}, [
            m('li', [
              m(NavbarLink, {href: '/legal/terms'}, 'Terms'),
            ]),
            m('li', [
              m(NavbarLink, {href: '/options'}, 'Options'),
            ]),
          ]),
          m('ul', {class: 'right'}, [
            (Auth.isAuthed) ? [
              m('li', [
                m(NavbarLink, {href: '/dashboard'}, 'Dashboard'),
              ]),
              m(UserDropdown, {user: null}, [
                m(NavbarLink, {href: '/auth/logout'}, 'Logout'),
              ]),
            ] : [
              m('li', [
                m(NavbarLink, {href: '/auth/login'}, 'Login'),
              ]),
            ],
          ]),
        ]),
      ],
    ]);
  }
}
