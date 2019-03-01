from utils.responses import ApiError


class InvalidMimetype(ApiError):
    code = 140001
    message = 'Invalid Mimetype'


class UnknownFile(ApiError):
    code = 140401
    message = 'Unknown File'
    status = 404
