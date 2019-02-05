import hashlib
import json
import random
import string
import time

from flask import Blueprint, request
from google.cloud import storage

import api.library.helpers as helpers
from api.library.generators import Snowflake
from api.library.responses import APIError, APIResponse
from api.models import Files, FileHashes, Mimetypes, MimetypeExtensions


try:
    from google.auth import app_engine

    credentials = app_engine.Credentials()
except:
    from google.oauth2 import service_account

    credentials = {}
    credentials = service_account.Credentials.from_service_account_info(credentials)


files = Blueprint('files', __name__, url_prefix='/files')


@files.route('', methods=['GET'])
def files_mine():
    return APIResponse([])


blacklisted_ids = ['assets', 'auth', 'panel', 'info']
def generate_file_id(length):
    fid = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(length))
    if fid in blacklisted_ids:
        return generate_file_id(length)
    return fid

MAX_NAME_LENGTH = 16
MIN_NAME_LENGTH = 3


@files.route('', methods=['POST'])
@helpers.filter_data(
    include_args=True,
    include_form=True,
    ignore_json=True,
    filename=str,
    folder=bool,
    name_length={'default': 0, 'type': int},
    folder_length={'default': 0, 'type': int},
    type={'default': 'multipart', 'type': str},
)
def files_upload(data):
    for param in ['name_length', 'folder_length']:
        if data.get(param) < MIN_NAME_LENGTH or MAX_NAME_LENGTH < data.get(param):
            data.set(param, random.randint(MIN_NAME_LENGTH, MAX_NAME_LENGTH))

    if data.type == 'multipart':
        uploaded_file = request.files.get('file')
        if uploaded_file is None:
            raise APIError(status=400)

        if data.filename is None:
            data.filename = uploaded_file.filename
        
        mimetype = uploaded_file.mimetype
        stream = uploaded_file.stream
    elif data.type == 'raw':
        mimetype = request.mimetype
        stream = request.stream
    else:
        raise APIError(status=400, message='Invalid Upload Type')

    file_name = None
    if data.filename == 'random' or data.filename is None:
        file_name = [generate_file_id(random.randint(MIN_NAME_LENGTH, MAX_NAME_LENGTH))]
    else:
        file_name = data.filename.split('.')

    file_extension = None
    if len(file_name) > 1:
        file_extension = file_name.pop()

    mime = Mimetypes.get_or_none(id=mimetype)
    if mime is None:
        raise APIError(status=400, message='Invalid Mimetype')
    #add required_flags check

    if file_extension is not None:
        mime_extension = MimetypeExtensions.get_or_none(mime=mime, extension=file_extension.lower())
        #keep extension case incase its not found
        if mime_extension is None:
            file_name.append(file_extension)
            file_extension = None
        else:
            file_extension = mime_extension.extension

    if file_extension is None:
        # just common extensions here
        if mimetype == 'application/octet-stream':
            file_extension = 'bin'
        elif mimetype == 'image/png':
            file_extension = 'png'
        elif mimetype == 'text/html':
            file_extension = 'html'
        elif mimetype == 'text/plain':
            file_extension = 'txt'
        else:
            mime_extension = MimetypeExtensions.get_or_none(mime=mime)
            if mime_extension is None:
                # never should happen
                raise APIError(status=400, message='Can\'t find any extensions for this mimetype')
            else:
                file_extension = mime_extension.extension
    
    file_name = '.'.join(file_name)[:100]

    file_data = stream.read()
    file_size = len(file_data)

    # check if size is appropriate for account
    # read data to get mimetype via that?

    hash_blake2b = hashlib.blake2b(file_data).hexdigest()
    hash_md5 = hashlib.md5(file_data).hexdigest()
    hash_sha1 = hashlib.sha1(file_data).hexdigest()

    file_exists = True
    file_hash = FileHashes.get_or_none(blake2b=hash_blake2b, md5=hash_md5, sha1=hash_sha1)
    if file_hash is None:
        file_exists = False
        file_hash = FileHashes.create(
            id=Snowflake.generate(),
            blake2b=hash_blake2b,
            md5=hash_md5,
            sha1=hash_sha1,
            mimetype=mimetype,
            size=file_size,
        )

    file_folder = file_id = None
    unique = False
    while not unique:
        file_id = generate_file_id(data.name_length)
        if data.folder:
            file_folder = generate_file_id(data.folder_length)
        unique = bool(Files.get_or_none(id=file_id, folder=file_folder) is None)

    if not file_exists:
        gcs = storage.Client(project=credentials.project_id, credentials=credentials)
        bucket = gcs.get_bucket('filesgg')
        blob = bucket.blob('files/{}'.format(file_hash.id))
        blob.upload_from_string(file_data, content_type='application/octet-stream') #predefined_acl='publicRead'?
        blob.make_public()

    timestamp = int(time.time())
    file_obj = Files.create(
        id=file_id,
        folder=file_folder,
        extension=file_extension,
        filename=file_name,
        timestamp=timestamp,
        hash=file_hash,
        user=None,
    )

    return APIResponse(file_obj.to_dict())


@files.route('/<path:file_path>', methods=['GET'])
def files_get(file_path):
    file_path = file_path.split('.').pop(0).split('/')

    if len(file_path) == 1:
        file_folder = None
        file_id = file_path.pop(0)
    elif len(file_path) == 2:
        file_folder = file_path.pop(0)
        file_id = file_path.pop(0)
    else:
        raise APIError(status=404, message='Unknown File')

    file_obj = Files.get_or_none(id=file_id, folder=file_folder)
    if file_obj is None:
        raise APIError(status=404, message='Unknown File')

    return APIResponse(file_obj.to_dict())


@files.route('/<path:file_path>', methods=['DELETE'])
def files_delete(file_path):
    file_path = file_path.split('.').pop(0).split('/')

    if len(file_path) == 1:
        file_folder = None
        file_id = file_path.pop(0)
    elif len(file_path) == 2:
        file_folder = file_path.pop(0)
        file_id = file_path.pop(0)
    else:
        raise APIError(status=404, message='Unknown File')

    return APIResponse([file_id, file_folder])
