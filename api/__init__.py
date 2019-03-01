from flask import Blueprint
from flask_restful import Api

from api.resources.auth import AuthLoginR, AuthLogoutR, AuthRegisterR
from api.resources.files import FilesR, FileR
from api.resources.google import GoogleHealthCheckR
from api.resources.mimetypes import MimetypesR
from api.resources.rpc import RpcR

api_bp = Blueprint('api_bp', __name__)
api = Api(api_bp, catch_all_404s=True)

api.add_resource(AuthLoginR, '/auth/login')
api.add_resource(AuthLogoutR, '/auth/logout')
api.add_resource(AuthRegisterR, '/auth/register')
api.add_resource(FilesR, '/files')
api.add_resource(FileR, '/files/<file_id>')
api.add_resource(GoogleHealthCheckR, '/google/health-check')
api.add_resource(MimetypesR, '/mimetypes')
api.add_resource(RpcR, '/_rpc')
