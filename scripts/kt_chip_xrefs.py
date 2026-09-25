#!/usr/bin/env python3
"""Find xrefs to chip-name strings ('KT0231H', 'KT0211L', ...) in KTMicro PE tools
and disassemble around each referencing site to recover per-chip config tables."""
import pefile, struct, re, sys
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

TARGETS = {
    "KT_UPGRADE_TOOL": "/home/z/my-project/kt_work/tools/upgrade_tool/Upgrade Tool/KT Upgrade Tool.exe",
    "KT_BOOT_TOOL": "/home/z/my-project/kt_work/tools/kt_usb_app/writechip/KT_BOOT_TOOL_1.0.58.exe",
    "KT_USB_APP": "/home/z/my-project/kt_work/tools/kt_usb_app/KT_USB_APP.exe",
}

CHIPS = ["KT0231H", "KT0231X", "KT0211L", "KT0210S", "KT02F20", "KT02H20", "KT0206"]

md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = False

def rva_to_off(pe, rva):
    for s in pe.sections:
        if s.VirtualAddress <= rva < s.VirtualAddress + max(s.Misc_VirtualSize, s.SizeOfRawData):
            return s.PointerToRawData + (rva - s.VirtualAddress)
    return None

for tname, path in TARGETS.items():
    pe = pefile.PE(path, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    print(f"\n\n########## {tname} ##########")
    for chip in CHIPS:
        # locate the string in the image (any section)
        pat = chip.encode() + b"\x00"
        occ = []
        for s in pe.sections:
            data = s.get_data()
            for m in re.finditer(re.escape(pat), data):
                occ.append((base + s.VirtualAddress + m.start(), base + s.VirtualAddress + m.start() - 16))
        if not occ:
            print(f"  {chip}: string not found"); continue
        print(f"  {chip}: string VA(s) {[hex(v) for v, _ in occ]}")
        # find push/mov immediates equal to those VAs in .text
        text = [s for s in pe.sections if s.Name.startswith(b".text")][0]
        traw = text.get_data(); tva = base + text.VirtualAddress
        for strva, _ in occ:
            imms = set()
            tgt = strva
            for i in range(len(traw) - 5):
                b = traw[i]
                # push imm32 (0x68), mov reg, imm32 variants 0xB8+r, C7 /0
                if b == 0x68:
                    v = struct.unpack_from("<I", traw, i+1)[0]
                    if v == tgt: imms.add((i, "push"))
                elif 0xB8 <= b <= 0xBF:
                    v = struct.unpack_from("<I", traw, i+1)[0]
                    if v == tgt: imms.add((i, f"mov r{b-0xB8}"))
            for off, kind in sorted(imms):
                va = tva + off
                print(f"    ref @{va:#x} ({kind})")
                start = max(0, off - 48)
                for ins in md.disasm(traw[start:off + 40], tva + start):
                    print(f"      {ins.address:#9x}: {ins.mnemonic:7s} {ins.op_str}")
                print("      ---")
