import m from 'mithril';

import Auth from '../../auth';
import { Recaptcha } from '../recaptcha';

const Store = {
  email: {value: null, valid: false, error: null, show: false},
  username: {value: null, valid: false, error: null, show: false},
  password: {value: null, valid: false, error: null, show: false},
  captcha: {value: null, valid: false, error: null, show: false},
};


export class AuthLoginPage {
  constructor(vnode) {
    this.register = String(vnode.attrs.register).toLowerCase() === 'true';

    this.recaptcha = null;
  }

  flipType() {
    this.register = !this.register;
  }

  submit() {
    if (!this.recaptcha.isRendered) {return;}

    Store.captcha.show = true;
    Store.email.show = true;
    Store.username.show = true;
    Store.password.show = true;

    //create a callback system with random numbers n shit
    const captcha = this.recaptcha.getResponse();
    if (captcha) {
      Store.captcha.valid = true;
    } else {
      Store.captcha.valid = false;
      this.recaptcha.execute();
      return m.redraw();
    }
    console.log(captcha);
    console.log(Store);

    if (this.register) {
      if (!Store.email.valid) {
        return m.redraw();
      }
    }
    if (!Store.username.valid) {
      return m.redraw();
    }
    if (!Store.password.valid) {
      return m.redraw();
    }
  }

  view(vnode) {
    return m('div', {class: 'auth-form'}, [
      m('div', {class: 'wrapper'}, [
        m('div', {class: 'title'}, [
          m('h1', (this.register) ? 'Register' : 'Login'),
        ]),
        m('div', {class: 'information'}, [
          m('div', {class: 'fields'}, [
            (this.register) ? [
              m(EmailField),
            ] : null,
            m(UsernameField),
            m(PasswordField),
          ]),
          m('div', {class: 'submit'}, [
            m('span', {
              onclick: () => this.submit(),
            }, (this.register) ? 'Register' : 'Login'),
          ]),
          m('div', {class: 'flip'}, [
            (this.register) ? [
              m('span', {
                class: 'flipper',
                onclick: () => this.flipType(),
              }, 'Need to log into an account?'),
            ] : [
              m('span', 'Need to make an account?'),
              m('span', {
                class: 'flipper',
                onclick: () => this.flipType(),
              }, 'Register here'),
            ],
          ]),
          m(CaptchaField, {
            'data-badge': 'inline',
            'data-size': 'invisible',
            ongrecaptcha: (recaptcha) => this.recaptcha = recaptcha,
          }),
        ]),
      ]),
    ]);
  }
}


class Field {
  constructor(vnode) {
    this.type = vnode.attrs.type || 'field';
    this.active = false;
  }

  get valid() {
    return Store[this.type].valid;
  }

  set valid(value) {
    return Store[this.type].valid = value;
  }

  get value() {
    return Store[this.type].value;
  }

  set value(value) {
    if (value) {
      this.valid = this.validate(value);
    } else {
      this.show = false;
      this.valid = false;
    }
    return Store[this.type].value = value;
  }

  get show() {
    return Store[this.type].show;
  }

  validate(value) {
    return true;
  }

  view(vnode) {
    return m('div', {class: 'field'}, [
      m('div', {
        class: [
          'label',
          (this.active) ? 'active' : null,
        ].filter((v) => v).join(' '),
      }, [
        m('span', {
          class: (this.show) ? [
            (this.valid) ? 'valid' : 'invalid',
          ] : undefined,
        }, this.type),
        ':',
      ]),
      m('input', {
        type: this.type,
        onfocusin: () => this.active = true,
        onfocusout: () => this.active = false,
        oninput: ({target}) => this.value = target.value,
        value: this.value,
      }),
    ]);
  }
}


class EmailField extends Field {
  constructor(vnode) {
    vnode.attrs.type = 'email';
    super(vnode);
  }

  validate(value) {
    return value.includes('@');
  }
}


class UsernameField extends Field {
  constructor(vnode) {
    vnode.attrs.type = 'username';
    super(vnode);
  }
}

class PasswordField extends Field {
  constructor(vnode) {
    vnode.attrs.type = 'password';
    super(vnode);
  }
}


class CaptchaField {
  view(vnode) {
    return m('div', {
      class: [
        'captcha',
        (Store.captcha.show) ? [
          (Store.captcha.valid) ? 'valid' : 'loading',
        ] : null,
      ].filter((v) => v).join(' '),
    }, [
      m(Recaptcha, vnode.attrs),
    ]);
  }
}
