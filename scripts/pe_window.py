#!/usr/bin/env python3
"""Dump app-specific strings in a VA window + imports of both EXEs."""
import pefile, re, sys, struct

def dump_window(fn, lo, hi, min_len=3):
    pe = pefile.PE(fn, fast_load=True)
    for sec in pe.sections:
        raw = sec.get_data()
        base = pe.OPTIONAL_HEADER.ImageBase + sec.VirtualAddress
        for m in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, raw):
            va = base + m.start()
            if lo <= va <= hi:
                s = m.group().decode()
                if len(s) >= 3:
                    print(f"{va:#10x}  {s!r}")

def dump_imports(fn):
    pe = pefile.PE(fn)
    print("=== imports:", fn)
    for e in getattr(pe, "DIRECTORY_ENTRY_IMPORT", []):
        dll = e.dll.decode()
        names = [i.name.decode() for i in e.imports if i.name]
        print(f"  {dll}: {', '.join(names)}")

if __name__ == "__main__":
    fn = sys.argv[1]
    if sys.argv[2] == "imports":
        dump_imports(fn)
    else:
        dump_window(fn, int(sys.argv[2], 0), int(sys.argv[3], 0))
