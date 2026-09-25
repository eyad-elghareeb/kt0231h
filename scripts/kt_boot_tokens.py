#!/usr/bin/env python3
"""kt_boot_tokens.py — hunt for boot-protocol command tokens in vendor EXEs.

Scans the .rdata/.text of a KTMicro vendor PE for 4-byte u32 LE constants
that look like the known boot token families:
  KTM = 1E 4B 54 4D | VER = F0 56 45 52 | KEY = F0 4B 45 59
  CHP = D2 43 48 50 | CID = 2D 43 49 44 | RAM = 69 52 41 4D
  CFG = 2D xx ...   | PWO = 3C 50 57 4F | KSTA = 4B 53 54 41 | STP = 96 53 54 50
and prints every hit with ASCII rendering + neighbouring 16 bytes, so new
tokens (read/verify/erase?) can be spotted in context.

Usage: python3 kt_boot_tokens.py <vendor.exe> [more.exe ...]
"""
import re
import struct
import sys
from pathlib import Path

KNOWN = {
    b'\x1e\x4b\x54\x4d': 'KTM sync',
    b'\xf0\x56\x45\x52': 'VER',
    b'\xf0\x4b\x45\x59': 'KEY',
    b'\xd2\x43\x48\x50': 'CHP',
    b'\x2d\x43\x49\x44': 'CID',
    b'\x69\x52\x41\x4d': 'RAM',
    b'\x3c\x50\x57\x4f': 'PWO',
    b'\x4b\x53\x54\x41': 'KSTA',
    b'\x96\x53\x54\x50': 'STP',
}

# candidate token = 4 bytes: first byte in {F0,D2,2D,3C,4B,96,69,1E,0x?} and
# remaining 3 bytes all printable-uppercase-ish (letters/digits)
CAND = re.compile(rb'[\xf0\xd2\x2d\x3c\x4b\x96\x69\x1e\x8c\xa5\x5a\x78]([A-Za-z]{3})')
ASCII4 = re.compile(rb'[A-Za-z0-9_]{4}')


def asciiish(b):
    return all(0x20 <= c < 0x7f for c in b)


def scan(path: Path):
    data = path.read_bytes()
    print(f'== {path.name} ({len(data):,} B) ==')

    found = {}
    for tok, name in KNOWN.items():
        start = 0
        while True:
            i = data.find(tok, start)
            if i < 0:
                break
            found.setdefault(name, []).append(i)
            start = i + 1
    for name, offs in sorted(found.items()):
        print(f'  KNOWN {name:5s} ×{len(offs)}: ' +
              ', '.join(hex(o) for o in offs[:8]))

    # candidate (non-known) tokens: 4 printable bytes preceded by 0x00 u32
    # alignment OR first-byte-in-token-prefix-set, rendered for eyeballing
    cands = {}
    for m in CAND.finditer(data):
        b = m.group(0)
        if b in KNOWN:
            continue
        if not asciiish(b[1:]) or b[1:].islower() and b[1:].upper() == b[1:]:
            pass
        cands.setdefault(b, []).append(m.start())
    # keep only tokens seen >=2 times (constants repeat; random text doesn't)
    interesting = {t: o for t, o in cands.items() if len(o) >= 2}
    for tok, offs in sorted(interesting.items(), key=lambda kv: -len(kv[1]))[:40]:
        ctx = data[offs[0] - 8: offs[0] + 12]
        print(f'  CAND  {tok.hex()} "{tok[1:].decode("ascii", "replace")}" ×{len(offs)} '
              f'@{hex(offs[0])} ctx={ctx.hex()}')
    print()


if __name__ == '__main__':
    for a in sys.argv[1:]:
        p = Path(a)
        if p.exists():
            scan(p)
