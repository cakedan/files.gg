from flask import Blueprint, request

import api.library.helpers as helpers
from api.library.responses import APIResponse
from api.models import Mimetypes, MimetypeExtensions

mimetypes = Blueprint('mimetypes', __name__, url_prefix='/mimetypes')


@mimetypes.route('', methods=['GET'])
def mimetypes_all():
    query = MimetypeExtensions.select(
        MimetypeExtensions,
        Mimetypes,
    ).join(Mimetypes).where(Mimetypes.id == MimetypeExtensions.mime)
    return APIResponse([x.to_dict() for x in query])


@mimetypes.route('', methods=['POST'])
@helpers.filter_data(
    mime={'required': True, 'type': str},
    extension=str,
    required_flags={'default': 0, 'type': int},
)
def mimetype_create(data):
    return APIResponse('lol')
    data.mime = data.mime.lower()
    data.extension = data.extension and data.extension.lower()

    mimetype = Mimetypes.get_or_none(id=data.mime)
    if mimetype is None:
        mimetype = Mimetypes.create(id=data.mime, required_flags=data.required_flags)

    extension = data.extension
    if extension is not None:
        extension = MimetypeExtensions.get_or_none(mime=mimetype, extension=data.extension)
        if extension is None:
            extension = MimetypeExtensions.create(mime=mimetype, extension=data.extension)
    print(mimetype, extension)
    return APIResponse('lol')
