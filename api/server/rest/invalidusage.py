import server.rest.errors as errors

from server.rest.response import Response

class InvalidUsage(Response, Exception):
	def __init__(self, status=500, message=None, code=None, **kwargs):
		self.code = status if code is None else code

		if message:
			self.message = message
		else:
			self.message = self.get_message(status) if code is None else self.get_error(code)

		Response.__init__(self, status, self.to_dict(), **kwargs)
		Exception.__init__(self, self.message)

	def get_message(self, code):
		return errors.http.get(code) or errors.http.get(500)
	
	def get_error(self, code):
		return errors.codes.get(code) or errors.http.get(500)
	
	def to_dict(self):
		return {'code': self.code, 'message': self.message}