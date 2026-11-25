"""The converter's side of the `office` service (contract milestone-5 §3.2): LibreOffice runs only in its own
network-less container, fed through the shared tmpfs spool (`OFFICE_SPOOL_DIR`, the `office-spool` volume).

1. The converter writes `<spool>/new/<uuid>/input.<ext>` and `request.json`
   (`{"filter": "pdf", "timeout": 120, "max_pages": 500}`), then renames the directory into `<spool>/queue/<uuid>`
   (atomic: the daemon never sees half a job).
2. The daemon (api/office/daemon.py) claims it into `work/`, converts it, and renames it to `done/<uuid>` with
   `output.pdf` and `result.json` (`{"ok": true, "pages": n}` or `{"ok": false, "reason": ...}`).
3. The converter waits for `done/<uuid>` up to `timeout + 15 s`, takes the PDF, and always deletes its directories.

The spool's root is the access gate (mode 0770, owned by the uid the converter and the daemon share, §3.2), so the
job's own directory and files are left open to that uid's group and others: the tests write as root and the daemon
must still read and delete them.
"""

import json
import os
import shutil
import time
import uuid

SPOOL_DIR = os.getenv('OFFICE_SPOOL_DIR', '/spool')
TIMEOUT = int(os.getenv('OFFICE_TIMEOUT', '120'))
# how long past the daemon's own timeout the converter waits (§3.2)
GRACE = 15
POLL = 0.2
EXTENSIONS = frozenset(('docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf'))
# the extension LibreOffice is given for each document type (§1.1); the upload's own extension isn't trusted
MIMETYPE_EXTENSIONS = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
    'application/rtf': 'rtf',
}
REASONS = ('timeout', 'failed', 'too_many_pages')


class OfficeError(Exception):
    """The daemon couldn't make the PDF: `reason` is one of REASONS, or `unavailable` when no daemon answered."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def convert(input_path, extension, out_path, timeout=TIMEOUT, max_pages=500, spool=None):
    """Convert `input_path` (a document of type `extension`) to a PDF at `out_path`. Returns its page count.
    Raises OfficeError."""
    spool = spool or SPOOL_DIR
    if extension not in EXTENSIONS:
        raise OfficeError('failed')
    job = uuid.uuid4().hex
    new = os.path.join(spool, 'new', job)
    paths = [new] + [os.path.join(spool, name, job) for name in ('queue', 'work', 'done')]
    try:
        os.mkdir(new)
        os.chmod(new, 0o777)
        target = os.path.join(new, 'input.' + extension)
        shutil.copyfile(input_path, target)
        os.chmod(target, 0o666)
        request = os.path.join(new, 'request.json')
        with open(request, 'w') as handle:
            json.dump({'filter': 'pdf', 'timeout': int(timeout), 'max_pages': int(max_pages)}, handle)
        os.chmod(request, 0o666)
        os.rename(new, paths[1])
        done = paths[3]
        deadline = time.monotonic() + timeout + GRACE
        while not os.path.isdir(done):
            if time.monotonic() > deadline:
                raise OfficeError('unavailable')
            time.sleep(POLL)
        try:
            with open(os.path.join(done, 'result.json')) as handle:
                result = json.load(handle)
        except (OSError, ValueError):
            raise OfficeError('failed')
        if not result.get('ok'):
            reason = result.get('reason')
            raise OfficeError(reason if reason in REASONS else 'failed')
        shutil.copyfile(os.path.join(done, 'output.pdf'), out_path)
        pages = result.get('pages')
        return pages if isinstance(pages, int) and pages > 0 else None
    finally:
        for path in paths:
            shutil.rmtree(path, ignore_errors=True)
