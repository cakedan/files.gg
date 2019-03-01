import m from 'mithril';
import Api from './api';


class Auth {
  constructor() {
    this.authed = false;

    this._token = null;
  }

  get isAuthed() {
    return this.authed;
  }

  get token() {
    return this._token;
  }

  set token(token) {
    Api.setToken(token);
    return this._token = token;
  }

  get hasToken() {
    return !!this.token;
  }

  clear(redraw) {
    if (localStorage.getItem('token')) {
      localStorage.removeItem('token');
    }

    // clear data from store
    this.token = null;
    this.authed = false;
    if (redraw === undefined || redraw) {
      m.redraw();
    }
  }

  get() {
    if (localStorage.getItem('token')) {
      try {
        this.token = JSON.parse(localStorage.getItem('token'));
      } catch(error) {
        this.clear();
      }
    } else {
      this.token = null;
    }
  }

  set(token) {
    localStorage.setItem('token', JSON.stringify(token));
    this.token = token;
  }

  async try() {
    if (!this.hasToken) {
      throw new Error('Token is required to try for auth');
    }
    try {
      const me = await Api.fetchMe();
      this.authed = true;

      // set data in store

      return me;
    } catch(error) {
      this.clear();
      throw error;
    }
  }
}

export default new Auth();
