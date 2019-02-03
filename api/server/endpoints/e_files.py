import json
import random
import string
import time

from urllib.parse import quote as urlencode

from server.rest.endpoint import Endpoint
from server.rest.invalidusage import InvalidUsage
from server.rest.response import Response

class RestEndpoint(Endpoint):
	def __init__(self, server):
		super().__init__()
		self.server = server
		self.path = '/files'

		self.bucket = self.server.cdnbucket
		self.chunk_size = 1024 * 1024

		self.allowed_content_types = ['multipart/form-data', 'application/x-www-form-urlencoded']
		self.blacklisted_ids = ['assets', 'auth', 'panel', 'tos']

		self.idchars = string.ascii_lowercase + string.digits
	
	def generate_id(self, length):
		fid = ''.join(random.choice(self.idchars) for _ in range(length))
		if fid in self.blacklisted_ids:
			return self.generate_id(length)
		return fid
	
	def get_query(self, request):
		params = {}
		if request.query.get('folder', None):
			params['folder'] = bool(request.query['folder'] == 'true')

		if request.query.get('filename', None):
			params['filename'] = request.query['filename']

		for param in ['name_length', 'folder_length']:
			if request.query.get(param, None):
				params[param] = request.query.get(param)

		return params
	
	async def upload_multipart(self, request):
		ctype = request.headers.get('content-type', None)
		if not ctype or not any([ctype.startswith(c) for c in ['multipart/form-data', 'application/x-www-form-urlencoded']]):
			raise InvalidUsage(400)
		
		params = {}
		fdata = ftype = fext = None
		async for field in await request.multipart():
			if field.name == 'file':
				fname = field.filename.split('.')

				params['extension'] = fname.pop() if len(fname) > 1 else None
				if not params.get('filename', None):
					params['filename'] = '.'.join(fname)

				ftype = field.headers.get('content-type', '').lower().split(';').pop(0)
				fdata = await field.read()
			elif field.name == 'folder':
				params['folder'] = bool(await field.text() == 'true')
			elif field.name == 'name_length' or field.name == 'folder_length':
				params[field.name] = await field.text()
			elif field.name == 'filename':
				params['filename'] = await field.text()
		
		if not fdata:
			raise InvalidUsage(400)
		
		return (fdata, len(fdata), ftype, params)
	
	async def upload_raw(self, request):
		ctype = request.headers.get('content-type', '').lower().split(';').pop(0)
		if not ctype:
			raise InvalidUsage(400)
		
		fdata = await request.read()

		params = {'filename': request.query.get('filename', None)}

		return (fdata, len(fdata), ctype, params)

	
	async def post(self, request):
		if not request.body_exists:
			raise InvalidUsage(400)

		upload_type = request.query.get('type', 'multipart').lower()
		upload = getattr(self, 'upload_{}'.format(upload_type), None)
		if not upload:
			raise InvalidUsage(400, 'Invalid Upload Type')

		fdata, fsize, ftype, params = await upload(request)
		params.update(self.get_query(request))

		for param in ['name_length', 'folder_length']:
			if not params.get(param, None):
				continue
			try:
				if params[param] == 'random':
					params[param] = random.randint(3, 10)
				else:
					params[param] = int(params[param])
			except:
				raise InvalidUsage(400, '{} has to be an int'.format(param))
		
		fname = params.get('filename', None)
		if fname == 'random':
			fname = None

		fext = params.get('extension', None)
		fname = fname.split('.') if fname else []
		if not fext and len(fname) > 1:
			fext = fname.pop()
		
		response = {}
		connection = await self.server.database.acquire()
		try:
			async with connection.cursor() as cur:
				for param in ['name_length', 'folder_length']:
					params[param] = max(min(params.get(param, 6), 10), 3)
				
				if not await cur.execute('SELECT * FROM `mimetypes` WHERE `mime` = %s', (ftype,)):
					print(ftype)
					raise InvalidUsage(400, 'Invalid Mime Type')
				msettings = await cur.fetchone()
				if msettings.get('required_flags'):
					pass
				
				unique = folder = fid = None
				while not unique:
					fid = self.generate_id(params['name_length'])
					if params.get('folder'):
						folder = self.generate_id(params['name_length'])
					if await cur.execute('SELECT * FROM `files` WHERE `id` = %s AND `folder` {} %s'.format('=' if folder else 'is'), (fid, folder)):
						await cur.fetchone()
					else:
						unique = True
				
				if not fname:
					fname.append('-'.join([x for x in [folder, fid] if x]))

				if fext:
					if await cur.execute('SELECT * FROM `mimetypes_extensions` WHERE `extension` = %s', (fext.lower(),)):
						exts = await cur.fetchall()
						matched = False
						for ext in exts:
							if ext['mime'] == ftype:
								fext = ext['extension']
								matched = True
								break
						
						if not matched:
							#pick first extension and go with it /shrug
							if ftype == 'application/octet-stream':
								ext = exts.pop(0)
								ftype = ext['mime']
								fext = ext['extension']
							else:
								fext = None
					else:
						fname.append(fext)
						fext = None

				storetype = ftype
				if 'html' in ftype:
					storetype = 'text/plain'

				if not fext:
					if ftype == 'application/octet-stream':
						fext = 'bin'
					elif ftype == 'image/png':
						fext = 'png'
					elif ftype == 'image/jpeg':
						fext = 'jpg'
					elif ftype == 'text/html':
						fext = 'html'
					elif ftype == 'text/plain':
						fext = 'txt'
					else:
						if await cur.execute('SELECT * FROM `mimetypes_extensions` WHERE `mime` = %s', (ftype,)):
							fext = (await cur.fetchone())['extension']
				
				fname = '.'.join(fname)[:100]
				
				filename = urlencode('.'.join([x for x in [fname, fext] if x]))

				pathfile = '.'.join([x for x in [fid, fext] if x])
				path = '/'.join([v for v in [folder, pathfile] if v])
				try:
					csize = None
					if fsize > self.chunk_size:
						csize = self.chunk_size
					
					blob = self.bucket.blob('files/{}'.format(path), chunk_size=csize)
					blob.content_disposition = ';'.join(['inline', 'filename="{}"'.format(filename)])
					blob.upload_from_string(bytes(fdata), content_type=storetype, predefined_acl='publicRead') #google-cloud-storage==1.8.0
				except Exception as e:
					raise InvalidUsage(500, str(e))
				
				timestamp = int(time.time())
				await cur.execute(
					'INSERT INTO `files` (`id`, `folder`, `extension`, `user_id`, `filename`, `mimetype`, `size`, `timestamp`) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)',
					(fid, folder, fext, None, fname, ftype, fsize, timestamp)
				)

				response.update({
					'id': fid,
					'folder': folder,
					'extension': fext,
					'filename': fname,
					'mimetype': ftype,
					'size': fsize,
					'urls': {
						'site': 'https://files.gg/{}'.format(path),
						'cdn': 'https://cdn.files.gg/files/{}'.format(path)
					},
					'timestamp': timestamp,
					'user': None,
					'height': None,
					'width': None,
					'duration': None
				})

				if None:#grab user from db if passed in auth
					response['user'] = {k: user[k] for k in ['id']}
		finally:
			self.server.database.release(connection)
		
		return Response(200, response)