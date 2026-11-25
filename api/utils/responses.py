import json

from sanic.response import HTTPResponse
from http import HTTPStatus

JSON = 'application/json'


def ApiResponse(data=None, status=None):
    """JSON response (`json.dumps` defaults). No data means 204."""
    if data is None:
        return HTTPResponse(b'', status=status or 204, headers={'content-type': JSON})
    return HTTPResponse(json.dumps(data), status=status or 200, content_type=JSON)


# the code an error gets from its status alone, when nothing more specific applies
STATUS_CODES = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    408: 'REQUEST_TIMEOUT',
    411: 'LENGTH_REQUIRED',
    413: 'PAYLOAD_TOO_LARGE',
    416: 'RANGE_NOT_SATISFIABLE',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_ERROR',
    503: 'SERVICE_UNAVAILABLE',
}
# the default message by status (sentence case)
STATUS_MESSAGES = {
    400: 'Bad request',
    401: 'Sign in to do that',
    403: "You can't do that",
    404: 'Not found',
    405: 'Method not allowed',
    413: 'Request too large',
    429: 'Too many requests',
    500: 'Something went wrong',
    503: 'Service unavailable',
}


def _phrase(status):
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return 'Error'


class ApiError(Exception):
    """Raised anywhere in a request; rendered as `{**details, "code", "message", "status"}`.
    Every code is an UPPER_SNAKE string (contract milestone-3 §0)."""
    code = None
    message = None
    status = 400

    def __init__(self, message=None, status=None, *args, **kwargs):
        super().__init__()
        if status is not None:
            self.status = status

        if message is not None:
            self.message = message
        elif self.message is None:
            self.message = STATUS_MESSAGES.get(self.status) or _phrase(self.status)

        if kwargs.get('code') is not None:
            self.code = kwargs.get('code')
        elif self.code is None:
            self.code = STATUS_CODES.get(self.status, 'ERROR')

        self.data = dict(kwargs.pop('metadata', None) or {})
        self.data.update({'code': self.code, 'message': self.message, 'status': self.status})

    def __str__(self):
        return '{} ({})'.format(self.message, self.status)

    @property
    def response(self):
        return ApiResponse(self.data, status=self.status)
