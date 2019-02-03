import asyncio

from aiomysql import create_pool, DictCursor

class Database:
	def __init__(self, **kwargs):
		self.loop = kwargs.pop('loop', asyncio.get_event_loop())

		self.config = kwargs.pop('config', {})
		if not self.config:
			raise Exception('Database config is required.')
		
		self.pool = None
	
	async def close(self):
		if self.pool:
			self.pool.terminate()
			await self.pool.wait_closed()
	
	async def acquire(self):
		if not self.pool:
			await self.run()
		return await self.pool.acquire()
	
	def release(self, connection):
		if self.pool:
			self.pool.release(connection)

	async def run(self):
		self.config.update({
			'loop': self.loop,
			'cursorclass': DictCursor,
			'autocommit': True
		})
		self.pool = await create_pool(**self.config)