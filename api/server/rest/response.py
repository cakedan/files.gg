import decimal
import json

from aiohttp.web import Response as AioHTTPResponse

class Response(AioHTTPResponse):
	def __init__(self, status, body=None, **kwargs):
		kwargs['status'] = status
		kwargs['content_type'] = kwargs.get('content_type', 'application/json').lower()

		if body is not None:
			if kwargs['content_type'].startswith('application/json') and status != 204:
				body = self.encode(body)
			kwargs['body'] = body
		
		super().__init__(**kwargs)
	
	def filter(self, data):
		if isinstance(data, int) and data > 9007199254740991:
			data = str(data)
		
		if isinstance(data, dict):
			for k in data.keys():
				data[k] = self.filter(data[k])
		if isinstance(data, (list, tuple)):
			for i in range(len(data)):
				data[i] = self.filter(data[i])
		
		if isinstance(data, decimal.Decimal):
			data = float(data)

		return data

	def encode(self, data):
		return json.dumps(self.filter(data)).encode('utf-8')