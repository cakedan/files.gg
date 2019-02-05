import os

from flask import Flask
from werkzeug.exceptions import HTTPException

from api.library.generators import Snowflake, Token
from api.library.responses import APIError, APIResponse

from api.models import db

from api.views.auth import auth
from api.views.files import files
from api.views.mimetypes import mimetypes

app = Flask(__name__)
app.response_class = APIResponse

app.register_blueprint(auth)
app.register_blueprint(files)
app.register_blueprint(mimetypes)

app.secret_key = os.getenv('SECRET_KEY', 'some secret here')
app.secret_salt = os.getenv('SECRET_SALT', 'salty keyword')

app.config.rpc_key = os.getenv('RPC_KEY', 'rpc test')

# TODO: get worker # from WSGI server
app.config.worker_id = 0
app.config.datacenter_id = 0

app.config.version = '0.0.1'

Snowflake.set_epoch(0)
Snowflake.set_worker_id(app.config.worker_id)
Snowflake.set_datacenter_id(app.config.datacenter_id)

Token.set_epoch(0)
Token.set_secret(app.secret_key)
Token.set_salt(app.secret_salt)

@app.before_request
def before_request():
    db.connect(True)


@app.after_request
def after_request(response):
    db.close()
    return response


@app.errorhandler(Exception)
def on_error(error):
    if not isinstance(error, APIError):
        if isinstance(error, HTTPException):
            error = APIError(status=error.code)
        else:
            error = APIError(str(error), 500)
    return error
