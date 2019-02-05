from flask import Blueprint, request

import api.library.helpers as helpers
from api.library.responses import APIResponse


folders = Blueprint('folders', __name__, url_prefix='/folders')


@folders.route('', methods=['GET'])
def folders_mine():
    #Folders.select(Folders).join(Files).where(Files.user == user, Files.folder == Folders.id)
    return APIResponse('register')


@folders.route('/{folder_id}', methods=['GET'])
def folders_get(folder_id):
    return APIResponse('login')


@folders.route('/{folder_id}/files', methods=['GET'])
def folders_get_files(folder_id):
    pass

@folders.route('/{folder_id}/files/{file_id}', methods=['GET'])
def folders_get_file(folder_id, file_id):
    pass
