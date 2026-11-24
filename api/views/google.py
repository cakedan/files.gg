from sanic import Blueprint

from utils.wrappers import route
from views.health import check_health

google = Blueprint('google', url_prefix='/google')


# Alias of /health, kept for the existing load balancer configuration.
@route(google, '/health-check', ['GET'])
async def google_healthcheck(request):
    return await check_health()
