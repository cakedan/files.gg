from utils.http import get_client

BASE_URL = 'https://www.google.com/recaptcha/api/siteverify'


class Recaptcha:
    secret = None

    @classmethod
    def set_secret(cls, secret):
        cls.secret = secret

    @classmethod
    async def verify(cls, response, remoteip=None):
        if cls.secret is None:
            raise Exception('Secret is not set on Recaptcha')

        data = {'secret': cls.secret}
        if response is not None:
            # requests dropped None values from form data
            data['response'] = response
        if remoteip is not None:
            data['remoteip'] = remoteip
        return await get_client().post(BASE_URL, data=data)
