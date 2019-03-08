import m from 'mithril';

import { Api } from './api';


const Store = {
  fingerprint: null,
  isAuthed: false,
  me: null,
  token: null,
};

export const Auth = Object.freeze({
  get isAuthed() {
    return Store.isAuthed;
  },
  get token() {
    return Store.token;
  },
  get hasToken() {
    return !!Store.token;
  },
  clear(redraw) {
    if (localStorage.getItem('token')) {
      localStorage.removeItem('token');
    }

    Store.token = null;
    Store.isAuthed = false;

    if (redraw === undefined || redraw) {
      m.redraw();
    }
  },
  get() {
    if (localStorage.getItem('token')) {
      try {
        Store.token = JSON.parse(localStorage.getItem('token'));
      } catch(error) {
        this.clear();
      }
    } else {
      Store.token = null;
    }
  },
  set(token) {
    localStorage.setItem('token', JSON.stringify(token));
    Store.token = token;
  },
  async try() {
    if (!this.has) {
      this.get();
      if (!this.has) {
        throw new Error('Token is required to try for auth');
      }
    }

    try {
      Store.me = await Api.fetchMe();
      Store.isAuthed = true;
    } catch(error) {
      this.clear();
      throw error;
    }
  },
});


export const Fingerprint = Object.freeze({
  get fingerprint() {
    return Store.fingerprint;
  },
  get has() {
    return !!Store.fingerprint;
  },
  clear() {
    if (localStorage.getItem('fingerprint')) {
      localStorage.removeItem('fingerprint');
    }

    Store.fingerprint = null;
  },
  get() {
    if (localStorage.getItem('fingerprint')) {
      try {
        Store.fingerprint = JSON.parse(localStorage.getItem('fingerprint'));
      } catch(error) {
        this.clear();
      }
    } else {
      Store.fingerprint = null;
    }
  },
  set(fingerprint) {
    localStorage.setItem('fingerprint', JSON.stringify(fingerprint));
    return Store.fingerprint = fingerprint;
  },
  async fetch() {
    if (!this.has) {
      this.get();
    }

    try {
      const response = await Api.fetchFingerprint();
      return this.set(response.fingerprint);
    } catch(error) {
      console.error(error);
    }
  },
});