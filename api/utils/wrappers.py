from functools import wraps

from flask import abort, request

def authenticate(user=True, bot=False):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            authentication = request.headers.get('authorization', None)
            if authentication is None:
                abort(401)
            return func(*args, **kwargs)
        return wrapper
    return decorator


def ratelimit(amount, time):
  def decorator(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
      # ratelimit by ip/token?
      return func(*args, **kwargs)
  return decorator
