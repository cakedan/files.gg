const m = require('mithril');

class Head
{
	constructor(app, head)
	{
		this.app = app;
		this.element = head;

		this.meta = {};
		this.scripts = {};

		this.html = [];
		for (let i = 0; i < head.childNodes.length; i++) {
			const node = head.childNodes[i];
			if (!node.attributes.length && !node.innerText.length) {continue;}
			switch (node.tagName.toLowerCase()) {
				case 'link': {
					const rel = (node.getAttribute('rel') || '').toLowerCase();
					const href = node.getAttribute('href') || '';
					if (rel === 'icon') {
						if (href.startsWith('https://cdn.files.gg/assets/icon')) {
							this.meta.favicon = href;
							continue;
						}
					} else if (rel === 'alternate') {
						this.meta.oembed = href;
						continue;
					}
					this.html.push(node.outerHTML);
				}; break;
				case 'meta': {
					const property = node.getAttribute('name');
					if (property) {
						this.meta[property] = node.getAttribute('content');
					} else {
						this.html.push(node.outerHTML);
					}
				}; break;
				case 'title': {
					this.meta.title = node.innerText;
				}; break;
				default: {
					this.html.push(node.outerHTML);
				}
			}
		}
		console.log(this.meta, this.html);
	}

	clearMeta()
	{
		this.meta = {};
		return this;
	}

	setMeta(key, value)
	{
		return this.setMetas({key: value});
	}

	setMetas(metas)
	{
		const any = Object.keys(metas).map((key) => {
			if (metas[key] === undefined) {return false;}
			if (metas[key] === null) {
				delete this.meta[key];
			} else {
				this.meta[key] = metas[key];
			}
			return true;
		});
		if (any.some((v) => v)) {
			m.redraw();
		}
		return this;
	}
	
	addScript(url, properties)
	{
		this.scripts[url] = properties;
		m.redraw();
	}

	view(vnode)
	{
		return [
			this.html.map((raw) => m.trust(raw)),
			Object.keys(this.meta).map((key) => {
				switch (key) {
					case 'title': {
						return m('title', this.meta[key]);
					}; break;
					case 'oembed': {
						return m('link', {rel: 'alternate', type: 'application/json+oembed', href: this.meta[key]});
					}; break;
					case 'favicon': {
						return m('link', {rel: 'icon', href: this.meta[key]});
					}; break;
					default: {
						return m('meta', {
							name: key,
							content: this.meta[key]
						});
					};
				}
			}),
			Object.keys(this.scripts).map((key) => {
				return m('script', Object.assign({src: key}, this.scripts[key]));
			}),
			vnode.children
		];
	}
}

module.exports = Head;