#!/usr/bin/env python3
"""Disassemble a VA range from .text of a PE."""
import pefile, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

fn = sys.argv[1]
va = int(sys.argv[2], 0)
count = int(sys.argv[3]) if len(sys.argv) > 3 else 120
pe = pefile.PE(fn, fast_load=True)
tsec = [s for s in pe.sections if s.Name.startswith(b".text")][0]
raw = tsec.get_data(); tva = pe.OPTIONAL_HEADER.ImageBase + tsec.VirtualAddress
md = Cs(CS_ARCH_X86, CS_MODE_32)
off = va - tva
for ins in md.disasm(raw[off:off + count * 8], va):
    print(f"{ins.address:#10x}  {ins.mnemonic:8s} {ins.op_str}")
    count -= 1
    if count <= 0: break
