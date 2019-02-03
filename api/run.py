import asyncio

from config.config import cfg
from server.server import Server


loop = asyncio.get_event_loop()

server = Server(loop=loop, **cfg)
loop.run_until_complete(server.initialize())
server.run()