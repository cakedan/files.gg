import asyncio
import base64
import logging

from aiohttp import web

from server.rest.invalidusage import InvalidUsage

class Router:
	def __init__(self, **kwargs):
		self.loop = kwargs.pop('loop', asyncio.get_event_loop())

		self.app = web.Application(loop=self.loop, middlewares=[self.middleware], **kwargs)
		self.endpoints = {}
	
	def add(self, path, endpoint):
		if path in self.endpoints:
			raise Exception('{} is already taken'.format(path))
		self.endpoints[path] = endpoint
		self.app.router.add_route('*', path, endpoint.dispatch)
	
	async def middleware(self, app, handler):
		async def middleware_handler(request):
			try:
				return await handler(request)
			except web.HTTPException as e:
				return InvalidUsage(e.status)
			except InvalidUsage as e:
				return e
			except Exception as e:
				return InvalidUsage(500, str(e))
		return middleware_handler
	
	def on_shutdown(self, func):
		self.app.on_shutdown.append(func)

	def run(self, host='127.0.0.1', port=8000, **kwargs):
		if kwargs.pop('cloudflare'):
			logger_format = '%{X-Real-IP}i - %t %Tfs %s "%r"'
		else:
			logger_format = '%a - %t %Tfs %s "%r"'
		logging.basicConfig(level=logging.DEBUG)
		kwargs.update({
			'host': host,
			'port': port,
			'access_log_format': logger_format
		})
		web.run_app(self.app, **kwargs)