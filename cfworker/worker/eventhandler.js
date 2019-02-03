const JSONResponse = require('./jsonresponse');

const Handlers = require('./handlers');

class EventHandler
{
	constructor(options)
	{
		options = options || {};

		this.bucket = options.bucket;

		this.handlers = [
			{hostnames: ['www.files.gg', 'files.gg'], handler: new Handlers.Site(this)},
			{hostnames: ['cdn.files.gg'], handler: new Handlers.CDN(this)}
		];
	}

	fetchResponse(request)
	{
		return Promise.resolve().then(() => {
			const url = new URL(request.url);
			const handler = (this.handlers.find((handler) => handler.hostnames.includes(url.hostname)) || {}).handler;

			return (handler) ? handler.handle(request) : new JSONResponse({code: 0, message: '???'}, 400);
		}).catch((e) => new JSONResponse({code: 0, message: e.message}, 500));
	}

	onfetch(event) {event.respondWith(this.fetchResponse(event.request));} //do not use respondWith if you want to let the request go through
}

module.exports = EventHandler;