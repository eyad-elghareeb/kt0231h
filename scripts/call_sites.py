#!/usr/bin/env python3
"""Find E8 call sites targeting a function VA; disassemble around each."""
import pefile, struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

fn = sys.argv[1]
target = int(sys.argv[2], 0)
nctx = int(sys.argv[3]) if len(sys.argv) > 3 else 0x30
pe = pefile.PE(fn, fast_load=True)
tsec = [s for s in pe.sections if s.Name.startswith(b".text")][0]
raw = tsec.get_data(); tva = pe.OPTIONAL_HEADER.ImageBase + tsec.VirtualAddress
md = Cs(CS_ARCH_X86, CS_MODE_32)

sites = []
i = 0
while i < len(raw) - 5:
    if raw[i] == 0xE8:
        rel = struct.unpack_from("<i", raw, i + 1)[0]
        if tva + i + 5 + rel == target:
            sites.append(tva + i)
    i += 1
print(f"call sites to {target:#x}: {[hex(s) for s in sites]}")
for s in sites:
    print(f"\n===== call at {s:#x} =====")
    off = s - tva - nctx
    for ins in md.disasm(raw[off:off + nctx + 0x50], tva + off):
        print(f"{ins.address:#10x}  {ins.mnemonic:8s} {ins.op_str}")
