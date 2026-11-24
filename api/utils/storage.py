"""Blob storage for uploads. GCS until Milestone 2 moves to B2.

google-cloud-storage is synchronous, so every call runs in the default
executor (`loop.run_in_executor`) to keep the event loop free.
STORAGE_BACKEND=local writes to LOCAL_STORAGE_PATH instead (development and
tests).
"""

import asyncio
import os
import shutil
import threading


class GCSStorage:
    def __init__(self, credentials_path, bucket):
        self.credentials_path = credentials_path
        self.bucket_name = bucket
        self._client = None
        self._lock = threading.Lock()

    def _bucket(self):
        if self._client is None:
            with self._lock:
                if self._client is None:
                    from google.cloud import storage
                    self._client = storage.Client.from_service_account_json(self.credentials_path)
        return self._client.bucket(self.bucket_name)

    def _upload_bytes(self, key, data):
        blob = self._bucket().blob(key)
        blob.upload_from_string(data, content_type='application/octet-stream', predefined_acl='publicRead')

    def _upload_file(self, key, path):
        blob = self._bucket().blob(key)
        blob.upload_from_filename(path, content_type='application/octet-stream', predefined_acl='publicRead')

    async def upload_bytes(self, key, data):
        await asyncio.get_running_loop().run_in_executor(None, self._upload_bytes, key, data)

    async def upload_file(self, key, path):
        await asyncio.get_running_loop().run_in_executor(None, self._upload_file, key, path)


class LocalStorage:
    def __init__(self, root):
        self.root = root

    def _path(self, key):
        path = os.path.join(self.root, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        return path

    def _write(self, key, data):
        with open(self._path(key), 'wb') as handle:
            handle.write(data)

    async def upload_bytes(self, key, data):
        await asyncio.get_running_loop().run_in_executor(None, self._write, key, data)

    async def upload_file(self, key, path):
        await asyncio.get_running_loop().run_in_executor(None, shutil.copyfile, path, self._path(key))


def from_env():
    backend = os.getenv('STORAGE_BACKEND', 'gcs')
    if backend == 'local':
        return LocalStorage(os.getenv('LOCAL_STORAGE_PATH', '/tmp/filesgg-storage'))
    if backend == 'gcs':
        return GCSStorage(
            os.getenv('GOOGLE_APPLICATION_CREDENTIALS', '../gconfig.json'),
            os.getenv('STORAGE_BUCKET', 'filesgg'),
        )
    raise RuntimeError('Unknown STORAGE_BACKEND {!r}'.format(backend))
