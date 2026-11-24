from functools import wraps

from sanic_ext import openapi

import db
import utils.helpers as helpers
import utils.params as params

JSON = 'application/json'


def authenticate(user=True, bot=False):
    def decorator(func):
        @wraps(func)
        async def wrapper(request, *args, **kwargs):
            async with db.connection() as conn:
                kwargs['user'] = await helpers.get_user(
                    conn,
                    request.headers.get('authorization'),
                    allow_user=user,
                    allow_bot=bot,
                )
            return await func(request, *args, **kwargs)
        wrapper.__authenticated__ = True
        return wrapper
    return decorator


def ratelimit(amount, time):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            # ratelimit by ip/token?
            return await func(*args, **kwargs)
        return wrapper
    return decorator


def parse_args(model, form=True):
    """Validate the request against a utils.params.Args model and pass it as
    the first argument after `request`. Route params the model reads
    (location='view_args') are consumed from kwargs, as before."""
    if not (isinstance(model, type) and issubclass(model, params.Args)):
        raise Exception('Parser must be a utils.params.Args model')
    consumed = {name for _, name, arg in model.arguments() if 'view_args' in arg.location}

    def decorator(func):
        @wraps(func)
        async def wrapper(request, *args, **kwargs):
            parsed = params.parse(request, model, view_args=kwargs, form=form)
            for key in list(kwargs):
                if key in consumed:
                    kwargs.pop(key)
            return await func(request, parsed, *args, **kwargs)
        wrapper.__params_model__ = model
        return wrapper
    return decorator


def route(bp, uri, methods, **kwargs):
    """Register a handler like Flask did: GET also answers HEAD, and every path
    answers OPTIONS (handled by the app's preflight middleware, 204 + Allow)."""
    methods = [m.upper() for m in methods]
    if 'GET' in methods and 'HEAD' not in methods:
        methods.append('HEAD')

    key = (bp.name, uri)
    allowed = ALLOWED_METHODS.get(key)
    if allowed is None:
        allowed = ALLOWED_METHODS[key] = {'OPTIONS'}
        methods.append('OPTIONS')
    allowed.update(methods)

    def decorator(handler):
        handler = _document(handler)
        # unquote: match on the decoded path, as Werkzeug did ('/users/@me',
        # '/files/a%20b' -> vanity 'a b')
        bp.route(uri, methods=methods, ignore_body=False, unquote=True, ctx_allow_key=key, **kwargs)(handler)
        return handler
    return decorator


# (blueprint name, uri) -> every method registered on that path
ALLOWED_METHODS = {}


def allowed_methods(route):
    return ALLOWED_METHODS.get(getattr(route.ctx, 'allow_key', None)) or {'OPTIONS'}


def _document(handler):
    model = getattr(handler, '__params_model__', None)
    if model is not None:
        parameters, body = params.openapi_parameters(model)
        for name, location, required, schema in parameters:
            kind = int if schema.get('type') == 'integer' else str
            handler = openapi.parameter(name, kind, location=location, required=required)(handler)
        if body is not None:
            handler = openapi.body({JSON: body, 'application/x-www-form-urlencoded': body})(handler)
    if getattr(handler, '__authenticated__', False):
        handler = openapi.secured('token')(handler)
    return handler
