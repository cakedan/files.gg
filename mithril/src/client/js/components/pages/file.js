const m = require('mithril');

const Page = require('../page');
const Tools = require('../../utils').Tools;

const Prism = require('prismjs');

class CustomPage extends Page
{
	constructor(app)
	{
		super(app, {
			paths: ['/:fid...'],
			class: 'file'
		});

		this.mimetypes = {
			image: ['image/png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/gif', 'image/webp'],
			video: ['video/ogg', 'video/mpeg', 'video/mp4', 'video/webm', 'video/avi', 'video/msvideo']
		};

		this.zoomed = false;

		this.fileData = null;
		this.data = null;
		this.showIcon = false;
	}

	init(args, requestedPath)
	{
		const fid = args.fid.split('.').shift().split('/').slice(0, 2).filter((v) => v).join('.');

		return this.app.rest.request({
			method: 'get',
			url: `/api/files/${fid}`
		}).then((data) => {
			this.fileData = data;
		});
	}

	oninit()
	{
		const mtype = this.fileData.mimetype.split('/').shift();

		return Promise.resolve().then(() => {
			const iconKey = `icon.${mtype}.${this.fileData.extension}`;
			if (this.app.cache.has(iconKey)) {
				return this.app.cache.get(iconKey);
			} else {
				return this.app.rest.request({
					method: 'get',
					url: `/api/mimetypes/icons/${this.fileData.mimetype}/${this.fileData.extension || '.'}`
				}).then(({url}) => {
					this.app.cache.set(iconKey, url);
					return url;
				}).catch(console.error);
			}
		}).then((iconUrl) => {
			this.meta.title = [this.fileData.filename, this.fileData.extension].filter((v) => v).join('.');
			if (iconUrl) {
				this.meta.favicon = iconUrl;
			}
			m.redraw();
		}).then(() => {
			if (mtype === 'text') {
				if (this.fileData.size >= 1024 ** 1024) { //bigger than 1mb
					this.showIcon = true;
				} else {
					return this.app.rest.request({
						method: 'get',
						url: this.fileData.urls.cdn,
						deserialize: (v) => v
					}).then((data) => {
						this.data = data;
					}).catch((e) => {
						this.showIcon = true;
					});
				}
			}
		}).then(() => {
			m.redraw();
		}).catch(console.error);
	}

	view()
	{
		const file = this.fileData;
		const filename = [file.filename, file.extension].filter((v) => v).join('.');
		const mtype = file.mimetype.split('/').shift();

		const icon = this.app.cache.get(`icon.${mtype}.${file.extension}`);

		const items = [];
		if (!this.showIcon) {
			switch (mtype) {
				case 'image': {
					items.push([
						m('img', {
							src: file.urls.cdn,
							onclick: ({target}) => {
								this.zoomed = true;
								file.dimensions = {height: target.clientHeight, width: target.clientWidth};
								console.log(target, file, this.zoomed);
							},
							onerror: () => {this.showIcon = true;}
						})
					]);
				}; break;
				case 'video': {
					items.push([
						m('video', {controls: true}, [
							m('source', {
								src: file.urls.cdn,
								onerror: () => {this.showIcon = true;}
							})
						])
					]);
				}; break;
				case 'audio': {
					items.push([
						m('audio', {controls: true}, [
							m('source', {
								src: file.urls.cdn,
								onerror: () => {this.showIcon = true;}
							})
						])
					]);
				}; break;
				case 'text': {
					const pre = [];

					let language = file.mimetype.split('/').pop();
					if (!Prism.languages[language]) {language = file.extension;}
					const plang = Prism.languages[language];
					if (plang) {
						const prism = Prism.highlight(this.data, plang);
						pre.push(m('code', {class: `language-${language}`}, m.trust(prism)));
					} else {
						pre.push(m('code', {class: 'text'}, this.data));
					}

					items.push(m('pre', pre));
				}; break;
				default: this.showIcon = true;
			}
		}

		if (this.showIcon && icon) {
			items.push(m('img', {src: icon, class: 'icon'}));
		}

		items.push(m('span', {class: 'mimetype'}, file.mimetype));

		const zoom = [];
		if (this.zoomed) {
			const dimensions = {};
			if (file.dimensions.height >= file.dimensions.width) {
				dimensions.height = window.innerHeight * 0.90;
			} else {
				dimensions.width = window.innerWidth * 0.90;
			}
			zoom.push(m('div', {
				class: 'zoom',
				onclick: (e) => {this.zoomed = false}
			}, [
				m('img', {
					src: file.urls.cdn,
					style: Object.keys(dimensions).map((dimension) => [dimension, dimensions[dimension] + 'px'].join(':')).join(';')
				})
			]));
			console.log(dimensions, zoom);
		}

		return [
			zoom,
			m('div', {class: 'context'}, [
				m('div', {class: 'file'}, items),
				m('div', {class: 'footer'}, [
					m('div', {class: 'left'}, [
						m('span', {class: 'filename'}, filename),
						m('span', {class: 'timestamp'}, (new Date(file.timestamp * 1000)).toLocaleDateString())
					]),
					m('div', {class: 'right'}, [
						m('span', {class: 'filesize'}, Tools.formatBytes(file.size, 2)),
						m('a', {
							class: 'download',
							href: file.urls.cdn,
							download: filename
						}, 'Download')
					])
				])
			])
		];
	}
}

module.exports = CustomPage;