"""Request arguments as pydantic models, with flask_restful-compatible lookup
and error messages.

A model declares one field per argument:

    class LoginArgs(Args):
        email: Annotated[str, Arg(type=parameters.email)]
        fingerprint: Annotated[Optional[int], Arg('x-fingerprint', location='headers',
                                                  type=parameters.fingerprint)] = None

`Arg` says where the value comes from (`name`, `location`) and how it is
converted (`type`, `choices`, `help`, whitespace trimming). The adapter in
`parse()` collects raw values the way flask_restful's reqparse did (JSON body
first, then the query string, then the form; headers; route params) and lets
pydantic validate them. Validation errors become the old 400 response:
`{"errors": {name: message}, "code": 0, "message": "Bad Request", "status": 400}`,
with the same messages ("Missing required parameter in ...", the converter's
own ValueError text, or the argument's `help`).
"""

import json

from pydantic import BaseModel, ConfigDict, ValidationError
from pydantic_core import core_schema

from utils.responses import ApiError

DEFAULT_LOCATION = ('json', 'values')

_FRIENDLY_LOCATIONS = {
    'json': 'the JSON body',
    'form': 'the post body',
    'args': 'the query string',
    'values': 'the post body or the query string',
    'headers': 'the HTTP headers',
    'cookies': 'the request\'s cookies',
    'files': 'an uploaded file',
    'view_args': 'view_args',
}


class Arg:
    """Field metadata: request source + converter (a pydantic plain validator)."""

    def __init__(self, name=None, location=DEFAULT_LOCATION, type=str, choices=None, help=None, trim=True,
                 aliases=()):
        self.name = name
        # other request names tried first, in order; errors are still reported
        # under `name` (e.g. turnstile_token for the legacy captcha field)
        self.aliases = tuple(aliases)
        self.location = (location,) if isinstance(location, str) else tuple(location)
        self.type = type
        self.choices = choices
        self.help = help
        self.trim = trim

    def convert(self, value):
        if value is None:
            return None
        if self.trim and isinstance(value, str):
            value = value.strip()
        try:
            value = self.type(value)
        except ValueError:
            raise
        except Exception as error:  # reqparse reported any converter failure
            raise ValueError(str(error))
        if self.choices is not None and value not in self.choices:
            raise ValueError('{} is not a valid choice'.format(value))
        return value

    def __get_pydantic_core_schema__(self, source_type, handler):
        return core_schema.no_info_plain_validator_function(
            self.convert, json_schema_input_schema=handler(source_type))

    @property
    def friendly_location(self):
        return ' or '.join(_FRIENDLY_LOCATIONS.get(x, x) for x in self.location)


class Args(BaseModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    @classmethod
    def arguments(cls):
        """[(field name, request name, Arg)] in declaration order."""
        out = []
        for fname, info in cls.model_fields.items():
            arg = next((m for m in info.metadata if isinstance(m, Arg)), None) or Arg()
            out.append((fname, arg.name or fname, arg))
        return out


# --- request sources -----------------------------------------------------------

def _is_json(request):
    mimetype = (request.content_type or '').split(';', 1)[0].strip().lower()
    return mimetype == 'application/json' or (mimetype.startswith('application/') and mimetype.endswith('+json'))


def request_json(request):
    """Like Flask's `request.get_json(silent=True)`: only for JSON content
    types, and None if the body does not parse."""
    if not _is_json(request) or not request.body:
        return None
    try:
        return json.loads(request.body)
    except ValueError:
        return None


def _first(multidict, name):
    values = multidict.getlist(name) if hasattr(multidict, 'getlist') else None
    if values:
        return True, values[0]
    return False, None


class Sources:
    def __init__(self, request, view_args=None, form=True):
        """`form`: True reads Sanic's parsed form (and a JSON body), False
        neither, or a mapping with getlist() (a form parsed elsewhere)."""
        self.request = request
        self.view_args = view_args or {}
        self.form_override = None if isinstance(form, bool) else form
        self.form_enabled = bool(form) if isinstance(form, bool) else True
        self._json = request_json(request) if form is True else None
        self._args = request.get_args(keep_blank_values=True)

    def lookup(self, location, name):
        request = self.request
        if location == 'json':
            data = self._json
            if isinstance(data, dict) and name in data:
                return True, data[name]
            return False, None
        if location == 'args':
            return _first(self._args, name)
        if location == 'form':
            return _first(self.form, name)
        if location == 'values':
            # Werkzeug's request.values: query string, then the form (not for GET)
            found, value = _first(self._args, name)
            if found or request.method == 'GET':
                return found, value
            return _first(self.form, name)
        if location == 'headers':
            values = request.headers.getall(name, [])
            return (True, values[0]) if values else (False, None)
        if location == 'view_args':
            if name in self.view_args:
                return True, self.view_args[name]
            return False, None
        if location == 'files':
            return _first(request.files or {}, name)
        if location == 'cookies':
            return (name in request.cookies), request.cookies.get(name)
        raise ValueError('unknown location {!r}'.format(location))

    @property
    def form(self):
        if self.form_override is not None:
            return self.form_override
        if not self.form_enabled:
            return {}
        return self.request.form or {}


def parse(request, model, view_args=None, form=True):
    raw = {}
    sources = Sources(request, view_args, form=form)
    arguments = model.arguments()
    for fname, name, arg in arguments:
        for candidate in arg.aliases + (name,):
            for location in arg.location:
                found, value = sources.lookup(location, candidate)
                if found:
                    raw[fname] = value
                    break
            if fname in raw:
                break
    try:
        return model.model_validate(raw)
    except ValidationError as error:
        by_field = {fname: (name, arg) for fname, name, arg in arguments}
        errors = {}
        for item in error.errors(include_url=False):
            fname = item['loc'][0] if item['loc'] else None
            name, arg = by_field.get(fname, (str(fname), Arg()))
            if item['type'] == 'missing':
                message = 'Missing required parameter in {}'.format(arg.friendly_location)
            elif item['type'] == 'value_error' and 'error' in item.get('ctx', {}):
                message = str(item['ctx']['error'])
            else:
                message = item['msg']
            if arg.help:
                message = arg.help.format(error_msg=message)
            errors[name] = message
        raise ApiError(status=400, metadata={'errors': errors})


# --- OpenAPI ---------------------------------------------------------------------

_OAS_LOCATIONS = {'args': 'query', 'headers': 'header', 'view_args': 'path', 'values': 'query'}


def openapi_parameters(model):
    """(name, location, required, schema) for sanic-ext's openapi.parameter, plus
    a JSON-schema for the body fields (JSON or form)."""
    params = []
    body = {'type': 'object', 'properties': {}, 'required': []}
    schema = model.model_json_schema()
    properties = schema.get('properties', {})
    for fname, name, arg in model.arguments():
        info = model.model_fields[fname]
        prop = dict(properties.get(fname, {}))
        prop.pop('title', None)
        if arg.help:
            prop['description'] = arg.help
        if 'json' in arg.location or 'form' in arg.location:
            body['properties'][name] = prop or {}
            if info.is_required():
                body['required'].append(name)
        for location in arg.location:
            if location in _OAS_LOCATIONS:
                params.append((name, _OAS_LOCATIONS[location], info.is_required(), prop or {}))
                break
    if not body['required']:
        body.pop('required')
    return params, (body if body['properties'] else None)

