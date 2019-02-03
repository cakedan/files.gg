const m = require('mithril');

class Page
{
	constructor(app, options)
	{
		this.app = app;

		options = options || {};

		this.auth = options.auth || false;
		this.class = ['page', options.class || null].filter((v)=>v).join(' ');

		this.paths = options.paths || [];
		if (options.path) {
			this.paths.push(options.path);
		}

		this.meta = Object.assign({
			title: 'File Uploader',
			description: 'Upload some files',
			'theme-color': '#43b581',
			favicon: null
		}, options.meta);
	}

	onmatch(args, requestedPath)
	{
		return Promise.resolve().then(() => {
			if (!this.auth || this.app.authed) {
				return this.init && this.init(args, requestedPath);
			}

			if (localStorage.token) {localStorage.removeItem('token');}

			return Promise.reject('/auth/login');
		}).then(() => {
			return new Promise((resolve) => {
				return (this.app.pagedelay) ? setTimeout(resolve, this.app.pagedelay) : resolve();
			});
		}).then(() => {
			const oembed = new URL(window.location.origin);
			oembed.pathname = '/api/oembed';
			oembed.searchParams.set('url', window.location.href);
			oembed.searchParams.set('format', 'json');

			this.app.head.setMetas(Object.assign({oembed: oembed.href, url: window.location.href}, this.meta));

			return this;
		}).catch((path) => {
			return m.route.set(path);
		});
	}

	render(vnode)
	{
		return [
			m(this.app.navbar),
			m('div', {class: this.class}, vnode)
		];
	}
}

module.exports = Page;