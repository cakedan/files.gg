"""ClamAV through clamd's INSTREAM command (contract milestone-4 §5.2), from the scan job
process (the scanner and rescanner services; only they reach the `clamav` service).

The blob is streamed with `zINSTREAM\\0`: 64 KiB chunks, each prefixed by its 4-byte
big-endian length, then a zero-length chunk. `stream: OK` is clean, `stream: <name> FOUND`
is a detection; anything else, or a timeout (CLAMAV_TIMEOUT), raises ClamAVUnavailable,
which keeps the hash pending (a required check, §2.6).

Signatures are ClamAV's official databases only, through the image's own freshclam (§5.2);
YARA rules from clamav/rules/ are loaded by clamd itself.
"""

import socket
import struct

CHUNK = 64 * 1024


class ClamAVUnavailable(Exception):
    pass


class ClamAV:
    def __init__(self, host, port, timeout=120.0):
        self.host = host
        self.port = port
        self.timeout = timeout

    @classmethod
    def from_settings(cls, settings):
        return cls(settings.clamav_host, settings.clamav_port, settings.clamav_timeout)

    def _connect(self):
        try:
            return socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as error:
            raise ClamAVUnavailable('cannot reach clamd at {}:{}: {}'.format(self.host, self.port, error))

    def _command(self, command):
        with self._connect() as sock:
            sock.sendall(b'z' + command + b'\0')
            return _read_reply(sock)

    def version(self):
        """'ClamAV 1.5.5/27512/...' -> {"engine": "1.5.5", "db": "daily 27512"}."""
        reply = self._command(b'VERSION')
        parts = reply.split('/')
        engine = parts[0].replace('ClamAV', '').strip() if parts else None
        db = 'daily {}'.format(parts[1].strip()) if len(parts) > 1 else None
        return {'engine': engine, 'db': db}

    def scan_file(self, path):
        """None when clean, else the signature name."""
        try:
            with self._connect() as sock, open(path, 'rb') as handle:
                sock.sendall(b'zINSTREAM\0')
                while True:
                    chunk = handle.read(CHUNK)
                    if not chunk:
                        break
                    sock.sendall(struct.pack('>I', len(chunk)) + chunk)
                sock.sendall(struct.pack('>I', 0))
                reply = _read_reply(sock)
        except OSError as error:
            raise ClamAVUnavailable('clamd stream failed: {}'.format(error))
        return parse_reply(reply)


def _read_reply(sock):
    data = bytearray()
    while True:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            raise ClamAVUnavailable('clamd timed out')
        if not chunk:
            break
        data += chunk
        if data.endswith(b'\0'):
            break
    return data.rstrip(b'\0').decode('utf-8', 'replace').strip()


def parse_reply(reply):
    if reply == 'stream: OK':
        return None
    if reply.startswith('stream: ') and reply.endswith(' FOUND'):
        name = reply[len('stream: '):-len(' FOUND')].strip()
        if name:
            return name
    raise ClamAVUnavailable('unexpected clamd reply: {!r}'.format(reply[:200]))


# with `AlertExceedsMax yes` (clamd.conf), content past MaxFiles, MaxRecursion, MaxFileSize,
# MaxScanSize or MaxScanTime is reported as `Heuristics.Limits.Exceeded.<Limit>` instead of `OK`
LIMITS_EXCEEDED_PREFIX = 'Heuristics.Limits.Exceeded'
PARTIALLY_SCANNED = 'archive_partially_scanned'


def classify(signature, flag_only_prefixes):
    """What a detection means (§5.2, §5.3):
    - `Heuristics.Limits.Exceeded.*` -> 'archive_partially_scanned': clamd stopped at one of its
      limits, so the file was scanned partially. A warning only, like an archive over 10,000 entries
      (§5.8), never a finding: it isn't unwanted software;
    - a prefix in `flag_only_prefixes` (PUA.*, Heuristics.*) -> 'unwanted_software' (flag);
    - anything else -> 'malware' (block)."""
    if signature.startswith(LIMITS_EXCEEDED_PREFIX):
        return PARTIALLY_SCANNED
    if any(signature.startswith(prefix) for prefix in flag_only_prefixes):
        return 'unwanted_software'
    return 'malware'
