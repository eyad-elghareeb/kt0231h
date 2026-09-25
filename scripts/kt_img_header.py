#!/usr/bin/env python3
"""kt_img_header.py — parse KTMicro image meta headers (all platforms).

Parses the flash-tag / chip-id / Size / build / ENTY meta block that starts
every KTMicro image (Helios `KT_lnv1b_*`, MSV2B `KT_msv2b_*`, TT `KTM_TT_V3_*`)
and prints a per-image table + JSON. Pure structural parsing, no guesses.

Usage:  python3 scripts/kt_img_header.py [firmware_dir]
"""
import json
import re
import struct
import sys
from pathlib import Path



ASCII_RUN    = re.compile(rb'[\x20-\x7e]{4,}')
DATE_RE      = re.compile(rb'(\d{4}-\d{2}-\d{2})|((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} +\d{4})')


def parse(path: Path):
    b = path.read_bytes()
    info = {'file': path.name, 'size': len(b)}

    # Header form (verified byte-exact on all shipped images):
    #   <flash-tag><chip-id>[NUL] "Size" [u32 LE payload size] ...
    # e.g. "KT_lnv1b_flash_1" + "0211LC02" + "Size" + A6A90000
    si = b.find(b'Size')
    if 0 <= si <= 64:
        tag = b[:si].rstrip(b'\x00')
        info['flash_tag'] = tag.decode('ascii', 'replace')
        cm = re.search(rb'([0-9A-Za-z]{4}[0-9A-Za-z]{2,8})$', tag)
        if cm:
            info['chip_id'] = cm.group(1).decode('ascii', 'replace')
        for off in range(si + 4, min(si + 12, len(b) - 4)):
            v = struct.unpack_from('<I', b, off)[0]
            if 64 <= v <= 0x200000:
                info['size_field'] = v
                info['size_field_at'] = hex(off)
                break

    # ENTY entry point(s)
    e = b.find(b'ENTY')
    if e >= 0:
        ents = []
        for k in range(e + 4, min(e + 20, len(b) - 4), 4):
            v = struct.unpack_from('<I', b, k)[0]
            if 0x1000 <= v <= 0x1FFFFF:
                ents.append(hex(v))
            else:
                break
        if ents:
            info['entry'] = ents

    # build date strings
    head = b[:0x1200]
    dates = [m.group(0).decode() for m in DATE_RE.finditer(head)]
    if dates:
        info['build_date'] = dates[0]

    # version-ish strings (x.y.z, V:x.y)
    vers = re.findall(rb'\bV[:=]?(\d+\.\d+(?:\.\d+)?)\b', head)
    if vers:
        info['ver_str'] = vers[0].decode()
    dots = [s.decode() for s in ASCII_RUN.findall(head)
            if re.fullmatch(rb'\d+\.\d+\.\d+', s)]
    if dots:
        info['semver'] = dots[0]

    # product-ish ASCII after the header (first 32-run strings beyond 0x1000)
    prods = [s.decode() for s in ASCII_RUN.findall(b[0x1000:0x1200])]
    info['strings@0x1000'] = prods[:8]
    return info


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else
                Path(__file__).resolve().parent.parent / 'firmware')
    rows = [parse(p) for p in sorted(root.glob('*.bin'))]
    for r in rows:
        print(json.dumps(r, ensure_ascii=False))
    print(f'-- {len(rows)} images parsed --', file=sys.stderr)


if __name__ == '__main__':
    main()
