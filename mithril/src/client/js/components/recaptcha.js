const m = require('mithril');

class Recaptcha
{
	constructor(app, sitekey)
	{
		this.app = app;
		this.sitekey = sitekey;

		this.id = undefined;
	}

	getResponse()
	{
		return window.grecaptcha && window.grecaptcha.getResponse(this.id);
	}

	oncreate(vnode)
	{
		if (window.grecaptcha) {
			this.id = window.grecaptcha.render(vnode.dom, {sitekey: this.sitekey});
		} else {
			this.app.head.addScript('https://www.google.com/recaptcha/api.js', {async: true, defer: true});
			m.redraw();
		}
	}

	onremove(vnode)
	{
		window.grecaptcha.reset(this.id);
		this.id = undefined;
	}

	view(vnode)
	{
		return m('div', Object.assign({
			'data-theme': 'dark'
		}, vnode.attrs, {
			'data-sitekey': this.sitekey,
			'class': 'g-recaptcha',
		}), vnode.children)
	}
}

module.exports = Recaptcha;