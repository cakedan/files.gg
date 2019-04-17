import os

from flask import Flask, request
from google.cloud import storage

from werkzeug.contrib.fixers import ProxyFix
from werkzeug.exceptions import HTTPException

from utils.generators import Snowflake
from utils.mailgun import Mailgun
from utils.recaptcha import Recaptcha
from utils.responses import ApiError, ApiRedirect, ApiResponse

from models import db

from views.auth import auth
from views.files import files
from views.google import google
from views.me import me
from views.mimetypes import mimetypes
from views.users import users


app = Flask(__name__)
app.config['BUNDLE_ERRORS'] = True
app.response_class = ApiResponse
app.wsgi_app = ProxyFix(app.wsgi_app, num_proxies=1)

app.register_blueprint(auth)
app.register_blueprint(files)
app.register_blueprint(google)
app.register_blueprint(me)
app.register_blueprint(mimetypes)
app.register_blueprint(users)


app.secret_key = os.getenv('SECRET_KEY', 'extremely-secret')

app.config.rpc_key = os.getenv('RPC_KEY', 'very-rpc')
app.config.storage_bucket = os.getenv('STORAGE_BUCKET', 'filesgg')

app.config.worker_id = os.getpid()
#get compute engine id?
app.config.datacenter_id = 0

app.config.version = '0.0.1'

service_config = os.getenv('GOOGLE_APPLICATION_CREDENTIALS', '../gconfig.json')
app.gcs = storage.Client.from_service_account_json(service_config)

Mailgun.set_domain(os.getenv('MAILGUN_DOMAIN', 'mailgun.files.gg'))
Mailgun.set_token(os.getenv('MAILGUN_TOKEN', ''))

Recaptcha.set_secret(os.getenv('RECAPTCHA_SECRET', ''))

Snowflake.set_epoch(1550102400000)
Snowflake.set_worker_id(app.config.worker_id)
Snowflake.set_datacenter_id(app.config.datacenter_id)


@app.before_request
def before_request():
    db.connect(True)

@app.after_request
def after_request(response):
    db.close()
    if request.headers.get('origin'):
        response.headers.add('access-control-allow-credentials', 'true')
        response.headers.add('access-control-allow-headers', 'Authorization, Content-Type, X-Fingerprint')
        response.headers.add('access-control-allow-methods', 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, TRACE')
        response.headers.add('access-control-allow-origin', '*')
        response.headers.add('access-control-max-age', '300')
    response.headers.add('cache-control', 'no-cache, no-store')
    return response

import traceback

@app.errorhandler(Exception)
def on_error(error):
    if not isinstance(error, ApiError):
        print(error)
        print(traceback.print_exc())
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
