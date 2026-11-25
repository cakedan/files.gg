"""The `office` service's daemon (contract milestone-5 §3.2): LibreOffice, with no network at all.

    python3 /office/daemon.py

Standard library only: it runs on the office image's system python3, next to nothing but LibreOffice and fonts.
The container has no network (`network_mode: none`), a read-only root, tmpfs for /tmp, no capabilities, and shares
only the spool (`OFFICE_SPOOL_DIR`, a tmpfs volume) with the converter services:

- the converter renames a job into `queue/<uuid>` (`input.<ext>` and `request.json`);
- a daemon process claims it by renaming it into `work/<uuid>` (one rename wins), runs
  `soffice --headless ... --convert-to pdf` on it with a fresh profile under /tmp, under RLIMIT_CPU, RLIMIT_AS and a
  wall clock that kills soffice's whole process group, then writes `output.pdf` and `result.json`
  (`{"ok": true, "pages": n}` or `{"ok": false, "reason": "timeout" | "failed" | "too_many_pages"}`) and renames
  it to `done/<uuid>`;
- the parent keeps OFFICE_PROCESSES of those (one job at a time each), and deletes anything older than 10 minutes
  in any spool directory.

The LibreOffice settings copied into each profile (registrymodifications.xcu next to this file) turn off macros,
link updates, external images, recalculation on load and auto-save; the missing network is the real guarantee.
"""

import json
import os
import re
import resource
import shutil
import signal
import subprocess
import sys
import time

SPOOL = os.environ.get('OFFICE_SPOOL_DIR', '/spool')
PROCESSES = max(1, int(os.environ.get('OFFICE_PROCESSES', '2')))
# the most a request may ask for (§14 OFFICE_TIMEOUT)
MAX_TIMEOUT = max(1, int(os.environ.get('OFFICE_TIMEOUT', '120')))
DIRECTORIES = ('new', 'queue', 'work', 'done')
POLL = 0.2
MAX_AGE = 10 * 60
CLEAN_EVERY = 60
# LibreOffice maps far more than it uses; the container's mem_limit is the real cap on memory
ADDRESS_SPACE = 4 * 1024 ** 3
EXTENSIONS = frozenset(('docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf'))
REQUEST_BYTES = 4096
SOFFICE = 'soffice'
SETTINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'registrymodifications.xcu')
PROFILE_ROOT = '/tmp'
# the page tree's /Count (the root /Pages node holds the total), else the /Page objects
PAGES_COUNT = re.compile(rb'/Type\s*/Pages\b[^>]*?/Count\s+(\d+)|/Count\s+(\d+)[^>]*?/Type\s*/Pages\b', re.S)
PAGE_OBJECT = re.compile(rb'/Type\s*/Page(?![a-zA-Z])')

_stopping = False


def log(message, *args):
    sys.stderr.write('office: ' + (message % args if args else message) + '\n')
    sys.stderr.flush()


def ensure_spool(spool=None):
    spool = spool or SPOOL
    for name in DIRECTORIES:
        path = os.path.join(spool, name)
        os.makedirs(path, exist_ok=True)
        os.chmod(path, 0o770)


# --- one job -----------------------------------------------------------------------------------------------------------

def read_request(directory):
    """(input path, extension, timeout, max_pages) from a job directory, or None when it isn't a valid job."""
    try:
        with open(os.path.join(directory, 'request.json'), 'rb') as handle:
            request = json.loads(handle.read(REQUEST_BYTES))
    except (OSError, ValueError):
        return None
    if not isinstance(request, dict) or request.get('filter') != 'pdf':
        return None
    timeout, max_pages = request.get('timeout'), request.get('max_pages')
    if not isinstance(timeout, int) or not isinstance(max_pages, int) or timeout < 1 or max_pages < 1:
        return None
    inputs = [name for name in os.listdir(directory) if name.startswith('input.')]
    if len(inputs) != 1:
        return None
    extension = inputs[0].split('.', 1)[1]
    if extension not in EXTENSIONS:
        return None
    return os.path.join(directory, inputs[0]), extension, min(timeout, MAX_TIMEOUT), max_pages


def count_pages(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    counts = [int(a or b) for a, b in PAGES_COUNT.findall(data)]
    if counts:
        return max(counts)
    return len(PAGE_OBJECT.findall(data))


def limits(timeout):
    def apply():
        resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout + 1))
        resource.setrlimit(resource.RLIMIT_AS, (ADDRESS_SPACE, ADDRESS_SPACE))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


def soffice(input_path, outdir, profile, timeout):
    """Run LibreOffice on one document in its own process group; 'timeout' if the wall clock or the CPU limit ran
    out (the whole group is killed), else its exit status."""
    os.makedirs(os.path.join(profile, 'user'), exist_ok=True)
    shutil.copyfile(SETTINGS, os.path.join(profile, 'user', 'registrymodifications.xcu'))
    cmd = [SOFFICE, '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--nofirststartwizard',
           '-env:UserInstallation=file://' + profile, '--convert-to', 'pdf', '--outdir', outdir, input_path]
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': profile, 'TMPDIR': profile,
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'SAL_USE_VCLPLUGIN': 'svp'}
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env=env, cwd=profile, preexec_fn=limits(timeout), start_new_session=True, close_fds=True)
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        code = 'timeout'
    finally:
        kill_group(proc.pid)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    if code in (-signal.SIGXCPU, -signal.SIGKILL):
        return 'timeout'
    return code


def kill_group(pgid):
    """soffice starts helpers (oosplash, soffice.bin): the whole group goes."""
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def convert(directory):
    """Convert the job in `directory` (in work/); returns its result."""
    request = read_request(directory)
    if request is None:
        return {'ok': False, 'reason': 'failed'}
    input_path, extension, timeout, max_pages = request
    profile = os.path.join(PROFILE_ROOT, 'lo-' + os.path.basename(directory))
    try:
        code = soffice(input_path, directory, profile, timeout)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    produced = os.path.join(directory, 'input.pdf')
    try:
        os.unlink(input_path)
    except OSError:
        pass
    if code == 'timeout':
        _discard(produced)
        return {'ok': False, 'reason': 'timeout'}
    if code != 0 or not os.path.isfile(produced) or os.path.getsize(produced) == 0:
        _discard(produced)
        return {'ok': False, 'reason': 'failed'}
    pages = count_pages(produced)
    if pages < 1:
        _discard(produced)
        return {'ok': False, 'reason': 'failed'}
    if pages > max_pages:
        _discard(produced)
        return {'ok': False, 'reason': 'too_many_pages'}
    os.replace(produced, os.path.join(directory, 'output.pdf'))
    return {'ok': True, 'pages': pages}


def _discard(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def finish(directory, result, spool=None):
    spool = spool or SPOOL
    path = os.path.join(directory, 'result.json')
    with open(path, 'w') as handle:
        json.dump(result, handle)
    os.chmod(path, 0o666)
    os.rename(directory, os.path.join(spool, 'done', os.path.basename(directory)))


def claim(spool=None):
    """The oldest queued job, moved into work/ (another daemon process may win the rename), or None."""
    spool = spool or SPOOL
    queue = os.path.join(spool, 'queue')
    try:
        names = sorted(os.listdir(queue), key=lambda n: _mtime(os.path.join(queue, n)))
    except OSError:
        return None
    for name in names:
        if not re.fullmatch(r'[0-9a-f]{32}', name):
            continue
        work = os.path.join(spool, 'work', name)
        try:
            os.rename(os.path.join(queue, name), work)
            return work
        except OSError:
            continue
    return None


def _mtime(path):
    try:
        return os.stat(path).st_mtime
    except OSError:
        return 0


def run_one(spool=None):
    """Claim and convert one job; False when the queue was empty."""
    directory = claim(spool)
    if directory is None:
        return False
    try:
        result = convert(directory)
    except Exception as error:  # a broken job never stops the daemon
        log('job %s failed: %s', os.path.basename(directory), type(error).__name__)
        result = {'ok': False, 'reason': 'failed'}
    try:
        finish(directory, result, spool)
    except OSError:
        # the converter gave up on it and deleted it
        shutil.rmtree(directory, ignore_errors=True)
    return True


def clean(spool=None, max_age=MAX_AGE, now=None):
    """Delete anything older than `max_age` seconds in any spool directory (a converter that died mid-wait, a job
    nobody collected). Returns how many entries went."""
    spool = spool or SPOOL
    now = time.time() if now is None else now
    removed = 0
    for name in DIRECTORIES:
        root = os.path.join(spool, name)
        try:
            entries = os.listdir(root)
        except OSError:
            continue
        for entry in entries:
            path = os.path.join(root, entry)
            if now - _mtime(path) > max_age:
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    _discard(path)
                removed += 1
    return removed


# --- the processes -----------------------------------------------------------------------------------------------------

def work_loop():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    while True:
        if not run_one():
            time.sleep(POLL)


def start_worker():
    pid = os.fork()
    if pid == 0:
        try:
            work_loop()
        finally:
            os._exit(0)
    return pid


def main():
    ensure_spool()
    workers = {start_worker() for _ in range(PROCESSES)}

    def stop(*_):
        global _stopping
        _stopping = True
        for pid in workers:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log('started %d processes on %s', PROCESSES, SPOOL)
    last_clean = 0.0
    while workers:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid in workers:
            workers.discard(pid)
            if not _stopping:
                log('process %d exited; starting another', pid)
                workers.add(start_worker())
        elif pid == 0:
            if not _stopping and time.monotonic() - last_clean > CLEAN_EVERY:
                last_clean = time.monotonic()
                clean()
            time.sleep(POLL)
    return 0


if __name__ == '__main__':
    sys.exit(main())
