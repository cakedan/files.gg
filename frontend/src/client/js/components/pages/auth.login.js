import m from 'mithril';

import { Api } from '../../api';
import { Auth, Fingerprint } from '../../auth';
import { PopupModal } from '../popup-modal';
import { RecaptchaComponent } from '../recaptcha';

const Store = {
  email: {value: null, valid: false, error: new Error('This field is required.'), show: false},
  username: {value: null, valid: false, error: new Error('This field is required.'), show: false},
  password: {value: null, valid: false, error: new Error('This field is required.'), show: false},
  captcha: {valid: false, error: null, show: false},
  forgot: {email: 'example@example.com', error: null, show: false},
};


export class AuthLoginPage {
  constructor(vnode) {
    this.register = window.currentPath.endsWith('/register');

    this.recaptcha = null;
    this.redirect = vnode.attrs.redirect || '/dashboard';
    if (this.redirect === window.currentPath) {
      this.redirect = '/dashboard';
    }

    if (Auth.isAuthed) {
      m.route.set(this.redirect);
    }
  }

  flipType() {
    this.register = !this.register;
    Store.email.show = false;
    Store.username.show = false;
    Store.password.show = false;
    Store.captcha.show = false;

    if (this.register) {
      m.route.set('/auth/register');
    } else {
      m.route.set('/auth/login');
    }
  }

  async forgotPassword() {
    if (this.register) {return;}

    for (let key in Store) {
      Store[key].show = false;
    }
    Store.email.show = true;
    if (!Store.email.valid) {
      return m.redraw();
    }
    Store.forgot.email = Store.email.value;
    console.log('forgot password for ', Store.email.value);
    try {
      const response = await Api.forgot(Store.email.value);
      Store.forgot.error = null;
      Store.forgot.show = true;
      console.log(response);
    } catch(error) {
      if ('errors' in error) {
        for (let key in error.errors) {
          Store[key].error = new Error(error.errors[key]);
          Store[key].show = true;
          Store[key].valid = false;
        }
        Store.forgot.error = null;
        Store.forgot.show = false;
      } else {
        Store.forgot.error = error;
        Store.forgot.show = true;
      }
      console.error(error);
    }
    m.redraw();
  }

  async submit() {
    if (!this.recaptcha.isLoaded) {return;}

    Store.captcha.show = true;
    Store.email.show = true;
    Store.username.show = true;
    Store.password.show = true;

    if (!Store.email.valid) {
      return m.redraw();
    }
    if (this.register) {
      if (!Store.username.valid) {
        return m.redraw();
      }
    }
    if (!Store.password.valid) {
      return m.redraw();
    }

    //create a callback system with random numbers n shit
    const captcha = this.recaptcha.getResponse();
    if (captcha) {
      Store.captcha.valid = true;
    } else {
      Store.captcha.valid = false;
      return this.recaptcha.execute();
    }
    console.log(captcha);
    console.log(Store);

    let token;
    if (this.register) {
      try {
        const response = await Api.register({
          email: Store.email.value,
          username: Store.username.value,
          password: Store.password.value,
          captcha: captcha,
        });
        token = response.token;
      } catch(error) {
        for (let key in error.errors) {
          if (key in Store) {
            Store[key].error = new Error(error.errors[key]);
            Store[key].valid = false;
            Store[key].show = true;
          }
        }

        this.recaptcha.reset();
        return m.redraw();
      }
    } else {
      try {
        const response = await Api.login({
          email: Store.email.value,
          password: Store.password.value,
          captcha: captcha,
        });
        token = response.token;
      } catch(error) {
        if ('errors' in error) {
          for (let key in error.errors) {
            if (key in Store) {
              Store[key].error = new Error(error.errors[key]);
              Store[key].valid = false;
              Store[key].show = true;
            }
          }
        } else {
          Store.password.error = new Error(error.message);
          Store.password.valid = false;
          Store.password.show = true;
        }

        this.recaptcha.reset();
        return m.redraw();
      }
    }
    console.log(token);
    if (token) {
      Auth.set(token);
      try {
        await Auth.try();
        Fingerprint.clear();
        m.route.set(this.redirect);
      } catch(error) {
        console.error(error);
      }
    }
  }

  view(vnode) {
    let canSubmit;
    if (this.register) {
      canSubmit = Object.keys(Store).every((key) => Store[key].valid);
    } else {
      canSubmit = Store.username.valid && Store.password.valid && Store.captcha.valid;
    }
    return [
      m('div', {class: 'auth-form'}, [
        m('div', {class: 'wrapper'}, [
          m('div', {class: 'title'}, [
            m('span', {class: 'header'}, (this.register) ? [
              'Create an account',
            ] : [
              'Login',
            ]),
          ]),
          m('div', {class: 'information'}, [
            m('div', {class: 'fields'}, [
              m(EmailField, {
                onsubmit: () => this.submit(),
              }),
              (this.register) ? [
                m(UsernameField, {
                  onsubmit: () => this.submit(),
                }),
              ] : null,
              m(PasswordField, {
                onsubmit: () => this.submit(),
              }),
            ]),
            (!this.register) ? [
              m('div', {class: 'forgot'}, [
                m('span', {
                  onclick: () => this.forgotPassword(),
                }, 'Forgot your password?'),
              ]),
            ] : null,
            m('div', {class: 'submit'}, [
              m('span', {
                class: (canSubmit) ? 'valid' : 'invalid',
                onclick: () => this.submit(),
              }, (this.register) ? 'Register' : 'Login'),
            ]),
            m(Flipper, {
              register: this.register,
              onclick: () => this.flipType(),
            }),
            m(CaptchaField, {
              badge: 'inline',
              size: 'invisible',
              theme: 'dark',
              ongrecaptcha: (recaptcha) => this.recaptcha = recaptcha,
              callback: (token) => this.submit(),
              'expired-callback': () => {
                Store.captcha.show = true;
                Store.captcha.valid = false;
              },
              'error-callback': () => {
                Store.captcha.error = new Error('Captcha errored, probably due to network');
                Store.captcha.show = true;
                Store.captcha.valid = false;
              },
            }),
          ]),
        ]),
      ]),
      (Store.forgot.show) ? [
        m(PopupModal, {
          onhide: () => Store.forgot.show = false,
          title: (Store.forgot.error) ? 'Error Sending Email' : 'Email Sent',
        }, [
          (Store.forgot.error) ? [
            m('strong', {class: 'error'}, Store.forgot.error.message),
          ] : [
            'Instructions to change your password has been sent to ',
            m('strong', Store.forgot.email),
            '. Please check your inbox and spam folder.',
          ],
        ]),
      ] : null,
    ];
  }
}


class Flipper {
  view(vnode) {
    const register = vnode.attrs.register;
    vnode.attrs.register = undefined;

    return m('div', {class: 'flip'}, [
      (register) ? [
        m('span', {
          class: 'flipper',
          ...vnode.attrs,
        }, 'Need to sign into an account?'),
      ] : [
        m('span', 'Need to make an account?'),
        m('span', {
          class: 'flipper',
          ...vnode.attrs,
        }, 'Register here'),
      ],
    ]);
  }
}


class Field {
  constructor(vnode) {
    this.type = vnode.attrs.type || 'field';
    this.active = false;

    if (typeof(vnode.attrs.onsubmit) === 'function') {
      this.onsubmit = vnode.attrs.onsubmit;
    }
  }

  get error() {
    return Store[this.type].error;
  }

  set error(value) {
    return Store[this.type].error = value;
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
      const validation = this.validate(value);

      this.valid = (validation === undefined) || validation;
      if (this.valid) {
        this.error = null;
      }
    } else {
      this.error = new Error('This field is required.');
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
    return m('div', {
      class: [
        'field',
        (this.show) ? [
          (this.valid) ? 'valid' : 'invalid',
        ] : null,
      ].filter((v) => v).join(' '),
    }, [
      m('div', {
        class: [
          'label',
          (this.active) ? 'active' : null,
        ].filter((v) => v).join(' '),
      }, [
        m('span', {class: 'type'}, this.type),
        (this.show) ? [
          (!this.valid && this.error) ? [
            m('span', {class: 'error'}, [
              m('span', {class: 'separator'}, '-'),
              m('span', {class: 'message'}, this.error.message),
            ]),
          ] : null,
        ] : null,
      ]),
      m('input', {
        type: this.type,
        onfocusin: () => this.active = true,
        onfocusout: () => this.active = false,
        oninput: ({target}) => this.value = target.value,
        onkeydown: (event) => {
          if (event.key === 'Enter') {
            if (this.onsubmit) {
              this.onsubmit();
            }
          }
        },
        placeholder: this.placeholder,
        spellcheck: false,
        value: this.value,
      }),
    ]);
  }
}


class EmailField extends Field {
  constructor(vnode) {
    super(vnode);
    this.placeholder = 'example@example.com';
    this.type = 'email';
  }

  validate(value) {
    const parts = value.split('@');
    if (parts.length !== 2) {
      this.error = new Error('Not a well formed email address.');
      return false;
    }

    const [alias, domain] = parts;
    if (!alias.length || domain.length < 3 || !domain.includes('.')) {
      this.error = new Error('Not a well formed email address.');
      return false;
    }

    if (128 < value.length) {
      this.error = new Error('Must be under 128 characters.');
      return false;
    }

    if (64 < alias.length) {
      this.error = new Error('Email alias must be under 64 characters.');
      return false;
    }

    if (255 < domain.length) {
      this.error = new Error('Email domain must be under 255 characters.');
      return false;
    }
  }
}


class UsernameField extends Field {
  constructor(vnode) {
    super(vnode);
    this.placeholder = 'Johnny';
    this.type = 'username';
  }

  validate(value) {
    if (value.length < 3 || 32 < value.length) {
      this.error = new Error('Must be between 3 and 32 characters.');
      return false;
    }
    //check if username is taken?
    //unless use discriminator system
  }
}

class PasswordField extends Field {
  constructor(vnode) {
    super(vnode);
    this.placeholder = '********';
    this.type = 'password';
  }

  validate(value) {
    if (value.length < 5) {
      this.error = new Error('Must be at least 5 characters.');
      return false;
    }
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
      m(RecaptchaComponent, vnode.attrs),
    ]);
  }
}
