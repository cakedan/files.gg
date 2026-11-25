"""Blob storage on Backblaze B2 through its S3-compatible API (contract §3).

    S3_ENDPOINT, S3_REGION, S3_BUCKET_FILES, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY

The API uses aiobotocore (`S3Storage`, one client per Sanic worker); the
synchronous `python -m worker` uses boto3 (`sync_client()`). Tests and local
development point S3_ENDPOINT at MinIO.

Keys: `files/<hash_id>` for blobs, `staging/<upload_id>` for chunked uploads in
progress and `derived/<hash_id>/<kind>.<ext>` for previews. Objects are stored as
application/octet-stream; the CDN Worker sets the real type when it serves them.
Every blob is on B2.
"""

import asyncio
import logging
import os

from dataclasses import dataclass

MB = 1024 * 1024
# single-request uploads above this go up as S3 multipart, PART_SIZE at a time
MULTIPART_THRESHOLD = 8 * MB
PART_SIZE = 8 * MB  # B2's minimum part is 5 MB
CONTENT_TYPE = 'application/octet-stream'

log = logging.getLogger(__name__)


def blob_key(hash_id):
    return 'files/{}'.format(hash_id)


def staging_key(upload_id):
    return 'staging/{}'.format(upload_id)


def missing_upload(error):
    """True when S3 says the multipart upload no longer exists (`NoSuchUpload`: already aborted or
    completed), so an abort has nothing left to do."""
    response = getattr(error, 'response', None) or {}
    code = str((response.get('Error') or {}).get('Code') or '')
    status = (response.get('ResponseMetadata') or {}).get('HTTPStatusCode')
    return code in ('NoSuchUpload', '404') or status == 404


def abort_multipart_sync(client, bucket, key, upload_id):
    """Abort a multipart upload with a boto3 client (the worker). Idempotent: True when it's gone
    (aborted now, or already aborted or completed), False when the abort failed and must be retried."""
    try:
        client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
    except Exception as error:
        if missing_upload(error):
            return True
        log.warning('abort of multipart upload %s for %s failed: %s', upload_id, key, error)
        return False
    return True


@dataclass(frozen=True)
class S3Settings:
    endpoint: str
    region: str
    bucket: str
    access_key_id: str
    secret_access_key: str

    @classmethod
    def from_env(cls):
        missing = [name for name in ('S3_ENDPOINT', 'S3_BUCKET_FILES', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY')
                   if not os.getenv(name)]
        if missing:
            raise RuntimeError('Missing S3 setting(s): {}'.format(', '.join(missing)))
        endpoint = os.environ['S3_ENDPOINT']
        if '://' not in endpoint:
            endpoint = 'https://' + endpoint
        return cls(endpoint, os.getenv('S3_REGION') or 'us-east-1', os.environ['S3_BUCKET_FILES'],
                   os.environ['S3_ACCESS_KEY_ID'], os.environ['S3_SECRET_ACCESS_KEY'])

    def client_kwargs(self):
        return {
            'endpoint_url': self.endpoint,
            'region_name': self.region,
            'aws_access_key_id': self.access_key_id,
            'aws_secret_access_key': self.secret_access_key,
        }

    def config_kwargs(self):
        return {
            'signature_version': 's3v4',
            's3': {'addressing_style': 'path'},
            # B2 rejects the newer default flexible checksums on some calls; only
            # send them where S3 requires one
            'request_checksum_calculation': 'when_required',
            'response_checksum_validation': 'when_required',
            'retries': {'max_attempts': 3, 'mode': 'standard'},
        }


def _read(path, offset, size):
    with open(path, 'rb') as handle:
        handle.seek(offset)
        return handle.read(size)


class S3Storage:
    """Async S3 client for one Sanic worker. `await open()` / `await close()`."""

    def __init__(self, settings=None):
        self.settings = settings or S3Settings.from_env()
        self.bucket = self.settings.bucket
        self._context = None
        self.client = None

    async def open(self):
        from aiobotocore.config import AioConfig
        from aiobotocore.session import get_session
        self._context = get_session().create_client(
            's3', config=AioConfig(max_pool_connections=64, **self.settings.config_kwargs()),
            **self.settings.client_kwargs())
        self.client = await self._context.__aenter__()
        return self

    async def close(self):
        if self._context is not None:
            await self._context.__aexit__(None, None, None)
            self._context = self.client = None

    async def put_bytes(self, key, data):
        await self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=CONTENT_TYPE)

    async def upload_file(self, key, path, size):
        """Upload a local file: one PutObject when small, else multipart in
        PART_SIZE pieces (only one piece in memory at a time)."""
        loop = asyncio.get_running_loop()
        if size <= MULTIPART_THRESHOLD:
            data = await loop.run_in_executor(None, _read, path, 0, size)
            await self.put_bytes(key, data)
            return
        upload_id = await self.create_multipart(key)
        try:
            parts = []
            for number, offset in enumerate(range(0, size, PART_SIZE), start=1):
                data = await loop.run_in_executor(None, _read, path, offset, PART_SIZE)
                parts.append((number, await self.upload_part(key, upload_id, number, data)))
            await self.complete_multipart(key, upload_id, parts)
        except BaseException:
            await self.abort_multipart(key, upload_id)
            raise

    async def create_multipart(self, key):
        response = await self.client.create_multipart_upload(Bucket=self.bucket, Key=key, ContentType=CONTENT_TYPE)
        return response['UploadId']

    async def upload_part(self, key, upload_id, part_number, data):
        response = await self.client.upload_part(
            Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumber=part_number, Body=data)
        return response['ETag']

    async def complete_multipart(self, key, upload_id, parts):
        await self.client.complete_multipart_upload(
            Bucket=self.bucket, Key=key, UploadId=upload_id,
            MultipartUpload={'Parts': [{'PartNumber': n, 'ETag': etag} for n, etag in sorted(parts)]})

    async def abort_multipart(self, key, upload_id):
        """Idempotent (see abort_multipart_sync): True when the upload is gone, False when the abort
        failed and must be retried (the upload reaper does)."""
        try:
            await self.client.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
        except Exception as error:
            if missing_upload(error):
                return True
            log.warning('abort of multipart upload %s for %s failed: %s', upload_id, key, error)
            return False
        return True

    async def delete(self, key):
        await self.client.delete_object(Bucket=self.bucket, Key=key)


def sync_client(settings=None):
    """A boto3 S3 client for `python -m worker`."""
    import boto3
    from botocore.config import Config
    settings = settings or S3Settings.from_env()
    return boto3.client('s3', config=Config(**settings.config_kwargs()), **settings.client_kwargs())
