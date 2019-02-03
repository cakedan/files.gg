import hashlib
import io

from server.rest.endpoint import Endpoint
from server.rest.invalidusage import InvalidUsage
from server.rest.response import Response

from PIL import Image, ImageFont, ImageDraw

class RestEndpoint(Endpoint):
	def __init__(self, server):
		super().__init__()
		self.server = server
		self.path = '/mimetypes/icons/{mtype}/{mime}/{extension}'

		self.font = None
		self.templates = None

		config = self.server.config['templates'].pop('favicon')
		if config.get('font'):
			self.font = ImageFont.truetype(config['font'], 150)
		
		if config.get('images'):
			self.templates = {}
			for key in config['images'].keys():
				self.templates[key] = Image.open(config['images'][key])
		
		self.bucket = self.server.cdnbucket
		self.chunk_size = 1024 * 1024
	
	async def generate(self, mtype, text):
		background = self.templates.get(mtype, self.templates['default']).copy()

		iwidth, iheight = (512, 512)

		draw = ImageDraw.Draw(background)
		twidth, theight = draw.textsize(text, font=self.font)

		center = ((int(iwidth - twidth) / 2), (int(iheight - theight) / 2) + 75)
		draw.text(center, text, (42, 44, 49), font=self.font)

		raw = io.BytesIO()
		background.save(raw, format='png')
		return raw.getvalue()
	
	async def get(self, request, mtype, mime, extension):
		if not self.font or not self.templates:
			raise InvalidUsage(500, 'Server missing templates')

		mimetype = '/'.join([mtype, mime])
		if extension == '.':
			extension = None

		response = {}
		connection = await self.server.database.acquire()
		try:
			async with connection.cursor() as cur:
				if not await cur.execute('SELECT * FROM `mimetypes_extensions` WHERE `mime` = %s AND `extension` = %s', (mimetype, extension)):
					raise InvalidUsage(404, 'Mimetype not found')

				found = await cur.fetchone()
				extension = found['extension']

				if not extension or len(extension) > 5:
					mtype = 'application'
					extension = 'file'
				
				if await cur.execute('SELECT `hash` FROM `mimetypes_icons` WHERE `type` = %s AND `extension` = %s', (mtype, extension)):
					ihash = await cur.fetchone()
					ihash = ihash['hash']
				else:
					image = await self.generate(mtype, extension.upper())
					size = len(image)

					ihash = hashlib.sha256()
					ihash.update(image)
					ihash = ihash.hexdigest()

					chunk_size = None
					if size > self.chunk_size:
						chunk_size = self.chunk_size

					blob = self.bucket.blob('assets/icons/{}.png'.format(ihash), chunk_size=chunk_size)
					blob.content_disposition = 'inline; filename="icon-{}-{}.png"'.format(mtype, extension)
					blob.upload_from_string(image, content_type='image/png', predefined_acl='publicRead') #google-cloud-storage==1.8.0

					await cur.execute('INSERT INTO `mimetypes_icons` (`type`, `extension`, `hash`) VALUES (%s, %s, %s)', (mtype, extension, ihash))

				if mtype == 'image':
					if mimetype in ['image/png', 'image/jpg', 'image/jpeg', 'image/pjpeg', 'image/gif', 'image/webp']:
						response['website_type'] = mtype
				elif mtype == 'video':
					if mimetype in ['video/ogg', 'video/mpeg', 'video/mp4', 'video/webm', 'video/avi', 'video/msvideo']:
						response['website_type'] = mtype
				
				if not response.get('website_type'):
					response['website_type'] = 'website'
				
				response['url'] = 'https://cdn.files.gg/assets/icons/{}.png'.format(ihash)
		finally:
			self.server.database.release(connection)
		
		return Response(200, response)