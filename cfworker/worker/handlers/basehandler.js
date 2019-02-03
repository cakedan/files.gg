const JSONResponse = require('../jsonresponse');

class BaseHandler
{
	constructor(eventHandler)
	{
		this.eventHandler = eventHandler;
	}

	handle(request)
	{
		const method = this[`_${request.method.toLowerCase()}`];
		return (method) ? method.call(this, request) : new JSONResponse({code: 0, message: 'Method not allowed'}, 405);
	}
}

module.exports = BaseHandler;