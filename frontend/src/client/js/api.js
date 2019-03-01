import m from 'mithril';


function encodeQuery(query) {
  return Object.keys(query).map((k) => {
    return `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`;
  }).join('&');
}


class Api {
  constructor() {
    this.baseUrl = '';
    this.token = null;
  }

  setBaseUrl(url) {
    this.baseUrl = url;
  }

  setToken(token) {
    this.token = token;
  }

  request(options) {
    options = Object.assign({
      auth: false,
      background: true,
      method: 'get',
    }, options);
  
    options.headers = Object.assign({}, options.headers);
    if (options.auth) {
      if (this.token) {
        options.headers.authorization = this.token;
      } else {
        if (!options.authOptional) {
          throw new Error('Cannot use auth without a token present');
        }
      }
    }
  
    if (options.path) {
      if (!options.url && !this.baseUrl) {
        throw new Error('Specify a URL when using a path.');
      }
      options.url = (options.url || this.baseUrl) + options.path;
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
  }

  fetchFiles(query) {
    return this.request({
      auth: true,
      path: '/files',
      data: query,
    });
  }

  fetchFile(fileId) {
    return this.request({
      path: '/files/:fileId',
      params: {fileId},
    });
  }

  fetchMe() {
    return this.request({
      auth: true,
      path: '/users/@me',
    });
  }

  fetchMimetypes() {
    return this.request({path: '/mimetypes'});
  }

  uploadFile(data, options) {
    return this.request(Object.assign({}, options, {
      auth: true,
      authOptional: true,
      method: 'POST',
      path: '/files',
      data: data,
    }));
  }
}

export default new Api();
