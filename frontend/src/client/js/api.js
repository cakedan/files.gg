import m from 'mithril';

import { Auth, Fingerprint } from './auth';


export const ApiRoutes = Object.freeze({
  BASE_URL: 'https://api.files.gg',
  BASE_VERSION: '',
  AUTH_FINGERPRINT: '/auth/fingerprint',
  AUTH_FORGOT: '/auth/forgot',
  AUTH_FORGOT_RESET: '/auth/forgot/reset',
  AUTH_LOGIN: '/auth/login',
  AUTH_LOGOUT: '/auth/logout',
  AUTH_REGISTER: '/auth/register',
  AUTH_VERIFY: '/auth/verify',
  FILES: '/files',
  FILE: '/files/:fileId',
  MIMETYPES: '/mimetypes',
  USER: '/users/:userId',
  USER_ME: '/users/@me',
});


export const Api = Object.freeze({
  request(options) {
    options = Object.assign({
      auth: false,
      background: true,
      method: 'get',
    }, options);
  
    options.headers = Object.assign({}, options.headers);
    if (options.auth) {
      if (Auth.hasToken) {
        options.headers.authorization = Auth.token;
      } else {
        if (!options.authOptional) {
          throw new Error('Cannot use auth without a token present');
        }
      }
    }

    if (options.fingerprint === undefined || options.fingerprint) {
      if (Fingerprint.has && !Auth.hasToken) {
        options.headers['x-fingerprint'] = Fingerprint.fingerprint;
      }
    }
  
    if (options.path) {
      if (!options.url && !ApiRoutes.BASE_URL) {
        throw new Error('Specify a URL when using a path.');
      }
      const baseUrl = (options.url || (ApiRoutes.BASE_URL + ApiRoutes.BASE_VERSION));
      options.url = baseUrl + options.path;
    } else if (!options.url) {
      throw new Error('Specify a URL.');
    }

    if (options.query) {
			options.url += ~options.url.indexOf('?') ? '&' : '?';
			options.url += encodeQuery(options.query);
		}
  
    if (options.params && typeof(options.params) === 'object') {
      for (let key in options.params) {
        options.url = options.url.replace(`:${key}`, encodeURIComponent(options.params[key]));
      }
    }
  
    return m.request(options);
  },
  fetchFiles(query) {
    return this.request({
      auth: true,
      authOptional: true,
      path: ApiRoutes.FILES,
      data: query,
    });
  },
  fetchFile(fileId, query) {
    return this.request({
      path: ApiRoutes.FILE,
      params: {fileId},
      query: query,
    });
  },
  fetchFingerprint() {
    return this.request({path: ApiRoutes.AUTH_FINGERPRINT});
  },
  fetchMe() {
    return this.request({
      auth: true,
      path: ApiRoutes.USER_ME,
    });
  },
  fetchMimetypes() {
    return this.request({path: ApiRoutes.MIMETYPES});
  },
  forgot(email) {
    return this.request({
      method: 'POST',
      path: ApiRoutes.AUTH_FORGOT,
      data: {email},
    });
  },
  forgotReset(token, password) {
    return this.request({
      method: 'POST',
      path: ApiRoutes.AUTH_FORGOT_RESET,
      data: {token, password},
    });
  },
  login(data) {
    return this.request({
      method: 'POST',
      path: ApiRoutes.AUTH_LOGIN,
      data: data,
    });
  },
  logout() {
    return this.request({
      auth: true,
      method: 'POST',
      path: ApiRoutes.AUTH_LOGOUT,
    });
  },
  register(data) {
    return this.request({
      method: 'POST',
      path: ApiRoutes.AUTH_REGISTER,
      data: data,
    });
  },
  verify(token) {
    return this.request({
      method: 'POST',
      path: ApiRoutes.AUTH_VERIFY,
      data: {token},
    });
  },
  uploadFile(data, options) {
    return this.request(Object.assign({}, options, {
      auth: true,
      authOptional: true,
      method: 'POST',
      path: ApiRoutes.FILES,
      data: data,
    }));
  },
});


function encodeQuery(query) {
  return Object.keys(query).map((k) => {
    return `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`;
  }).join('&');
}
