#!/usr/bin/env python3
"""Xref an arbitrary VA in .text and disassemble around it."""
import pefile, struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

fn = sys.argv[1]
target = int(sys.argv[2], 0)
before = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0x60
after = int(sys.argv[4], 0) if len(sys.argv) > 4 else 0x120

pe = pefile.PE(fn, fast_load=True)
tsec = [s for s in pe.sections if s.Name.startswith(b".text")][0]
raw = tsec.get_data()
tva = pe.OPTIONAL_HEADER.ImageBase + tsec.VirtualAddress
pat = struct.pack("<I", target)
refs = []
i = raw.find(pat)
while i != -1:
    refs.append(tva + i)
    i = raw.find(pat, i + 1)
print("refs to", hex(target), ":", [hex(a) for a in refs])

md = Cs(CS_ARCH_X86, CS_MODE_32)
for addr in refs:
    off = addr - tva
    start = max(0, off - before)
    print(f"\n===== around {addr:#x} =====")
    for ins in md.disasm(raw[start:off + after], tva + start):
        print(f"{ins.address:#10x}  {ins.mnemonic:8s} {ins.op_str}")
