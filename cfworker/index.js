require('mithril/test-utils/browserMock')(global);

const toHtml = require('mithril-node-render');
const m = require('mithril');

addEventListener('fetch', (event) => {
	const e = new Event(event);
	event.respondWith(e.handle());
});

class Event
{
	constructor(event)
	{
		this.event = event;
		this.request = event.request;
		this.url = new URL(this.request.url);
	}

	jsonResponse(data, status)
	{
		return new Response(JSON.stringify(data), {
			headers: {'content-type': 'application/json'},
			status
		});
	}

	continue() {return fetch(this.request);}

	cdn()
	{
		return fetch(this.request).then((response) => {
			console.log(response);
			if (response.status === 200) {
				return response;
			} else {
				const error = {code: 0, message: response.statusText};
				switch (response.status) {
					case 403: {
						error.message = 'Not Found';
						return this.jsonResponse(error, 404);
					}; break;
					default: {
						return this.jsonResponse(error, response.status);
					};
				}
			}
		});
	}

	html()
	{
		return fetch('https://files.gg/api/assets').then((response) => {
			const html = {head: [], body: []};
			switch (response.status) {
				case 200: {
	
				}; break;
				default: {
					html.body.push(m('span', 'scripts couldnt load, srry'));
				};
			}
			return html;
		}, (e) => {
			return {head: [], body: [m('span', e.message)]};
		}).then(({head, body}) => {
			//put meta data in based on the image uploaded
			head = head.concat([
				m('title', 'File Uploader'),
				m('meta', {charset: 'UTF-8'}),
				m('meta', {
					property: 'description',
					content: 'Upload some files'
				})
			]);
			return {head, body};
		}).then(({head, body}) => {
			return [
				m.trust('<!DOCTYPE html>'),
				m('html', [
					m('head', [
						m('link', {rel: 'icon', href: '/assets/favicon/favicon.ico'})
					].concat(head)),
					m('body', [
						m('div', {id: 'app'})
					].concat(body))
				])
			];
		}).then(toHtml).then((html) => {
			return new Response(html, {
				headers: {'content-type': 'text/html'}
			});
		});
	}

	handle()
	{
		return Promise.resolve().then(() => {
			switch (this.url.host) {
				case 'www.files.gg':
				case 'files.gg': {
					return this.html();
				}; break;
				case 'cdn.files.gg': {
					return this.cdn();
				}; break;
				default: {
					return this.continue();
				};
			}
		});
	}
}