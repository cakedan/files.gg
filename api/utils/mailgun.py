import json
import requests

BASE_URL = 'https://api.mailgun.net/v3'


class Mailgun:
    domain = None
    token = None

    @classmethod
    def set_domain(cls, domain):
        cls.domain = domain

    @classmethod
    def set_token(cls, token):
        cls.token = token

    @classmethod
    def send_mail(cls, data, variables=None):
        if not cls.token:
            raise Exception('Token not set for mailgun')
        if not cls.domain:
            raise Exception('Domain not set for mailgun')

        if variables is not None:
            data['h:x-mailgun-variables'] = json.dumps(variables)
        return requests.post(
            '{}/{}/messages'.format(BASE_URL, cls.domain),
            auth=('api', cls.token),
            data=data,
        )

    @classmethod
    def verify_email(cls, address, mailbox_verification=False):
        return requests.get(
            '{}/address/private/validate'.format(BASE_URL),
            auth=('api', cls.token),
            params={'address': address, 'mailbox_verification': mailbox_verification},
        )
