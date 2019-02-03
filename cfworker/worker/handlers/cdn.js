const BaseHandler = require('./basehandler');
const JSONResponse = require('../jsonresponse');

class CDNHandler extends BaseHandler
{
	fetchStorage(request)
	{
		const url = new URL(request.url);
		return fetch(`https://storage.googleapis.com/${this.eventHandler.bucket}/${url.pathname}`, request).then((resp) => {
			const response = new Response(resp.body, resp);
			response.headers.set('access-control-allow-origin', '*');
			return response;
		});
	}

	_head(request) {return this.fetchStorage(request);}
	_options(request) {return this.fetchStorage(request);}

	_get(request)
	{
		return this.fetchStorage(request).then((response) => {
			if (response.status < 200 || 300 <= response.status) {
				return new JSONResponse({code: 0, message: response.statusText}, response.status);
			} else {
				return response;
			}
		});
	}
}

module.exports = CDNHandler;