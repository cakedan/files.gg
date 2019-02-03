class JSONResponse extends Response
{
	constructor(data, code, options)
	{
		options = Object.assign({}, options);
		options.status = code;
		options.headers = Object.assign({}, options.headers, {'content-type': 'application/json'});
		super(JSON.stringify(data), options);
	}
}

module.exports = JSONResponse;