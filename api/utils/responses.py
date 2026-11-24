import json

from sanic.response import HTTPResponse
from werkzeug.http import HTTP_STATUS_CODES

JSON = 'application/json'


def ApiResponse(data=None, status=None):
    """JSON response, serialised exactly as the Flask version did
    (`json.dumps` defaults). No data means 204."""
    if data is None:
        # Sanic only adds content-type to statuses with a body; Flask always sent it
        return HTTPResponse(b'', status=status or 204, headers={'content-type': JSON})
    if hasattr(data, 'to_dict'):
        data = data.to_dict()
    return HTTPResponse(json.dumps(data), status=status or 200, content_type=JSON)


class ApiError(Exception):
    """Raised anywhere in a request; rendered as
    `{**metadata, "code", "message", "status"}`."""
    code = 0
    message = None
    status = 400

    def __init__(self, message=None, status=None, *args, **kwargs):
        super().__init__()
        if status is not None:
            self.status = status

        if message is not None:
            self.message = message
        elif self.message is None:
            # Werkzeug's reason phrases, as Flask used them
            self.message = HTTP_STATUS_CODES.get(self.status, 'Unknown Error')

        if kwargs.get('code') is not None:
            self.code = kwargs.get('code')

        self.data = dict(kwargs.pop('metadata', None) or {})
        self.data.update({'code': self.code, 'message': self.message, 'status': self.status})

    def __str__(self):
        return '{} ({})'.format(self.message, self.status)

    @property
    def response(self):
        return ApiResponse(self.data, status=self.status)
