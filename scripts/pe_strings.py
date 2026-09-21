#!/usr/bin/env python3
"""PE tool: extract strings with VAs + find push-imm32 xrefs in .text."""
import pefile, struct, sys, json, re

def load(fn):
    pe = pefile.PE(fn, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT'],
                                           pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    return pe

def va_of_rva(pe, rva):
    return pe.OPTIONAL_HEADER.ImageBase + rva

def strings_with_va(fn, min_len=5):
    pe = load(fn)
    data = pe.__data__
    out = []
    for sec in pe.sections:
        name = sec.Name.decode(errors="replace").rstrip("\x00")
        raw = sec.get_data()
        # ascii strings
        for m in re.finditer(rb"[\x20-\x7e]{%d,}" % min_len, raw):
            va = va_of_rva(pe, sec.VirtualAddress + m.start())
            out.append((name, va, m.group().decode()))
        # utf16 strings
        for m in re.finditer(rb"(?:[\x20-\x7e]\x00){%d,}" % min_len, raw):
            va = va_of_rva(pe, sec.VirtualAddress + m.start())
            out.append((name, va, m.group().decode("utf-16le")))
    return pe, out

def xrefs_to_va(pe, text_data, text_va, target_va):
    """find push imm32 / mov reg, imm32 of target_va in .text"""
    pat = struct.pack("<I", target_va)
    refs = []
    i = text_data.find(pat)
    while i != -1:
        # check preceding byte for push (0x68) or mov (0xB8-0xBF)
        prev = text_data[i-1]
        kind = "push" if prev == 0x68 else ("mov" if 0xB8 <= prev <= 0xBF else "ref")
        refs.append((text_va + i - 1, kind))
        i = text_data.find(pat, i + 1)
    return refs

if __name__ == "__main__":
    fn = sys.argv[1]
    pe, strs = strings_with_va(fn)
    # dedupe by string keeping first VA
    seen = {}
    for sec, va, s in strs:
        if s not in seen:
            seen[s] = (sec, va)
    print(f"total unique strings: {len(seen)}")
    json.dump([[s, v[0], hex(v[1])] for s, v in seen.items()],
              open(sys.argv[2], "w"))
    # interesting patterns
    pats = [r"KTM", r"VER", r"KEY", r"CHP", r"PWO", r"STA", r"STP", r"ENTY",
            r"flash", r"Flash", r"erase", r"Erase", r"Erase", r"bin", r"BIN",
            r"volume", r"Volume", r"VOL", r"PGA", r"EQ", r"reg", r"Reg", r"REG",
            r"0x4B", r"\\\\.\\", r"HID", r"Vid", r"PID", r"vid_", r"pid_",
            r"CRC", r"crc", r"key", r"Key", r"boot", r"Boot", r"BOOT",
            r"KT02", r"KT0231", r"KT0211", r"0211", r"version", r"Version",
            r"write", r"Write", r"read", r"Read", r"verify", r"Verify"]
    seenpat = set()
    for s, (sec, va) in sorted(seen.items(), key=lambda kv: kv[1][1]):
        for p in pats:
            if re.search(p, s) and s not in seenpat:
                seenpat.add(s)
                print(f"{sec:8s} {va:#10x}  {s[:120]!r}")
                break
