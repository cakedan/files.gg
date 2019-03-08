import json

from urllib.parse import urlencode

from flask import Response
from werkzeug.http import HTTP_STATUS_CODES


class ApiResponse(Response):
    default_status = 200
    default_mimetype = 'application/json'

    def __init__(self, data=None, status=None, **kwargs):
        if data is None:
            if kwargs.get('response') is None:
                status = 204
        else:
            if hasattr(data, 'to_dict'):
                data = data.to_dict()
            kwargs['response'] = json.dumps(data)

        if status is not None:
            kwargs['status'] = status

        super(Response, self).__init__(**kwargs)

        self.headers.add('access-control-allow-headers', '*')
        self.headers.add('access-control-allow-methods', '*')
        self.headers.add('access-control-allow-origin', '*')


class ApiRedirect(ApiResponse):
    default_status = 302

    def __init__(self, url, query=None, *args, **kwargs):
        super(ApiResponse, self).__init__(None, *args, **kwargs)

        if not (300 < self.status_code and self.status_code < 400):
            raise ValueError('Invalid Status Code, Redirects should be equal to or between 300 and 399')

        if query:
            if '?' in url:
                url += '&' + urlencode(query)
            else:
                url += '?' + urlencode(query)

        self.headers.add('location', url)


class ApiError(Exception):
    code = 0
    message = None
    status = 400

    def __init__(self, message=None, status=None, *args, **kwargs):
        super(Exception, self).__init__()
        if status is not None:
            self.status = status

        if message is not None:
            self.message = message
        elif self.message is None:
            self.message = HTTP_STATUS_CODES.get(self.status, 'Unknown Error')

        if kwargs.get('code') is not None:
            self.code = kwargs.get('code')

        kwargs['data'] = kwargs.pop('metadata', None) or {}
        kwargs['data'].update({'code': self.code, 'message': self.message, 'status': self.status})
        kwargs['status'] = self.status
        self.response = ApiResponse(**kwargs)
