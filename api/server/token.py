import base64
import struct
import time

from cryptography.fernet import Fernet
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.hmac import HMAC

from server.snowflake import SnowflakeGenerator

'''
	Offset from Unix Epoch
	Unix Epoch : January 1 1970 00:00:00 GMT
	Epoch Offset : April 1 2018 00:00:01 GMT
'''

class TokenGenerator:
	def __init__(self, **kwargs):
		kwargs = {
			'epoch_offset': kwargs.pop('epoch_offset', 1522540801000),
			'datacenter_id': kwargs.pop('datacenter_id', 0),
			'worker_id': kwargs.pop('worker_id', 0)
		}
		self.snowflake = SnowflakeGenerator(**kwargs)
	
	def hmac(self, snowflake, secret):
		if not isinstance(secret, bytes):
			secret = str(secret).encode()
		hmac = HMAC(secret, hashes.SHA256(), backend=default_backend())
		hmac.update(struct.pack('l', int(snowflake)))
		return base64.urlsafe_b64encode(hmac.finalize()).decode()

	def generate(self, uid):
		snowflake = self.snowflake.generate()
		secret = Fernet.generate_key()
		hmac = self.hmac(snowflake, secret)

		return {
			'id': uid,
			'snowflake': snowflake,
			'secret': secret.decode(),
			'hmac': hmac,
			'token': self.format(uid, snowflake, hmac)
		}
	
	def compare(self, hmac, snowflake, secret):
		if not isinstance(hmac, bytes):
			hmac = base64.urlsafe_b64decode(hmac)
		if not isinstance(secret, bytes):
			secret = str(secret).encode()

		compare_hmac = HMAC(secret, hashes.SHA256(), backend=default_backend())
		compare_hmac.update(struct.pack('l', int(snowflake)))
		try:
			compare_hmac.verify(hmac)
			return True
		except:
			return False

	def format(self, uid, snowflake, hmac):
		return '{}.{}.{}'.format(
			base64.urlsafe_b64encode(str(uid).encode()).decode(),
			base64.urlsafe_b64encode(struct.pack('l', int(snowflake))).decode(),
			hmac
		)
	
	def split(self, token):
		if not token or not isinstance(token, str):
			raise Exception('Invalid Authorization Format')

		parts = token.split(' ')
		if len(parts) > 2:
			raise Exception('Invalid Authorization Format')

		response = {}
		if len(parts) == 1:
			response['type'] = 'user'
			token = parts.pop(0)
			parts = token.split('.')
			if len(parts) != 3 or not all(parts):
				raise Exception('Invalid Authorization Format')
			response.update({
				'user_id': parts.pop(0),
				'snowflake': parts.pop(0),
				'hmac': parts.pop(0)
			})
		else:
			token_type = parts.pop(0)
			token = parts.pop(0)
			if token_type not in ['Bot']:
				raise Exception('Invalid Authorization Type')
			token_type = token_type.lower()
			parts = token.split('.')
			if not all(parts):
				raise Exception('Invalid Authorization Format')
			if token_type == 'bot':
				if len(parts) == 4:
					response.update({
						'user_id': parts.pop(0)
					})
				if len(parts) != 3:
					raise Exception('Invalid Authorization Format')
				
				response.update({
					'bot_id': parts.pop(0),
					'snowflake': parts.pop(0),
					'hmac': parts.pop(0)
				})
			
			response['type'] = token_type
		
		try:
			for key in ['user_id', 'bot_id', 'snowflake']:
				if not response.get(key):
					continue
				response[key] = base64.urlsafe_b64decode(response[key])
				if key == 'snowflake':
					response[key] = struct.unpack('l', response[key])[0]
				else:
					response[key] = int(response[key].decode())
		except:
			raise Exception('Invalid Authorization Format')
		
		return response