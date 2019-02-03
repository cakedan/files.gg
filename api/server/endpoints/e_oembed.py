from urllib.parse import urlparse

from server.rest.endpoint import Endpoint
from server.rest.invalidusage import InvalidUsage
from server.rest.response import Response

class RestEndpoint(Endpoint):
	def __init__(self, server):
		super().__init__()
		self.server = server
		self.path = '/oembed'

		self.mimetypes = {
			'audio': ['audio/mpeg', 'audio/mpeg3', 'audio/x-mpeg-3', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-pn-wav', 'audio/x-wav'],
			'image': ['image/png', 'image/x-citrix-png', 'image/x-png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/x-citrix-jpeg', 'image/webp', 'image/gif'],
			'video': ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'video/ogg', 'video/avi', 'video/msvideo']
		}

	async def get(self, request):
		url = urlparse(request.query.get('url', ''))
		oformat = request.query.get('format', None)

		response = {
			'version': '1.0',
			'type': 'link',
			'title': 'File Uploader',
			'url': 'https://files.gg/',
			'provider_name': 'files.gg',
			'provider_url': 'https://files.gg/'
		}

		if url.path:
			pathparts = [x for x in url.path.split('/') if x]
			folder = pathparts.pop(0)
			if folder == 'panel':
				pass
			elif folder == 'assets':
				pass
			elif folder == 'error':
				pass
			elif folder == 'tos':
				pass
			else:
				pathparts.insert(0, folder)
				folder = fid = None
				if len(pathparts) > 1:
					folder = pathparts.pop(0)
				fid = pathparts.pop(0).split('.').pop(0)

				connection = await self.server.database.acquire()
				try:
					async with connection.cursor() as cur:
						if not await cur.execute('SELECT * FROM `files` WHERE `id` = %s AND `folder` {} %s'.format('=' if folder else 'is'), (fid, folder)):
							pass
						else:
							fdata = await cur.fetchone()
							path = '/'.join([v for v in [fdata['folder'], '.'.join([x for x in [fdata['id'], fdata['extension']] if x])] if v])

							response['url'] = 'https://files.gg/{}'.format(path)
							response['title'] = '.'.join([x for x in [fdata['filename'], fdata['extension']] if x])

							mimetype = fdata['mimetype']
							mtype = mimetype.split('/').pop(0)

							cdnurl = 'https://cdn.files.gg/files/{}'.format(path)
							if mtype == 'image' and mimetype in self.mimetypes[mtype]:
								response['type'] = 'photo'
								response['url'] = cdnurl
								response['width'] = fdata.get('width')
								response['height'] = fdata.get('height')
							elif mtype == 'video' and mimetype in self.mimetypes[mtype]:
								response['type'] = 'video'
								response['url'] = cdnurl
								response['width'] = fdata.get('width')
								response['height'] = fdata.get('height')
								response['html'] = '<video controls><source src="{}"></source></video>'.format(cdnurl)
				finally:
					self.server.database.release(connection)

		return Response(200, response)