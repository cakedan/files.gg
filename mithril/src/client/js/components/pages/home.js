const m = require('mithril');

const Page = require('../page');
const Utils = require('../../utils');
const Constants = Utils.Constants;
const Tools = Utils.Tools;

class CustomPage extends Page
{
	constructor(app)
	{
		super(app, {
			path: '/',
			class: 'home'
		});

		this.meta.title = 'File Uploader';

		this.uploadType = Constants.UPLOAD_TYPES.FILE;
		this.defaultMime = 'application/octet-stream';
		
		this.files = [];

		this.raw = {
			data: null,
			height: 0,
			options: {type: 'text/plain'}
		};
	}

	hash(data)
	{
		let hash = 0;
		if (!data.length) return hash;

		for (let i = 0; i < data.length; i++) {
			let char = data.charCodeAt(i);
			hash = ((hash << 5 ) - hash) + char;
			hash = hash & hash; // Convert to 32bit integer
		}
		return hash;
	}

	changeType(type, event) {this.uploadType = type;}

	onInputMultipart(event)
	{
		if (!event.target.files.length) {
			this.files.multipart = null;
		} else {
			const files = [];
			for (let i = 0; i < event.target.files.length; i++) {
				files.push(event.target.files[i]);
			}
			const fetchIcons = () => {
				const file = files.shift();
				if (!file) {return m.redraw();}
				const info = {file, icon: null, data: null, uploaded: -1};
	
				const mimetype = file.type || this.defaultMime;
				const mimetypes = this.app.cache.get('mimetypes').filter((m) => m.mime === mimetype);

				const fileext = file.name.split('.').pop().toLowerCase();
				
				let extension = mimetypes.find((m) => m.extension === fileext);
				if (extension) {
					extension = extension.extension;
				} else {
					if (mimetype === 'application/octet-stream') {
						extension = 'bin';
					} else {
						extension = '.';
					}
				}
				if (mimetype.split('/').shift() === 'image') {
					file.urlObject = URL.createObjectURL(file);
				}
				return Promise.resolve().then(() => {
					const key = `icon.${mimetype.split('/').shift()}.${extension}`;
					if (this.app.cache.has(key)) {
						info.icon = this.app.cache.get(key);
					} else {
						return this.app.rest.request({
							method: 'get',
							url: `/api/mimetypes/icons/${mimetype}/${extension}`
						}).then(({url}) => {
							this.app.cache.set(key, url);
							info.icon = url;
						}).catch(console.error);
					}
				}).catch(console.error).then(() => {
					this.files.push(info);
					return fetchIcons();
				});
			}
			fetchIcons();
		}
		console.log(event, this.files);
		event.target.value = '';
	}

	fileRemove(info, fileKey, event)
	{
		if (this.files[fileKey] !== info) {return;}
		console.log(info, fileKey, event);
		this.files.splice(fileKey, 1);
	}

	fileUpload(info, fileKey, event)
	{
		if (this.files[fileKey] !== info) {return;}

		info.uploaded = 0;

		const formData = new FormData();
		formData.set('file', info.file);

		console.log(info, fileKey, event);

		return this.app.rest.request({
			method: 'post',
			url: `/api/files`,
			query: {type: 'multipart'},
			data: formData
		}).then((data) => {
			info.data = data;
			info.uploaded = 101;
			console.log(info);
			m.redraw();
		}).catch((e) => {
			info.data = e.message;
			info.uploaded = -2;
		});
	}

	rawUpload(event)
	{
		const data = this.raw.data;
		if (!data) {return;}

		const hash = this.hash(data);
		if (this.files.some((f) => f.file.hash === hash)) {return;}

		const info = {
			file: {
				name: this.raw.options.filename,
				size: data.length,
				type: this.raw.options.type,
				hash,
			},
			data: null,
			icon: null,
			uploaded: 0
		};
		this.files.push(info);

		const query = {type: 'raw'};

		if (info.file.name) {
			query.filename = info.file.name
		}

		return this.app.rest.request({
			method: 'post',
			url: `/api/files`,
			headers: {'content-type': info.file.type},
			query,
			data,
			serialize: (v) => v
		}).then((data) => {
			info.data = data;
			info.uploaded = 101;
			console.log(info);
			m.redraw();
		}).catch((e) => {
			info.data = e.message;
			info.uploaded = -2;
		});
	}
	
	rawSetHeight(event)
	{
		const target = event.target;
		setTimeout(() => {
			const scrollY = window.scrollY;

			target.style = 'auto';

			this.raw.height = Math.min(target.scrollHeight, 900);
			target.style.height = `${this.raw.height}px`;

			window.scrollTo(window.scrollX, scrollY);
		}, 0);
	}

	init(args, requestedPath)
	{
		return new Promise((resolve, reject) => {
			if (this.app.cache.has('mimetypes')) {
				resolve();
			} else {
				this.app.rest.request({
					method: 'get',
					url: `/api/mimetypes`
				}).then((data) => {
					this.app.cache.set('mimetypes', data);
				}).catch(console.error).then(resolve);
			}
		});
	}

	view()
	{
		const form = [];
		switch (this.uploadType) {
			case Constants.UPLOAD_TYPES.FILE: {
				form.push([
					m('div', {class: 'multipart'}, [
						m('div', {class: 'picker'}, [
							m('input', {
								id: 'files',
								type: 'file',
								multiple: true,
								onchange: this.onInputMultipart.bind(this)
							}),
							m('label', {for: 'files'}, 'Pick Files')
						])
					])
				]);
			}; break;
			case Constants.UPLOAD_TYPES.RAW: {
				form.push([
					m('div', {class: 'raw'}, [
						m('div', {class: 'text'}, [
							m('textarea', {
								rows: 1,
								oninput: m.withAttr('value', (value) => {this.raw.data = value}),
								onchange: this.rawSetHeight.bind(this),
								oncut: this.rawSetHeight.bind(this),
								onpaste: this.rawSetHeight.bind(this),
								ondrop: this.rawSetHeight.bind(this),
								onkeydown: this.rawSetHeight.bind(this),
								style: (this.raw.height) ? `height: ${this.raw.height}px` : '',
								placeholder: 'put some text in me'
							}, this.raw.data)
						]),
						m('div', {class: 'upload'}, [
							m('div', {class: 'options'}, []),
							m('div', {class: 'submit'}, [
								m('span', {onclick: this.rawUpload.bind(this)}, 'Upload')
							])
						])
					])
				]);
			}; break;
		}

		return [
			m('div', {class: 'head text-center'}, [
				m('h1', 'some file uploader')
			]),
			m('div', {class: 'content'}, [
				m('div', {class: 'types'}, Object.keys(Constants.UPLOAD_TYPES).map((key) => {
					return m('span', {
						class: ['type', (Constants.UPLOAD_TYPES[key] === this.uploadType) ? 'active' : null].filter((v) => v).join(' '),
						onclick: this.changeType.bind(this, Constants.UPLOAD_TYPES[key])
					}, key.toTitleCase());
				})),
				m('div', {class: 'info'}, [
					m('div', {class: 'upload-form'}, form),
					m('div', {class: 'files'}, this.files.map((info, i) => {

						const uploadButton = {params: {class: ['upload']}};
						if (info.uploaded === -2) {
							//error happened
							uploadButton.params.class.push('error');
							uploadButton.text = info.data;
						} else if (info.uploaded === -1) {
							//before
							uploadButton.params.class.push('submit');
							uploadButton.params.onclick = this.fileUpload.bind(this, info, i);
							uploadButton.text = 'Upload';
						} else if (0 <= info.uploaded && info.uploaded <= 100) {
							//during
							uploadButton.params.class.push('submitting');
							uploadButton.text = `Uploading...`;
						} else if (info.uploaded === 101) {
							//finished
							uploadButton.params.class.push('submitted');
							uploadButton.text = 'Uploaded';
						}
						uploadButton.params.class = uploadButton.params.class.join(' ');

						const image = [];
						if (info.file.urlObject) {
							image.push(m('img', {
								src: info.file.urlObject,
								onerror: (e) => {
									if (e.target.getAttribute('class') === 'icon') {return;}
									e.target.setAttribute('class', 'icon');
									e.target.src = info.icon || '';
								}
							}));
						} else {
							image.push(info.icon && m('img', {class: 'icon', src: info.icon}));
						}

						return m('div', {class: 'file'}, [
							m('div', {class: 'information'}, [
								m('div', {class: 'thumbnail'}, image),
								m('div', {class: 'info'}, [
									m('span', {class: 'name'}, info.file.name),
									m('span', {class: 'size'}, Tools.formatBytes(info.file.size, 2)),
									m('span', {class: 'mimetype'}, info.file.type || this.defaultMime)
								]),
								info.data && m('div', {class: 'urls'}, Object.keys(info.data.urls).map((key) => {
									return m('div', {class: 'url'}, [
										m('span', info.data.urls[key]),
										m('i', {
											class: 'icon copy',
											onclick: (e) => {
												const i = document.createElement('input');
												i.setAttribute('value', info.data.urls[key]),
												document.body.appendChild(i);
												i.select();
												document.execCommand('copy');
												document.body.removeChild(i);
											}
										})
									]);
								}))
							]),
							m('div', {class: 'actions'}, [
								m('div', {class: 'group'}, [
									m('span', uploadButton.params, uploadButton.text),
									m('span', {class: 'remove', onclick: this.fileRemove.bind(this, info, i)}, 'X')
								])
							])
						]);
					}))
				])
			])
		];
	}
}

module.exports = CustomPage;