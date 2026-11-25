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
"""

import os
import resource
import signal
import subprocess

GIB = 1024 ** 3
ADDRESS_SPACE = int(1.5 * GIB)
MAX_OUTPUT_FILE = GIB
PROBE_CPU = 15
PROBE_WALL = 20
DERIVE_CPU = 60
DERIVE_WALL = 90
# the scan child (contract milestone-4 §2.2): ONNX Runtime needs more than 1.5 GiB of address space
SCAN_CPU = 90
SCAN_WALL = 120
SCAN_ADDRESS_SPACE = 2 * GIB

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
    pass


class Failed(Exception):
    def __init__(self, cmd, returncode, stderr, stdout=None):
        super().__init__('{} exited with {}: {}'.format(cmd[0], returncode, (stderr or b'')[-2000:]))
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout


def limiter(cpu_seconds, address_space=ADDRESS_SPACE):
    """A preexec_fn applying the contract's limits in the child."""
    def apply():
        resource.setrlimit(resource.RLIMIT_AS, (address_space, address_space))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_FILE, MAX_OUTPUT_FILE))
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
        address_space=ADDRESS_SPACE):
    """Run `cmd` sandboxed; returns its stdout bytes. Raises Timeout or Failed.
    `new_session` puts it in its own process group, killed as a whole on timeout
    (so tools it starts die with it)."""
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL, stdout=stdout,
        stderr=subprocess.PIPE, cwd=cwd, env=env if env is not None else clean_env(),
        preexec_fn=limiter(cpu_seconds, address_space), start_new_session=new_session, close_fds=True)
    try:
        out, err = proc.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill(proc, new_session)
        proc.communicate()
        raise Timeout('{} timed out after {} s'.format(cmd[0], timeout))
    except BaseException:
        _kill(proc, new_session)
        raise
    if proc.returncode != 0:
        if proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL):
            raise Timeout('{} ran out of CPU time'.format(cmd[0]))
        raise Failed(cmd, proc.returncode, err, out)
    return out


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


def ffmpeg_cmd(*args, input_path=None, input_args=()):
    """ffmpeg with the safety flags; `input_path` is the untrusted upload (demuxer
    whitelist applies), otherwise the caller passes its own `-i pipe:0` input."""
    cmd = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', *FFMPEG_SAFETY, *FFMPEG_THREADS]
    if input_path is not None:
        cmd += [*input_args, '-format_whitelist', FORMAT_WHITELIST, '-i', 'file:' + input_path]
    return cmd + list(args)
