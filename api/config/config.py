cfg = {
	'host': '127.0.0.1',
	'port': 4001,
	'base': '/api',
	'cloudflare': True,
	'aiohttp_server': {
		'client_max_size': 5000000000000
	},
	'googlecloud': {
		'private_key': '-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----\n',
		'iss': '',
		'storage_bucket': 'cdn.files.gg'
	},
	'googleapi': {
		'storage_bucket': 'cdn.files.gg',
		'credentials': '/var/www/files.gg/api/config/google.json'
	},
	'templates': {
		'favicon': {
			'font': '/var/www/files.gg/api/server/files/template_favicon_font.ttf',
			'images': {
				'default': '/var/www/files.gg/api/server/files/template_favicon_default.png',
				'audio': '/var/www/files.gg/api/server/files/template_favicon_audio.png',
				'image': '/var/www/files.gg/api/server/files/template_favicon_image.png',
				'text': '/var/www/files.gg/api/server/files/template_favicon_text.png',
				'video': '/var/www/files.gg/api/server/files/template_favicon_video.png'
			}
		}
	},
	'database': {
		'host': '127.0.0.1',
		'user': 'cdn',
		'password': '',
		'db': 'files_gg',
		'charset': 'utf8mb4',
		'maxsize': 250
	}
}