import json

from server.rest.response import Response
from urllib.parse import urlencode

class Redirect(Response):
	def __init__(self, status, location, params={}, **kwargs):
		if not (300 < status and status < 400):
			raise ValueError('Invalid Redirect Status')

		if params:
			location = '{}?{}'.format(location, urlencode(params))
		
		super().__init__(status, **kwargs)
		self.headers['Location'] = str(location)
		self.location = location