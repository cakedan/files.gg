"""PDQ helpers (contract milestone-4 §3.4, §3.5). Hashes travel as 64 hex digits and are
stored as `bit(256)`; matching in SQL is `bit_count(pdq # $1) <= 31` (Postgres 14+).

Hashes with quality below 50 are stored but never matched (Meta's guidance)."""

MIN_QUALITY = 50


def to_bits(hex_hash):
    """'cb30...' -> the 256-character '0101...' string Postgres casts to bit(256)."""
    return '{:0256b}'.format(int(hex_hash, 16))


def from_bits(bits):
    return '{:064x}'.format(int(str(bits), 2))


def distance(a, b):
    return bin(int(a, 16) ^ int(b, 16)).count('1')
