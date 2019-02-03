import aiohttp
import asyncio
import base64
import json
import sys

from urllib.parse import urlencode
from urllib.parse import quote as _uriquote

def urlquery(url, **parameters):
	return '{}:{}'.format(url, urlencode(parameters))

class Route:
	def __init__(self, method, url, **parameters):
		self.method = method
		if parameters:
			self.url = url.format(**{k: _uriquote(v) if isinstance(v, str) else v for k, v in parameters.items()})
		else:
			self.url = url

class HTTPClient:
	def __init__(self, **kwargs):
		self.loop = kwargs.pop('loop', asyncio.get_event_loop())

		self._session = aiohttp.ClientSession(loop=self.loop)

		user_agent = 'files.gg (https://files.gg {}) Python/{} aiohttp/{}'
		self.user_agent = user_agent.format('0.0.1', sys.version_info, aiohttp.__version__)
	
	def recreate(self):
		if self._session.closed:
			self._session = aiohttp.ClientSession(loop=self.loop)
	
	async def close(self):
		if not self._session.closed:
			await self._session.close()
	
	async def _request(self, method, url, *args, **kwargs):
		headers = kwargs.pop('headers', {})
		headers.update({'User-Agent': self.user_agent})

		if 'json' in kwargs:
			headers['content-type'] = 'application/json'
			kwargs['data'] = json.dumps(kwargs.pop('json'))
		
		kwargs['headers'] = headers

		return await self._session.request(method, url, **kwargs)
	
	def request(self, route, *args, **kwargs):
		return self._request(route.method, route.url, *args, **kwargs)
	
	def googleapi_resumable_upload(self, url, data):
		return self.request(Route('put', url), data=data)