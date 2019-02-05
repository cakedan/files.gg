from flask import Blueprint, request

import api.library.helpers as helpers
from api.library.responses import APIResponse


auth = Blueprint('auth', __name__, url_prefix='/auth')


@auth.route('/register', methods=['POST'])
def auth_register():
    return APIResponse('register')


@auth.route('/login', methods=['POST'])
def auth_login():
    return APIResponse('login')


@auth.route('/logout', methods=['POST'])
def auth_logout():
    return APIResponse('logout')
