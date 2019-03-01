import os

from flask import Flask
from google.cloud import storage
from werkzeug.exceptions import HTTPException

from utils.generators import Snowflake, Token
from utils.responses import ApiError, ApiRedirect, ApiResponse

from views.auth import auth
from views.files import files
from views.google import google
from views.me import me
from views.mimetypes import mimetypes


app = Flask(__name__)
app.config.BUNDLE_ERRORS = True
app.response_class = ApiResponse

app.register_blueprint(auth)
app.register_blueprint(files)
app.register_blueprint(google)
app.register_blueprint(me)
app.register_blueprint(mimetypes)


app.secret_key = os.getenv('SECRET_KEY', 'extremely-secret')
app.secret_salt = os.getenv('SECRET_SALT', 'extremely-salty')

app.config.rpc_key = os.getenv('RPC_KEY', 'very-rpc')
app.config.storage_bucket = os.getenv('STORAGE_BUCKET', 'filesgg')

app.config.worker_id = os.getpid()
#get compute engine id
app.config.datacenter_id = 0

app.config.version = '0.0.1'

service_config = os.getenv('GOOGLE_APPLICATION_CREDENTIALS', '../gconfig.json')
app.gcs = storage.Client.from_service_account_json(service_config)

Snowflake.set_epoch(1550102400000)
Snowflake.set_worker_id(app.config.worker_id)
Snowflake.set_datacenter_id(app.config.datacenter_id)

Token.set_epoch(0)
Token.set_secret(app.secret_key)
Token.set_salt(app.secret_salt)


from models import db

@app.before_request
def before_request():
    db.connect(True)

@app.after_request
def after_request(response):
    db.close()
    return response

@app.errorhandler(Exception)
def on_error(error):
    if not isinstance(error, ApiError):
        if isinstance(error, HTTPException):
            if 300 <= error.code and error.code < 400:
                return ApiRedirect(error.headers['location'], code=error.code)

            metadata = getattr(error, 'data', None)
            if metadata is not None:
                if 'message' in metadata:
                    metadata['errors'] = metadata.pop('message')
            error = ApiError(status=error.code, metadata=metadata)
        else:
            error = ApiError(str(error), 500)
    return error.response


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8080, debug=True)
