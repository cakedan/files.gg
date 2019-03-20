from functools import wraps

from flask import request
from flask_restful import reqparse

from models import User

import utils.helpers as helpers


def authenticate(user=True, bot=False):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            kwargs['user'] = helpers.get_user(
                request.headers.get('authorization'),
                allow_user=user,
                allow_bot=bot,
            )
            return func(*args, **kwargs)
        return wrapper
    return decorator


def ratelimit(amount, time):
  def decorator(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
      # ratelimit by ip/token?
      return func(*args, **kwargs)
    return wrapper
  return decorator


def parse_args(parser):
    if not isinstance(parser, reqparse.RequestParser):
        raise Exception('Parser must be of type RequestParser')
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            parsed_args = parser.parse_args()
            for key in kwargs.copy():
                if key in parsed_args:
                    kwargs.pop(key)
            return func(parsed_args, *args, **kwargs)
        return wrapper
    return decorator
