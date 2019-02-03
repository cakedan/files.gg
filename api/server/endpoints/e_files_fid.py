from server.rest.endpoint import Endpoint
from server.rest.invalidusage import InvalidUsage
from server.rest.response import Response

class RestEndpoint(Endpoint):
	def __init__(self, server):
		super().__init__()
		self.server = server
		self.path = '/files/{fid}'
	
	async def get(self, request, fid):
		fid = fid.split('.')
		if len(fid) > 2:
			raise InvalidUsage(404, 'File Not Found')
		
		folder = None
		if len(fid) == 2:
			folder = fid.pop(0)
		fid = fid.pop(0)

		response = {}
		connection = await self.server.database.acquire()
		try:
			async with connection.cursor() as cur:
				if not await cur.execute('SELECT * FROM `files` WHERE `id` = %s AND `folder` {} %s'.format('=' if folder else 'is'), (fid, folder)):
					raise InvalidUsage(404, 'File Not Found')
				
				response = await cur.fetchone()
				url = '/'.join([v for v in [response['folder'], '.'.join([x for x in [response['id'], response['extension']] if x])] if v])
				response['urls'] = {
					'site': 'https://files.gg/{}'.format(url),
					'cdn': 'https://cdn.files.gg/files/{}'.format(url)
				}

				user_id = response.pop('user_id')
				if await cur.execute('SELECT * FROM `users` WHERE `id` = %s', (user_id,)):
					user = await cur.fetchone()
					response['user'] = {k: user[k] for k in ['id']}
				else:
					response['user'] = None
		finally:
			self.server.database.release(connection)

		return Response(200, response)