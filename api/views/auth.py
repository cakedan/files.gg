from flask import Blueprint, request

auth = Blueprint('auth', __name__, url_prefix='/auth')


@auth.route('/login', methods=['POST'])
def auth_login():
    return 'login'


@auth.route('/logout', methods=['POST'])
def auth_logout():
    return 'logout'


@auth.route('/register', methods=['POST'])
def auth_register():
    return 'register'
