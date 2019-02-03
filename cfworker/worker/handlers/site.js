const m = require('mithril');
const toHtml = require('mithril-node-render');

const BaseHandler = require('./basehandler');
const JSONResponse = require('../jsonresponse');
const Utils = require('../utils');

class SiteHandler extends BaseHandler
{
	constructor(eventHandler)
	{
		super(eventHandler);

		this.spoofedUAs = ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.10; rv:38.0) Gecko/20100101 Firefox/38.0'];

		this.defaultMetatags = {
			charset: 'UTF-8',
			title: 'File Uploader',
			description: 'Upload some files',
			'theme-color': '#43b581',
			'og:site_name': 'https://files.gg',
			'twitter:card': 'summary',
			//'twitter:site': '@filesgg'
		};

		this.metatags = [
			{regex: /^(\/panel$|\/panel\/)/, tags: {title: 'File Uploader Panel'}},
			{regex: /^(\/panel\/files$)/, tags: {description: 'view ur files here'}},
			{regex: /^(\/error\/)/, tags: {description: 'some error here'}},
			{regex: /^(\/auth\/callback$)/, tags: {description: 'don\'t share this'}},
			{regex: /^(\/auth\/login$)/, tags: {description: 'Login here to view your files'}},
			{regex: /^(\/auth\/logout$)/, tags: {description: 'Logout here'}},
			{regex: /^(\/tos$)/, tags: {description: 'View our legal stuff here'}},
		];

		this.mimetypes = {
			audio: ['audio/mpeg', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-pn-wav', 'audio/x-wav'],
			image: ['image/png', 'image/x-citrix-png', 'image/x-png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/x-citrix-jpeg', 'image/webp', 'image/gif'],
			video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/ogg', 'video/avi', 'video/msvideo']
		};
	}

	fetchMetaTags(url, request)
	{
		return Promise.resolve().then(() => {
			const metatags = Object.assign({}, this.defaultMetatags);

			let isFile = true;
			this.metatags.forEach((meta) => {
				if (!url.pathname.match(meta.regex)) {return;}
				isFile = false;
				Object.assign(metatags, meta.tags);
			});

			if (!isFile) {return metatags;}

			return Promise.resolve().then(() => {
				const fileId = encodeURIComponent(url.pathname.slice(1).split('.').shift().replace(/\//, '.'));
				const fileUrl = `https://files.gg/api/files/${fileId}`;

				return fetch(fileUrl, request).then((response) => {
					return (response.status === 200) ? response.json() : Promise.reject(new Error('Unknown file'));
				}).then((data) => {
					const path = [data.folder, data.id].filter((v) => v).join('/');
					const cdnUrl = `https://cdn.files.gg/files/${[path, data.extension].filter((v) => v).join('.')}`;

					const filename = [data.filename, data.extension].filter((v) => v).join('.');

					metatags.mimetype = data.mimetype;

					metatags.description = Utils.Tools.formatBytes(data.size, 2);
					metatags.url = cdnUrl;
					metatags.title = filename;

					metatags['og:type'] = 'article';
					//og:image is a thumbnail

					const mtype = data.mimetype.split('/').shift();
					if (mtype === 'image' && this.mimetypes[mtype].includes(data.mimetype)) {
						metatags['og:image'] = cdnUrl;
						metatags['og:image:type'] = data.mimetype;
						metatags['og:image:width'] = data.width;
						metatags['og:image:height'] = data.height;
						metatags['og:image:alt'] = filename;

						metatags['twitter:card'] = 'summary_large_image';
						metatags['twitter:image'] = cdnUrl;
						metatags['twitter:image:alt'] = filename;
					} else if (mtype === 'video' && this.mimetypes[mtype].includes(data.mimetype)) {
						metatags['og:type'] = 'video.other';
						metatags['og:video'] = cdnUrl;
						metatags['og:video:type'] = data.mimetype;
						metatags['og:video:width'] = data.width;
						metatags['og:video:height'] = data.height;
						metatags['og:video:alt'] = filename;
						metatags['video:duration'] = data.duration;

						metatags['twitter:card'] = 'player';
						metatags['twitter:player'] = cdnUrl;
						metatags['twitter:player:width'] = data.width;
						metatags['twitter:player:height'] = data.height;
						//metatags['twitter:image'] = undefined; //thumbnail
						//metatags['twitter:image:alt'] = undefined; //thumbnail description
					} else if (mtype === 'audio' && this.mimetypes[mtype].includes(data.mimetype)) {
						metatags['og:type'] = 'music.song';
						metatags['og:audio'] = cdnUrl;
						metatags['og:audio:type'] = data.mimetype;
						metatags['music:duration'] = data.duration;

						metatags['twitter:card'] = 'player';
						metatags['twitter:player'] = cdnUrl;
						//metatags['twitter:image'] = undefined; //thumbnail
						//metatags['twitter:image:alt'] = undefined; //thumbnail description
					}

					//if (metatags['og:type'] === 'article') {
					//	metatags['article:published_time'] = undefined; ISO8601 Datetime based off the published
					//}
					
					const thumbnailUrl = `https://files.gg/api/mimetypes/icons/${data.mimetype}/${data.extension || '.'}`;
					return fetch(thumbnailUrl, request).then((response) => {
						if (response.status !== 200) {return;}
						return response.json();
					}).then((icon) => {
						if (!icon) {return;}

						metatags.favicon = icon.url;
						if (metatags['twitter:card'] === 'summary') {
							metatags['og:image'] = icon.url;
						}
					});
				});
			}).catch((e) => {
				metatags.description = e.message;
			}).then(() => {
				if (!metatags.description) {metatags.description = '404 /shrug';}

				metatags['og:description'] = metatags.description;
				metatags['og:url'] = metatags.url;
				metatags['og:title'] = metatags.title;
				metatags['twitter:description'] = metatags.description;
				metatags['twitter:title'] = metatags.title;
				return metatags;
			});
		});
	}

	metaToHtml(metatags)
	{
		return Promise.resolve().then(() => {
			const head = [];

			if (metatags.favicon) {
				head.push(m('link', {rel: 'icon', href: metatags.favicon}));
				delete metatags.favicon;
			} else {
				head.push(m('link', {rel: 'icon', href: '/assets/favicon.ico'}));
			}

			Object.keys(metatags).forEach((key) => {
				switch (key) {
					case 'charset': head.push(m('meta', {charset: metatags[key]})); break;
					case 'title': head.push(m(key, metatags[key])); break;
					default: head.push(m('meta', {name: key, content: metatags[key]}));
				}
			});

			return head;
		});
	}

	fetchBody(url, ua, request)
	{
		if (url.pathname.startsWith('/assets/')) {
			return fetch(request).then((response) => {
				return (200 <= response.status && response.status < 400) ? response : new Response('', response);
			});
		}

		if (request.method !== 'GET') {
			request = new Request(request, {method: 'GET'});
		}

		return this.fetchMetaTags(url, request).then((metatags) => {
			if (metatags.mimetype) {
				if (ua.match(/sharex/i)) {
					return Response.redirect(metatags.url, 302);
				} else if (ua.match(/bot/i) || this.spoofedUAs.includes(ua)) {
					if (false && ua.match(/discordbot/i) || this.spoofedUAs.includes(ua)) {
						const mtype = metatags.mimetype.split('/').shift();
						if ((mtype === 'video') && this.mimetypes[mtype].includes(metatags.mimetype)) {
							return Response.redirect(metatags.url, 302);
						}
						if (metatags['twitter:card'] === 'player') {
							metatags['twitter:card'] = 'summary';
							metatags['og:image'] = metatags.favicon;
						}
					} else if (ua.match(/telegrambot/i)) {
						return Response.redirect(metatags.url, 302);
					}
				} else {
					if (!request.headers.get('accept-language')) {
						return Response.redirect(metatags.url, 302);
					}

					const acceptedHeader = (request.headers.get('accept') || '').split(',').map((x) => x.split(';').shift().trim()).filter((v) => v);
					if (!acceptedHeader.length) {
						return Response.redirect(metatags.url, 302);
					}//is embed for a forums or something then if accepted header is not empty

					const mtype = metatags.mimetype.split('/').shift();
					if (mtype === 'audio' || mtype === 'image' || mtype === 'video') {
						let accepted;
						switch (mtype) {
							case 'audio': accepted = acceptedHeader.some((x) => x === 'audio/*'); break;
							case 'image': accepted = acceptedHeader.some((x) => x === 'image/*'); break;
							case 'video': accepted = acceptedHeader.some((x) => x === 'video/*'); break;
						}
						if (accepted) {
							return Response.redirect(metatags.url, 302);
						}
					}
				}
			}

			return metatags;
		});
	}

	_head(request)
	{
		const url = new URL(request.url);
		const ua = request.headers.get('user-agent') || '';

		return this.fetchBody(url, ua, request).then((metatags) => {
			return (metatags instanceof Response) ? metatags : new Response('', {headers: {'content-type': 'text/html'}});
		});
	}

	_get(request)
	{
		const url = new URL(request.url);
		const ua = request.headers.get('user-agent') || '';

		return this.fetchBody(url, ua, request).then((metatags) => {
			if (metatags instanceof Response) {return metatags;}

			const oembed = new URL(`https://files.gg/api/oembed`);
			oembed.searchParams.set('url', url.origin + url.pathname);
			oembed.searchParams.set('format', 'json');

			const head = [], body = [];

			head.push(m('script', {
				async: true,
				src: 'https://www.googletagmanager.com/gtag/js?id=UA-105575352-3'
			}));
			head.push(m('script', "window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', 'UA-105575352-3');"));

			head.push(m('link', {
				rel: 'alternate',
				type: 'application/json+oembed',
				href: oembed.href
			}));
			body.push(m('div', {id: 'app'}));

			return Promise.resolve().then(() => {
				if (this.spoofedUAs.includes(ua) || ua.match(/bot/i)) {return;}
				//do not fetch manifest.json for them

				return fetch('https://files.gg/assets/build/manifest.json', request).then((response) => {
					if (response.status !== 200) {return body.push(m('span', 'scripts couldn\'t load /shrug'));}

					return response.json().then((manifest) => {
						Object.keys(manifest).forEach((key) => {
							if (key.endsWith('.css')) {
								head.push(m('link', {
									rel: 'stylesheet',
									href: `/assets/build/${manifest[key]}`,
									type: 'text/css'
								}));
							} else if (key.endsWith('.js')) {
								body.push(m('script', {src: `/assets/build/${manifest[key]}`}));
							}
						});
					});
				});
			}).catch((e) => body.push(m('span', e.message))).then(() => {
				return this.metaToHtml(metatags).then(head.push.bind(head));
			}).then(() => {
				return [m.trust('<!DOCTYPE html>'), m('html', [head, body])];
			}).then(toHtml).then((html) => {
				return new Response(html, {headers: {'content-type': 'text/html'}});
			});
		});
	}
}

module.exports = SiteHandler;