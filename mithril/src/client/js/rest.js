const m = require('mithril');

class Rest
{
	constructor(app)
	{
		this.app = app;

		this.defaults = {background: true};
		this.token = null;
	}

	setToken(token)
	{
		this.token = token;
	}

	encodeQuery(query)
	{
		return Object.keys(query).map((k) => {
			return `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`;
		}).join('&');
	}

	request(options)
	{
		if (!options.url) {return Promise.reject(new Error('lol no url specified'));}

		options = Object.assign({}, this.defaults, options);
		options.headers = Object.assign({}, options.headers, this.defaults.headers);

		if (options.useAuth) {
			Object.assign(options.headers, {'Authorization': this.token});
		}

		if (options.query) {
			options.url += ~options.url.indexOf('?') ? '&' : '?';
			options.url += this.encodeQuery(options.query);
		}

		return m.request(options);
	}
}

module.exports = Rest;