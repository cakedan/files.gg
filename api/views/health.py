import asyncio

from sanic import Blueprint

import db
from utils.responses import ApiResponse
from utils.wrappers import route

health = Blueprint('health')

HEALTH_TIMEOUT = 5.0


async def check_health():
    checks = {}
    try:
        async def ping():
            async with db.connection(timeout=HEALTH_TIMEOUT) as conn:
                await conn.execute('SELECT 1')
        await asyncio.wait_for(ping(), HEALTH_TIMEOUT)
        checks['database'] = 'ok'
    except Exception as error:
        checks['database'] = 'error: {}'.format(type(error).__name__)
    healthy = all(value == 'ok' for value in checks.values())
    return ApiResponse({'status': 'ok' if healthy else 'error', 'checks': checks}, status=200 if healthy else 503)


@route(health, '/health', ['GET'])
async def health_check(request):
    return await check_health()
