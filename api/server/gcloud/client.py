import asyncio
import json
import time

from email import charset
from email.mime.multipart import MIMEMultipart
from email.mime.nonmultipart import MIMENonMultipart
from io import BytesIO
from urllib.parse import quote as _uriquote

import aiohttp
import jwt

charset.add_charset('utf-8', charset.SHORTEST)

class Client:
	def __init__(self, **kwargs):
		self.httpclient = kwargs.pop('httpclient', None)

		self.iss = kwargs.pop('iss', None)
		self.scope = 'https://www.googleapis.com/auth/devstorage.full_control'
		self.aud = 'https://www.googleapis.com/oauth2/v4/token'
		self.token_initial = 0
		self.token_expire = 0

		self.privatekey = kwargs.pop('private_key', '').encode()
		self.bucket = kwargs.pop('storage_bucket', '')
		self.chunk_size = 1024 * 1024

		self._token = {}
	
	@property
	def api_url_storage(self):
		return 'https://www.googleapis.com/upload/storage/v1/b/{}/o'.format(_uriquote(self.bucket))
	
	async def token(self):
		now = time.time()

		if not self._token or now > self.token_expire:
			self.token_initial = now
			self.token_expire = now + 3600

			claim = {
				'iss': self.iss,
				'scope': self.scope,
				'aud': self.aud,
				'iat': self.token_initial,
				'exp': self.token_expire
			}

			token = jwt.encode(claim, self.privatekey, algorithm='RS256')
			data = aiohttp.FormData()
			data.add_field('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer')
			data.add_field('assertion', token.decode())
			response = await self.httpclient._request('post', 'https://www.googleapis.com/oauth2/v4/token', data=data)
			if response.status != 200:
				error = Exception('HTTP Exception: {}'.format(response.status))
				error.response = response
				raise error
			
			data = await response.json()

			self._token['type'] = data['token_type']
			self._token['access'] = data['access_token']

		return ' '.join([self._token['type'], self._token['access']])
	
	async def _store_multipart(self, filename, data, size=None, content_type='application/octet-stream'):
		if isinstance(data, BytesIO):
			data = data.readall()
		if isinstance(data, str):
			data = data.encode()
		if not isinstance(data, bytes):
			data = bytes(data)

		form = MIMEMultipart('related')

		_metadata = {}
		_metadata['name'] = filename
		metadata = MIMENonMultipart('application', 'json')
		metadata.set_payload(json.dumps(_metadata), 'utf-8')
		form.attach(metadata)

		content_type = content_type.split('/')
		maintype = content_type.pop(0)
		subtype = content_type.pop(0)

		media = MIMENonMultipart(maintype, subtype)
		media.set_payload(data)
		form.attach(media)
		
		data = form.as_string().split('\n\n', 1)[1]
		headers = dict(form.items())
		headers['Authorization'] = await self.token()
		response = await self.httpclient._request('post', self.api_url_storage, params={'uploadType': 'multipart'}, headers=headers, data=data)
		if response.status != 200:
			error = Exception('HTTP Exception: {}'.format(response.status))
			error.response = response
			raise error

		return response.json()
	
	async def _store_resumable(self, filename, data, size, content_type='application/octet-stream'):
		if not isinstance(data, BytesIO):
			if isinstance(data, str):
				data = data.encode()
			if not isinstance(data, bytes):
				data = bytes(data)
			data = BytesIO(data)

		url = await self.fetch_resumable_url(filename, size, content_type=content_type)

		range_start = 0
		range_end = 0
		range_total = size
		while True:
			chunk = data.read(self.chunk_size)
			if not len(chunk):
				break
			
			range_end += len(chunk) - 1
			response = await self.put_resumable_chunk(url, chunk, range_start=range_start, range_end=range_end, range_total=range_total)

			end = response['uploaded']
			if end - 1 != range_end:
				range_end = end
				data.seek(range_end)

			range_end = response['uploaded']
			range_start = range_end - range_start

			if response['finished']:
				break
		
		return response
	
	def store(self, filename, data, *args, **kwargs):
		if len(data) <= self.chunk_size:
			return self._store_multipart(filename, data, *args, **kwargs)
		else:
			return self._store_resumable(filename, data, *args, **kwargs)
	
	async def fetch_resumable_url(self, filename, size, content_type='application/octet-stream'):
		headers = {}
		headers['x-upload-content-type'] = content_type
		headers['x-upload-content-length'] = str(size)
		headers['authorization'] = await self.token()
		response = await self.httpclient._request('post', self.api_url_storage, params={'uploadType': 'resumable', 'name': filename}, headers=headers)
		if response.status != 200:
			raise Exception('Error fetching url')
		
		return response.headers.get('location')
	
	async def put_resumable_chunk(self, url, data, range_start=0, range_end=None, range_total=None):
		if range_total == None:
			range_total = len(data) - 1

		if range_end == None:
			range_end = len(data) - 1
		
		headers = {}
		headers['content-range'] = 'bytes {}-{}/{}'.format(range_start, range_end, range_total)
		response = await self.httpclient._request('put', url, headers=headers, data=data)

		reply = {'finished': False, 'uploaded': 0, 'metadata': {}}
		if response.status == 308:
			reply['uploaded'] = int(response.headers.get('range', '').split('-').pop(-1) or 0) + 1
		elif response.status == 200 or response.status == 201:
			reply['finished'] = True
			reply['metadata'] = await response.json()
			reply['uploaded'] = int(reply['metadata'].get('size'))
		else:
			error = Exception('HTTP Exception: {}'.format(response.status))
			error.response = response
			raise error
		return reply