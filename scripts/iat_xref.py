#!/usr/bin/env python3
"""Find IAT VAs of key imports and xref call sites; dump disasm around each."""
import pefile, struct, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

fn = sys.argv[1]
pe = pefile.PE(fn)
iat = {}
for e in pe.DIRECTORY_ENTRY_IMPORT:
    for imp in e.imports:
        if imp.name:
            iat[imp.name.decode()] = imp.address  # VA of IAT slot

targets = sys.argv[2].split(",")
md = Cs(CS_ARCH_X86, CS_MODE_32)
tsec = [s for s in pe.sections if s.Name.startswith(b".text")][0]
raw = tsec.get_data(); tva = pe.OPTIONAL_HEADER.ImageBase + tsec.VirtualAddress

for t in targets:
    va = iat.get(t)
    if not va:
        print(f"{t}: not imported"); continue
    # call [iat] = ff 15 <va> ; mov eax,[iat] = a1 <va>
    hits = []
    for pat, name in ((b"\xff\x15" + struct.pack("<I", va), "call"),):
        i = raw.find(pat)
        while i != -1:
            hits.append(("call", tva + i))
            i = raw.find(pat, i + 1)
    print(f"=== {t} @ {va:#x}: {len(hits)} call sites")
    for kind, site in hits:
        print(f"  {kind} at {site:#x}")
