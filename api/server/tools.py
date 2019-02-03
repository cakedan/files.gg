import time

from server.rest.invalidusage import InvalidUsage
from server.utils import Permissions

class Tools:
	def __init__(self, server, **kwargs):
		self.server = server

		self.loop = self.server.loop

		self.database = self.server.database
		self.httpclient = self.server.httpclient

		self.snowflake = self.server.snowflake
		self.token = self.server.token
	
	async def authorize(self, token, permissions=[], bot_permissions=[], userandbot=True, bots=None):
		try:
			token = self.token.split(token)
		except Exception as e:
			raise InvalidUsage(401)
		
		response = {'bot': False, 'token': token}

		connection = await self.database.acquire()
		try:
			async with connection.cursor() as cur:
				if token['type'] == 'user':
					if bots is not None and bots:
						raise InvalidUsage(401, 'Only bots can use this endpoint.')
					await cur.execute('SELECT * FROM `users` WHERE `id` = %s', (token['user_id'],))
					user = await cur.fetchone()
					if not user:
						raise InvalidUsage(401)
					await cur.execute('SELECT `id`, `secret` FROM `token_sessions` WHERE `id` = %s', (token['snowflake'],))
					session = await cur.fetchone()
					if not session or not self.token.compare(token['hmac'], session['id'], session['secret']):
						raise InvalidUsage(401)

					await cur.execute('UPDATE `token_sessions` SET `last_used` = %s WHERE `id` = %s', (time.time(), session['id']))
					response.update(user)
				elif token['type'] == 'bot':
					if bots is not None and not bots:
						raise InvalidUsage(401, 'Bots cannot use this endpoint.')

					await cur.execute('SELECT * FROM `bots` WHERE `id` = %s', (token['bot_id'],))
					bot = await cur.fetchone()
					if not bot or not self.token.compare(token['hmac'], bot['snowflake'], bot['secret']):
						raise InvalidUsage(401)
	
					response.update({
						'bot': True,
						'id': bot['id'],
						'name': bot['name'],
						'permissions': bot['permissions']
					})
					if token.get('user_id'):
						await cur.execute('SELECT * FROM `users` WHERE `id` = %s', (token['user_id'],))
						user = await cur.fetchone()
						if not user:
							raise InvalidUsage(401, 'User not found')
						response.update({'user': user})
		finally:
			self.database.release(connection)

		if not response:
			raise InvalidUsage(401)
		
		if bot_permissions:
			if response['bot'] and not Permissions.check_any(response['permissions'], bot_permissions):
				raise InvalidUsage(401)
		
		if permissions and not (response['bot'] and not userandbot):
			if response['bot']:
				if not response.get('user'):
					raise InvalidUsage(401, 'Bots cannot use this endpoint')
				check = Permissions.check_any(response['user']['permissions'], permissions)
			else:
				check = Permissions.check_any(response['permissions'], permissions)

			if not check:
				raise InvalidUsage(401)
	
		return response