from flask import Response
from urllib.parse import urlencode
import json

import api.library.errors as errors


class APIResponse(Response):
    default_status = 200
    default_mimetype = 'application/json'

    def __init__(self, obj=None, status=None, **kwargs):
        if obj is None:
            kwargs['response'] = ''
        else:
            if hasattr(obj, 'to_dict'):
                obj = obj.to_dict()

            kwargs['response'] = json.dumps(obj)

        if status is not None:
            kwargs['status'] = status

        Response.__init__(self, **kwargs)


class APIError(Exception, APIResponse):
    default_status = 400

    def __init__(self, message=None, status=None, *args, **kwargs):
        if status is None:
            status = self.default_status

        code = kwargs.get('code', 0)

        if message is None:
            message = errors.codes.get(code)

        if message is None:
            message = errors.status_codes.get(status, 'Unknown Error')

        data = {
            'code': code,
            'message': message,
            'status': status,
        }

        Exception.__init__(self, message)
        APIResponse.__init__(self, data, status, *args, **kwargs)


class APIRedirect(APIResponse):
    default_status = 302

    def __init__(self, url, query=None, *args, **kwargs):
        APIResponse.__init__(self, None, *args, **kwargs)

        if not (300 < self.status_code and self.status_code < 400):
            raise ValueError('Invalid Redirect Code')

        if query:
            if '?' in url:
                url += '&' + urlencode(query)
            else:
                url += '?' + urlencode(query)

        self.headers.add('location', url)
