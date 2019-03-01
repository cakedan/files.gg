from flask import Blueprint

google = Blueprint('google', __name__, url_prefix='/google')

@google.route('/health-check', methods=['GET'])
def google_healthcheck():
    return 'ok'
