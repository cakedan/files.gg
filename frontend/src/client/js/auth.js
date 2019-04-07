import m from 'mithril';

import { Api } from './api';


const Store = {
  fingerprint: null,
  isAuthed: false,
  isAuthing: true,
  me: null,
  token: null,
  waiting: [],
};

export const Auth = Object.freeze({
  get isAuthed() {
    return Store.isAuthed;
  },
  get isAuthing() {
    return Store.isAuthing;
  },
  set isAuthing(value) {
    Store.isAuthing = value;
    if (!value) {
      while (Store.waiting.length) {
        (Store.waiting.shift())();
      }
    }
    return Store.isAuthing;
  },
  get token() {
    return Store.token;
  },
  get hasToken() {
    return !!Store.token;
  },
  get me() {
    return Store.me;
  },
  clear(redraw) {
    if (localStorage.getItem('token')) {
      localStorage.removeItem('token');
    }

    Store.token = null;
    Store.isAuthed = false;
    Store.me = null;
    Auth.isAuthing = false;
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
    Auth.isAuthing = true;
    if (!this.hasToken) {
      this.get();
      if (!this.hasToken) {
        Auth.isAuthing = false;
        throw new Error('Token is required to try for auth');
      }
    }

    try {
      Store.me = await Api.fetchMe();
      Store.isAuthed = true;
      Auth.isAuthing = false;
    } catch(error) {
      this.clear();
      throw error;
    }
  },
  async waitForAuth() {
    if (this.isAuthing) {
      await new Promise((resolve) => Store.waiting.push(resolve));
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