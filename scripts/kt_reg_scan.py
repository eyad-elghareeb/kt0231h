#!/usr/bin/env python3
"""Scan KT_USB_APP.exe .text for register-immediate clusters:
- `mov dword [esp+X], imm32` (C7 44 24 XX imm32) with imm in the EQ register range
- cluster the hits by proximity to recover the app's register usage blocks
- flag any imm32 constants that look like unknown registers near known ones"""
import pefile, struct, re, collections

def scan(path, name):
    pe = pefile.PE(path, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    text = [s for s in pe.sections if s.Name.startswith(b".text")][0]
    raw = text.get_data(); tva = base + text.VirtualAddress
    # find all C7 44 24 XX imm32 and C7 45 XX imm32 (mov [ebp+X], imm)
    hits = []
    for m in re.finditer(rb"\xc7\x44\x24(.)", raw):
        o = m.start(); disp = m.group(1)[0]
        imm = struct.unpack_from("<I", raw, o + 4)[0]
        hits.append((tva + o, disp, imm))
    for m in re.finditer(rb"\xc7\x45(.)", raw):
        o = m.start(); disp = m.group(1)[0]
        imm = struct.unpack_from("<I", raw, o + 3)[0]
        hits.append((tva + o, disp, imm))
    # known register addresses
    KNOWN = set(range(0x18, 0x30)) | set(range(0x34, 0x4E)) | {0x3A, 0x3B, 0x65, 0x66, 0x71, 0x72, 0x73, 0x78, 0x79, 0x53, 0x5B}
    # cluster: group hits within 0x120 bytes windows where >=2 hits have imm in register range
    hits.sort()
    print(f"\n===== {name}: register-immediate clusters =====")
    window = []
    for va, disp, imm in hits:
        if not (0x10 <= imm <= 0x100):
            continue
        window.append((va, disp, imm))
    # sliding cluster
    used = [False] * len(window)
    for i, (va, disp, imm) in enumerate(window):
        if used[i]: continue
        cluster = [window[i]]
        j = i + 1
        while j < len(window) and window[j][0] - cluster[-1][0] < 0x140:
            cluster.append(window[j]); j += 1
        regs = [c[2] for c in cluster if 0x10 <= c[2] <= 0x100]
        if len(regs) >= 3 and (set(regs) & KNOWN):
            for c in cluster: used[window.index(c)] = True
            addrs = ", ".join(f"{c[2]:#x}" for c in cluster)
            print(f"  cluster @{cluster[0][0]:#x}: {addrs}")

scan("/home/z/my-project/kt_work/tools/kt_usb_app/KT_USB_APP.exe", "KT_USB_APP")
scan("/home/z/my-project/kt_work/tools/carved/carved_0x5570_0x590e90.exe", "kt_usb_cmd_tool")
