'use strict';

const m = require('mithril');

const name = 'Files.gg';
const nav = [
	{position: 'left', path: '/tos', name: 'Terms of Service', icon: 'check-circle'},
	{position: 'right', path: '/panel', name: 'Panel', authed: true},
	{position: 'right', path: '/auth/login', name: 'Login', authed: false},
	{position: 'right', path: '/auth/logout', name: 'Logout', authed: true}
];

class Navbar
{
	constructor(app)
	{
		this.app = app;

		this.buttons = {
			left: [],
			right: []
		};

		nav.forEach((page) => {
			const buttons = this.buttons[page.position];

			let component;
			if (page.type === undefined || page.type === 'button') {
				component = {
					view() {
						const current = m.route.get();
		
						const attributes = {
							href: page.path,
							class: ['nav-link', (current.startsWith(page.path)) ? 'active' : null]
						};
		
						if (!page.link) {
							Object.assign(attributes, {
								oncreate: m.route.link,
								onupdate: m.route.link
							});
						} else {
							attributes.class.push('link');
						}
		
						attributes.class = attributes.class.filter((v)=>v).join(' ');

						return m('a', attributes, [
							(page.icon) ? m('i', {class: `fa fa-${page.icon}`}) : null,
							page.name
						]);
					}
				};
			} else if (page.type === 'dropdown') {
				component = new Dropdown(page.name, page.paths);
			}

			buttons.push({
				app: this.app,
				authRequired: page.authed,
				component,
				view() {
					if (this.authRequired !== undefined) {
						if (this.authRequired && !this.app.authed) {return;}
						if (!this.authRequired && this.app.authed) {return;}
					}
					return m(this.component);
				}
			});
		});
	}

	view(vnode)
	{
		return m('nav', {class: 'file-nav'}, [
			m('a[href=/]', {oncreate: m.route.link, class:'navbar-brand'}, [
				m('i', {class: 'logo'}),
				name
			]),
			m('ul', {class: 'nav-category-left'}, this.buttons.left.map((c) => m(c))),
			m('ul', {class: 'nav-category-right'}, this.buttons.right.map((c) => m(c)))
		]);
	}
}

module.exports = Navbar;