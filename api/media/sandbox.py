"""Running untrusted-media tools (contract §2 "Sandbox").

Every subprocess gets, through `preexec_fn`:
- RLIMIT_AS 1.5 GiB (address space), RLIMIT_CPU (60 s, probe 15 s), RLIMIT_CORE 0 (no core
  files) and RLIMIT_FSIZE (no output file over 1 GiB);
- a wall-clock timeout (probe 20 s, derive 90 s), after which its whole process group is killed;
- a scrubbed environment: no secrets (S3 keys, DATABASE_URL) reach the parsers, so a
  crafted file that makes a tool read /proc/self/environ finds nothing.

ffmpeg and ffprobe always get `-nostdin` (ffmpeg) and `-protocol_whitelist file,pipe`, plus
a demuxer whitelist (`-format_whitelist`), so a playlist (HLS, concat, ...) can't make them
open URLs or other local files. Pillow runs in the sandboxed child process too
(`python -m media.process`), with its decompression-bomb limit left on.

Conversions (contract milestone-5 §3.1, §7.3) run under the same rules with their own limits:
3 GiB of address space (video encoders need more than 1.5 GiB), the job's CPU budget as
RLIMIT_CPU, the caller's max file size as RLIMIT_FSIZE, `CONVERT_THREADS` threads, and
`die_with_parent`: every tool gets SIGKILL when the process that started it dies, so killing a
work horse (its time limit, a cancel, the OOM killer) takes the tools it started with it.
"""

import ctypes
import math
import os
import resource
import signal
import subprocess
import threading

GIB = 1024 ** 3
ADDRESS_SPACE = int(1.5 * GIB)
MAX_OUTPUT_FILE = GIB
PROBE_CPU = 15
PROBE_WALL = 20
DERIVE_CPU = 60
DERIVE_WALL = 90
# the scan child (contract milestone-4 §2.2). 2 GiB was set for ONNX Runtime (over 1.5 GiB of address space), which
# runs in the scan job since milestone-7 §7; measure the child's own peak before lowering it
SCAN_CPU = 90
SCAN_WALL = 120
SCAN_ADDRESS_SPACE = 2 * GIB

# Milestone 5 (contract milestone-5 §3.1, §7.3): conversions
CONVERT_ADDRESS_SPACE = 3 * GIB
# a conversion's CPU limit is the smaller of its time limit and the caller's budget left today, at least this
CONVERT_MIN_CPU = 5

# ffmpeg demuxers allowed to read uploads: real containers only. Not hls, dash, concat,
# image2 (patterns), tee, ... anything that opens other files or URLs by itself.
FORMAT_WHITELIST = ','.join((
    'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'flv', 'mpegts', 'mpeg', 'mpegvideo',
    'ogg', 'mp3', 'wav', 'w64', 'flac', 'aac', 'asf', 'aiff', 'ape', 'caf', 'amr', 'wv', 'tta', 'dsf', 'au',
    'h264', 'hevc', 'm4v', 'ivf', 'gif', 'mpc', 'mpc8', 'opus', 'rawvideo', 'nut', 'mxf', 'rm', 'smjpeg',
))
FFMPEG_SAFETY = ['-protocol_whitelist', 'file,pipe']
# keep the thread count (and with it glibc's per-thread arenas) inside the address-space limit
FFMPEG_THREADS = ['-threads', '2', '-filter_threads', '1']


class Timeout(Exception):
    """The wall clock ran out, or the CPU limit (`cpu` is True then)."""

    def __init__(self, message, cpu=False):
        super().__init__(message)
        self.cpu = cpu


class Failed(Exception):
    def __init__(self, cmd, returncode, stderr, stdout=None):
        super().__init__('{} exited with {}: {}'.format(cmd[0], returncode, (stderr or b'')[-2000:]))
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout


# prctl(2): PR_SET_PDEATHSIG. Linux only, like the rest of the sandbox.
PR_SET_PDEATHSIG = 1
_libc = ctypes.CDLL(None, use_errno=True)


def _set(which, soft, hard):
    """setrlimit, never above the limit this process already has: a tool started inside a sandboxed child (the
    conversion child's ffprobe, pdfinfo) inherits the child's hard limits and can't raise them, so asking for more
    (a default 1 GiB file size under a caller's 1,000,000,000-byte cap) would fail the whole run. Nested sandboxes
    only ever tighten."""
    _, current = resource.getrlimit(which)
    if current != resource.RLIM_INFINITY:
        hard = min(hard, current)
        soft = min(soft, hard)
    resource.setrlimit(which, (soft, hard))


def limiter(cpu_seconds, address_space=ADDRESS_SPACE, max_file=MAX_OUTPUT_FILE, die_with_parent=False):
    """A preexec_fn applying the contract's limits in the child."""
    cpu_seconds = max(1, int(math.ceil(cpu_seconds)))
    parent = os.getpid()

    def apply():
        _set(resource.RLIMIT_AS, address_space, address_space)
        _set(resource.RLIMIT_CPU, cpu_seconds, cpu_seconds + 1)
        _set(resource.RLIMIT_CORE, 0, 0)
        _set(resource.RLIMIT_FSIZE, max_file, max_file)
        if die_with_parent:
            _libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
            if os.getppid() != parent:  # the parent died before prctl: nobody would kill us
                os._exit(1)
    return apply


def clean_env(**extra):
    env = {
        'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
        'LANG': 'C.UTF-8',
        'LC_ALL': 'C.UTF-8',
        'PYTHONDONTWRITEBYTECODE': '1',
        'PYTHONUNBUFFERED': '1',
    }
    env.update({k: v for k, v in extra.items() if v is not None})
    return env


def run(cmd, timeout, cpu_seconds, input=None, cwd=None, env=None, new_session=True, stdout=subprocess.PIPE,
        address_space=ADDRESS_SPACE, max_file=MAX_OUTPUT_FILE, die_with_parent=False, on_line=None,
        return_stderr=False):
    """Run `cmd` sandboxed; returns its stdout bytes. Raises Timeout or Failed.
    `new_session` puts it in its own process group, killed as a whole on timeout
    (so tools it starts die with it).

    Conversions also stream (milestone-5 §8): `input` may be an iterable of byte chunks written
    as the tool reads them (frames for ffmpeg), and `on_line` is called with each stdout line as
    it arrives (progress), from a reader thread. `return_stderr` returns (stdout, stderr), for a tool
    whose measurements are on stderr (loudnorm); the caller keeps them to itself (§0)."""
    streaming = on_line is not None or (input is not None and not isinstance(input, (bytes, bytearray)))
    cpu_before = _children_cpu()
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL, stdout=stdout,
        stderr=subprocess.PIPE, cwd=cwd, env=env if env is not None else clean_env(),
        preexec_fn=limiter(cpu_seconds, address_space, max_file, die_with_parent), start_new_session=new_session,
        close_fds=True)
    try:
        if streaming:
            out, err = _stream(proc, input, on_line, timeout)
        else:
            out, err = proc.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(proc, new_session)
        if streaming:
            proc.wait()  # its reader threads end at EOF
        else:
            proc.communicate()
        raise Timeout('{} timed out after {} s'.format(cmd[0], timeout))
    except BaseException:
        _kill(proc, new_session)
        # reaped, so its CPU time is counted where it ran (milestone-5 §7.3)
        _reap(proc)
        raise
    if proc.returncode != 0:
        # ffmpeg catches SIGXCPU and exits with an error of its own: a tool that used its whole CPU limit ran out
        if proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL) or \
                _children_cpu() - cpu_before >= int(math.ceil(cpu_seconds)) - 0.5:
            raise Timeout('{} ran out of CPU time'.format(cmd[0]), cpu=True)
        raise Failed(cmd, proc.returncode, err, out)
    return (out, err) if return_stderr else out


def _children_cpu():
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    return usage.ru_utime + usage.ru_stime


def _stream(proc, chunks, on_line, timeout):
    """communicate() for streamed input and line-by-line output. Raises TimeoutExpired, or
    what the input iterable raised (other than the tool closing its stdin)."""
    out, err, failures = [], [], []
    if isinstance(chunks, (bytes, bytearray)):
        chunks = [chunks]

    def feed():
        try:
            for chunk in chunks:
                proc.stdin.write(chunk)
        except (BrokenPipeError, ValueError):
            pass  # the tool stopped reading (it failed, or was killed): its exit status says why
        except BaseException as error:
            failures.append(error)
        finally:
            try:
                proc.stdin.close()
            except (BrokenPipeError, ValueError):
                pass

    def read_lines():
        for line in proc.stdout:
            out.append(line)
            if on_line is not None:
                try:
                    on_line(line)
                except Exception:
                    pass  # progress is best effort; the result still arrives

    def read_err():
        err.append(proc.stderr.read())

    threads = [threading.Thread(target=read_err, daemon=True)]
    if proc.stdout is not None:
        threads.append(threading.Thread(target=read_lines, daemon=True))
    if chunks is not None:
        threads.append(threading.Thread(target=feed, daemon=True))
    for thread in threads:
        thread.start()
    proc.wait(timeout=timeout)
    for thread in threads:
        thread.join(5)
    if failures:
        raise failures[0]
    return b''.join(out), b''.join(err)


def _reap(proc):
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _kill(proc, group):
    try:
        if group:
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except (ProcessLookupError, PermissionError):
        pass


def ffprobe_cmd(path):
    return ['ffprobe', '-v', 'error', *FFMPEG_SAFETY, '-format_whitelist', FORMAT_WHITELIST,
            '-print_format', 'json', '-show_format', '-show_streams', 'file:' + path]


def ffmpeg_cmd(*args, input_path=None, input_args=(), threads=None, loglevel='error'):
    """ffmpeg with the safety flags; `input_path` is the untrusted upload (demuxer
    whitelist applies), otherwise the caller passes its own `-i pipe:0` input. `threads` is a
    conversion's thread budget (milestone-5 §3.1), else FFMPEG_THREADS."""
    thread_args = FFMPEG_THREADS if threads is None else ['-threads', str(threads), '-filter_threads', '1']
    cmd = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', loglevel, '-y', *FFMPEG_SAFETY, *thread_args]
    if input_path is not None:
        cmd += [*input_args, '-format_whitelist', FORMAT_WHITELIST, '-i', 'file:' + input_path]
    return cmd + list(args)


# --- the thread budget (milestone-5 §3.1, notsobot's `cpu_budget`) ------------------------------

def usable_cpus():
    """The cores this process may run on: its affinity, then a cgroup v2 quota
    (`200000 100000` is 2), not the host's count."""
    try:
        count = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        count = os.cpu_count() or 1
    try:
        with open('/sys/fs/cgroup/cpu.max', encoding='ascii') as handle:
            quota, period = handle.read().split()[:2]
        if quota != 'max':
            count = min(count, max(math.ceil(int(quota) / int(period)), 1))
    except (OSError, ValueError):
        pass
    return max(count, 1)


def convert_threads():
    """Threads one conversion may use: CONVERT_THREADS, else the service's cpus divided by its
    processes (CONVERT_PROCESSES), at least 1. ffmpeg gets it as -threads; Pillow, libvips and
    OpenMP through convert_env()."""
    try:
        value = int(os.getenv('CONVERT_THREADS', ''))
    except ValueError:
        value = 0
    if value > 0:
        return value
    try:
        processes = max(1, int(os.getenv('CONVERT_PROCESSES', '1')))
    except ValueError:
        processes = 1
    return max(1, usable_cpus() // processes)


def convert_env(**extra):
    """clean_env() plus the thread budget, for a conversion's children."""
    threads = str(convert_threads())
    return clean_env(OMP_NUM_THREADS=threads, VIPS_CONCURRENCY=threads, **extra)
