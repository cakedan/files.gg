import requests

BASE_URL = 'https://www.google.com/recaptcha/api/siteverify'


class Recaptcha:
    secret = None

    @classmethod
    def set_secret(cls, secret):
        cls.secret = secret

    @classmethod
    def verify(cls, response, remoteip=None):
        if cls.secret is None:
            raise Exception('Secret is not set on Recaptcha')

        data = {'secret': cls.secret, 'response': response}
        if remoteip is not None:
            data['remoteip'] = remoteip
        return requests.post(BASE_URL, data=data)
