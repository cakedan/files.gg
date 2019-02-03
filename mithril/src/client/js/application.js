const m = require('mithril');

const Components = {
	Head: require('./components/head'),
	Navbar: require('./components/navbar'),
	Pages: require('./components/pages'),
	Recaptcha: require('./components/recaptcha')
};

const Rest = require('./rest');
const Utils = require('./utils');

class Application
{
	constructor(prefix, options)
	{
		options = options || {};

		m.route.prefix(prefix || '');

		this.rest = new Rest(this);
		this.cache = new Utils.Cache(3600);

		this.head = new Components.Head(this, document.getElementsByTagName('head')[0]);
		this.navbar = new Components.Navbar(this);

		this.recaptcha = new Components.Recaptcha(this, options.recaptchaKey);

		this.pages = {};
		Components.Pages.forEach((Page) => {
			const page = new Page(this);
			for (let path of page.paths) {
				if (path in this.pages) {
					throw new Error(`${path} is already taken!`);
				}
				this.pages[path] = {
					page,
					onmatch: page.onmatch.bind(page),
					render: page.render.bind(page)
				};
			}
		});
	}

	get authed()
	{
		return this.cache.has('users.me');
	}

	auth()
	{
		return new Promise((resolve, reject) => {
			//maybe check cache, idk
			if (!this.rest.token) {
				return reject(new Error('No token to auth with'));
			}

			this.rest.request({
				method: 'get',
				url: '/api/users/@me',
				query: {connections: true},
				useAuth: true
			}).then((data) => {
				this.cache.set('users.me', data, 0);
				resolve(data);
			}).catch(reject);
		});
	}

	renderMeta()
	{

	}

	start()
	{
		return Promise.resolve().then(() => {
			if (localStorage.token) {
				this.rest.setToken(JSON.parse(localStorage.getItem('token')));
				return this.auth();
			} else {
				return Promise.resolve();
			}
		}).catch(console.error).then(() => {
			m.mount(this.head.element, this.head);
			m.route(document.getElementById('app'), '/error/404', this.pages);
		});
	}
}

module.exports = Application;