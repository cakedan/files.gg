"""A tiny stand-in for Cloudflare's custom hostnames API (milestone-6 §10.5), for the local e2e stack only.

    POST   /client/v4/zones/<zone>/custom_hostnames          create: status `pending`, ssl `initializing`
    GET    /client/v4/zones/<zone>/custom_hostnames/<id>     read
    PATCH  /client/v4/zones/<zone>/custom_hostnames/<id>     re-check (what "Check now" sends)
    DELETE /client/v4/zones/<zone>/custom_hostnames/<id>     delete (404 when unknown)

Each GET or PATCH of a hostname moves it on one step, as Cloudflare would once the CNAME is live:
`pending` / `initializing`, then `active` / `pending_validation`, then `active` / `active`. So one
"Check now" (a GET, then a PATCH while it's still pending) makes a new domain active.

Every answer is Cloudflare's envelope, `{ success, errors, messages, result }`. A request without
`Authorization: Bearer <CLOUDFLARE_API_TOKEN>` or for another zone gets `success: false`.

`GET /_mock/hostnames` (not part of Cloudflare's API) lists every hostname this process has seen,
deleted ones included, so e2e/run.mjs can check what the API asked for. State is in memory only.

Runs with the API image's Python (standard library only): `python mock_cloudflare.py`, on port 8080.
"""

import json
import os
import re
import threading
import uuid

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get('CLOUDFLARE_API_TOKEN', '')
ZONE = os.environ.get('CLOUDFLARE_ZONE_ID', '')
PORT = int(os.environ.get('PORT', '8080'))
STEPS = (('pending', 'initializing'), ('active', 'pending_validation'), ('active', 'active'))
PATH = re.compile(r'^/client/v4/zones/(?P<zone>[^/]+)/custom_hostnames(?:/(?P<id>[^/]+))?/?$')

lock = threading.Lock()
hostnames = {}


def result_of(record):
    status, ssl_status = STEPS[min(record['step'], len(STEPS) - 1)]
    return {'id': record['id'], 'hostname': record['hostname'], 'status': status,
            'ssl': {'status': ssl_status, 'method': 'http', 'type': 'dv'}, 'created_at': record['created_at']}


class Handler(BaseHTTPRequestHandler):
    server_version = 'mock-cloudflare'

    def log_message(self, fmt, *args):
        print('mock-cloudflare: ' + fmt % args, flush=True)

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def ok(self, result, status=200):
        self.send(status, {'success': True, 'errors': [], 'messages': [], 'result': result})

    def fail(self, status, code, message):
        self.send(status, {'success': False, 'errors': [{'code': code, 'message': message}], 'messages': [],
                           'result': None})

    def body(self):
        length = int(self.headers.get('content-length') or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except ValueError:
            return None

    def route(self, method):
        if method == 'GET' and self.path in ('/health', '/_mock/hostnames'):
            if self.path == '/health':
                return self.send(200, {'ok': True})
            with lock:
                return self.send(200, {'items': [dict(r, result=result_of(r)) for r in hostnames.values()]})
        match = PATH.match(self.path.split('?')[0])
        if not match:
            return self.fail(404, 7003, 'Could not route to {}'.format(self.path))
        if self.headers.get('authorization') != 'Bearer {}'.format(TOKEN) or not TOKEN:
            return self.fail(403, 10000, 'Authentication error')
        if match.group('zone') != ZONE:
            return self.fail(403, 7003, 'Could not route to /zones/{}'.format(match.group('zone')))
        hostname_id = match.group('id')
        body = self.body()
        if body is None:
            return self.fail(400, 6007, 'Malformed JSON in request body')
        with lock:
            if hostname_id is None:
                if method != 'POST':
                    return self.fail(405, 10405, 'Method not allowed')
                hostname = body.get('hostname')
                if not isinstance(hostname, str) or not hostname:
                    return self.fail(400, 1411, 'Invalid custom hostname')
                if any(r['hostname'] == hostname and not r['deleted'] for r in hostnames.values()):
                    return self.fail(409, 1406, 'Duplicate custom hostname found')
                record = {'id': uuid.uuid4().hex[:32], 'hostname': hostname, 'step': 0, 'ssl': body.get('ssl'),
                          'deleted': False, 'calls': ['POST'],
                          'created_at': self.date_time_string()}
                hostnames[record['id']] = record
                return self.ok(result_of(record))
            record = hostnames.get(hostname_id)
            if record is None or record['deleted']:
                return self.fail(404, 1436, 'The custom hostname was not found')
            record['calls'].append(method)
            if method in ('GET', 'PATCH'):
                record['step'] += 1
                return self.ok(result_of(record))
            if method == 'DELETE':
                record['deleted'] = True
                return self.ok({'id': record['id']})
            return self.fail(405, 10405, 'Method not allowed')

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def do_PATCH(self):
        self.route('PATCH')

    def do_DELETE(self):
        self.route('DELETE')


if __name__ == '__main__':
    print('mock-cloudflare: listening on :{} for zone {}'.format(PORT, ZONE), flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
