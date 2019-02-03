import inspect

from aiohttp.web import Request

from server.rest.response import Response
from server.rest.invalidusage import InvalidUsage

DEFAULT_METHODS = ('get', 'post', 'put', 'patch', 'delete', 'options', 'head')

class Endpoint:
	def __init__(self):
		self.methods = {}
		
		for method_name in DEFAULT_METHODS:
			method = getattr(self, method_name.lower(), None)
			if method:
				self.register_method(method_name, method)
		
		self.path = None
		self.types = {}
	
	def validate(self, data, typeof=dict, required=[]):
		if not isinstance(data, typeof):
			raise InvalidUsage(400)
		for key in required:
			if data.get(key) is None:
				raise InvalidUsage(400)
		return data
	
	def register_method(self, method_name, method):
		self.methods[method_name] = method
	
	async def options(self, request):
		return Response(204)
	
	async def dispatch(self, request: Request):
		method = self.methods.get(request.method.lower())
		if not method:
			raise InvalidUsage(405)
		
		args_wanted = list(inspect.signature(method).parameters.keys())
		args_available = request.match_info.copy()
		args_available.update({'request': request})

		args_unsatisfied = set(args_wanted) - set(args_available.keys())
		if args_unsatisfied:
			raise InvalidUsage(400)
		
		for arg, arg_type in self.types.items():
			if arg not in args_wanted:
				continue

			if arg_type == 'snowflake':
				if args_available[arg] in ['@me', '@all']:
					continue
				try:
					args_available[arg] = int(args_available[arg])
				except:
					raise InvalidUsage(400, '{} is not a snowflake'.format(arg))

		return await method(**{arg: args_available[arg] for arg in args_wanted})