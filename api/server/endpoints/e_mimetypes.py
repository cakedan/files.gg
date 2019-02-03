from server.rest.endpoint import Endpoint
from server.rest.invalidusage import InvalidUsage
from server.rest.response import Response

class RestEndpoint(Endpoint):
	def __init__(self, server):
		super().__init__()
		self.server = server
		self.path = '/mimetypes'
	
	async def get(self, request):
		response = []
		connection = await self.server.database.acquire()
		try:
			async with connection.cursor() as cur:
				await cur.execute(' '.join([
					'SELECT',
					', '.join([
						'`mimetypes`.`mime`',
						'`mimetypes`.`required_flags`',
						'`mimetypes_extensions`.`extension`'
					]),
					'FROM `mimetypes` INNER JOIN `mimetypes_extensions` ON `mimetypes_extensions`.`mime` = `mimetypes`.`mime`'
				]))
				response = await cur.fetchall()
		finally:
			self.server.database.release(connection)
		
		for mime in response:
			if not mime.get('extension'):
				mime['extension'] = None

		return Response(200, response)
	
	async def post(self, request):
		#return Response(204)
		data = self.validate(await request.json(), required=['mime', 'required_flags'])
		data['mime'] = data['mime'].lower()
		data['extension'] = data['extension'].lower() if data.get('extension', None) else None

		connection = await self.server.database.acquire()
		try:
			async with connection.cursor() as cur:
				await cur.execute('INSERT INTO `mimetypes` (`mime`, `required_flags`) VALUES (%s, %s) ON DUPLICATE KEY UPDATE `mime` = `mime`', (data['mime'], data['required_flags']))
				if data['extension']:
					await cur.execute('INSERT INTO `mimetypes_extensions` (`mime`, `extension`) VALUES (%s, %s) ON DUPLICATE KEY UPDATE `mime` = `mime`', (data['mime'], data['extension']))
		finally:
			self.server.database.release(connection)

		return Response(204)