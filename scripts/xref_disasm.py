#!/usr/bin/env python3
"""Locate functions via string xrefs and disassemble with capstone (i386)."""
import pefile, struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

def text_section(pe):
    for s in pe.sections:
        if s.Name.startswith(b".text"):
            return s
    return None

def rva_to_off(pe, rva):
    for s in pe.sections:
        if s.VirtualAddress <= rva < s.VirtualAddress + s.Misc_VirtualSize:
            return s.PointerToRawData + (rva - s.VirtualAddress)
    return None

def find_str_va(pe, needle):
    for s in pe.sections:
        raw = s.get_data()
        i = raw.find(needle)
        while i != -1:
            va = pe.OPTIONAL_HEADER.ImageBase + s.VirtualAddress + i
            yield va, i, s.Name.decode(errors='replace').rstrip('\x00')
            i = raw.find(needle, i + 1)

def find_refs(pe, target_va):
    """search .text for absolute 32-bit references to target_va"""
    t = text_section(pe)
    raw = t.get_data()
    pat = struct.pack("<I", target_va)
    refs = []
    i = raw.find(pat)
    while i != -1:
        refs.append((pe.OPTIONAL_HEADER.ImageBase + t.VirtualAddress + i, raw[i-1] if i else 0))
        i = raw.find(pat, i + 1)
    return refs

def disasm_around(pe, va, before=0x40, count=180):
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = False
    t = text_section(pe)
    raw = t.get_data()
    tva = pe.OPTIONAL_HEADER.ImageBase + t.VirtualAddress
    off = va - tva
    start = max(0, off - before)
    code = raw[start:off + count * 6]
    out = []
    for ins in md.disasm(code, tva + start):
        out.append(f"{ins.address:#10x}  {ins.mnemonic:8s} {ins.op_str}")
        if len(out) >= count + before // 2:
            break
    return out

if __name__ == "__main__":
    fn = sys.argv[1]
    needle = sys.argv[2].encode()
    before = int(sys.argv[3]) if len(sys.argv) > 3 else 0x40
    count = int(sys.argv[4]) if len(sys.argv) > 4 else 160
    pe = pefile.PE(fn, fast_load=True)
    for va, off, sec in find_str_va(pe, needle):
        print(f"### string {needle!r} at {va:#x} (sec {sec})")
        for ref, prev in find_refs(pe, va):
            print(f"\n--- ref at {ref:#x} (prev byte {prev:#x}) ---")
            for line in disasm_around(pe, ref, before, count):
                print(line)
        print()
