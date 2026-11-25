"""Executables and malware-style files are never accepted (PLAN.md "Accepted file types").

Three independent checks, so renaming or relabelling a file doesn't get one through:
1. the filename's extension (`setup.exe`, even when sent as application/octet-stream);
2. the declared mimetype (`application/x-msdownload` named `photo.png`);
3. the content itself: the first bytes of every upload are sniffed for executable formats
   (`sniff_executable`), whatever the name and type say.

The mimetype seed (migrations/0002_mimetypes.sql) leaves all of these out as well; these
lists are the explicit refusal on top of "not in the table".
"""

import struct

BLOCKED_EXTENSIONS = frozenset((
    # Windows programs, libraries, installers, scripts and shortcuts
    'exe dll scr com pif cpl msi msp msix msixbundle appx appxbundle bat cmd ps1 psm1 psd1 vbs vbe jse wsf '
    'wsh hta lnk reg inf msc chm scf url application gadget sys drv ocx cab one iqy slk xll xla ppa '
    # mobile, macOS and Linux apps and packages
    'apk xapk aab ipa dmg pkg mpkg app command deb rpm appimage snap flatpakref run '
    # Java, Flash and WebAssembly
    'jar jnlp class swf wasm '
    # disk images
    'iso img vhd vhdx '
    # macro-enabled Office documents
    'docm dotm xlsm xltm xlam pptm potm ppam sldm '
    # certificates and web archives (phishing kits)
    'cer crt p12 pfx mht mhtml'
).split())

BLOCKED_MIMETYPES = frozenset((
    'application/x-msdownload', 'application/x-msdos-program', 'application/x-ms-installer',
    'application/x-msi', 'application/vnd.microsoft.portable-executable', 'application/x-dosexec',
    'application/x-executable', 'application/x-elf', 'application/x-mach-binary', 'application/x-sharedlib',
    'application/java-archive', 'application/x-java-applet', 'application/java-vm',
    'application/vnd.android.package-archive', 'application/x-apple-diskimage', 'application/x-iso9660-image',
    'application/x-sh', 'application/x-bat', 'application/x-msdos-batch', 'application/hta',
    'application/x-ms-shortcut', 'application/vnd.ms-cab-compressed', 'application/x-shockwave-flash',
    'application/wasm', 'application/vnd.ms-word.document.macroenabled.12',
    'application/vnd.ms-excel.sheet.macroenabled.12', 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
))

# How much of the start of a file the sniffer reads. A PE file's "PE\0\0" header sits at the
# offset stored at 0x3C, which real executables keep well inside the first few KiB.
SNIFF_BYTES = 64 * 1024

_MACH_O = (b'\xfe\xed\xfa\xce', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xcf\xfa\xed\xfe')
# Universal (fat) Mach-O binaries and Java .class files share 0xCAFEBABE; both are blocked.
_CAFEBABE = b'\xca\xfe\xba\xbe'
# Windows shell link (.lnk): header size 0x4C, then the LinkCLSID.
_LNK = b'\x4c\x00\x00\x00\x01\x14\x02\x00\x00\x00\x00\x00\xc0\x00\x00\x00\x00\x00\x00\x46'


def sniff_executable(head):
    """The executable format the bytes start with, or None.

    `MZ` alone isn't enough (a text file can start with "MZ"): a Windows PE file must also
    have "PE\\0\\0" at the offset stored at 0x3C.
    """
    head = bytes(head[:SNIFF_BYTES])
    if head[:2] == b'MZ' and len(head) >= 0x40:
        (offset,) = struct.unpack_from('<I', head, 0x3C)
        if 0x40 <= offset <= len(head) - 4 and head[offset:offset + 4] == b'PE\x00\x00':
            return 'windows-pe'
    if head[:4] == b'\x7fELF':
        return 'elf'
    if head[:4] in _MACH_O:
        return 'mach-o'
    if head[:4] == _CAFEBABE:
        return 'mach-o-universal-or-java-class'
    if head[:len(_LNK)] == _LNK:
        return 'windows-shortcut'
    return None


def blocked_name(filename=None, extension=None):
    """True if the filename's last extension, or an explicitly given one, is blocked."""
    candidates = []
    if extension:
        candidates.append(extension)
    if filename and '.' in filename:
        candidates.append(filename.rsplit('.', 1)[-1])
    return any(candidate.strip().lower() in BLOCKED_EXTENSIONS for candidate in candidates)


def blocked_mimetype(mimetype):
    return (mimetype or '').split(';', 1)[0].strip().lower() in BLOCKED_MIMETYPES


# libmagic guesses "DOS executable (COM)" from a handful of opcode-like first bytes, which about 1% of
# random binary data (encrypted or compressed blobs) has. A real DOS or Windows program starts with MZ
# (and sniff_executable catches PE files properly), so that guess alone isn't trusted (milestone-4 §5.1).
_COM_GUESS = 'application/x-dosexec'


def trusted_sniff(mimetype, head):
    """libmagic's type, minus its COM-program guesses on bytes that don't start with MZ."""
    if mimetype == _COM_GUESS and not bytes(head[:2]) == b'MZ':
        return 'application/octet-stream'
    return mimetype
