#!/usr/bin/env python3
"""Comprehensive Qt RCC payload extraction from KTMicro tools.
Scans zlib candidates, collects every payload, classifies by magic + content,
and names them against the known resource list (ram_flashload/ram_getcid/
KT0712_reset_spi/doc.pdf/KT_VCP/devcon/tubiao)."""
import zlib, re, os, sys, hashlib

TARGETS = {
    "KT_BOOT_TOOL": "/home/z/my-project/kt_work/tools/kt_usb_app/writechip/KT_BOOT_TOOL_1.0.58.exe",
    "KT_UPGRADE_TOOL": "/home/z/my-project/kt_work/tools/upgrade_tool/Upgrade Tool/KT Upgrade Tool.exe",
}

OUT = "/home/z/my-project/kt_work/tools/carved/resources"
os.makedirs(OUT, exist_ok=True)

KNOWN_HINTS = {
    b"KTCInitKey": "boot_loader_ram",
    b"KTPrgKey": "boot_loader_ram",
    b"BFLSH": "boot_loader_ram",
    b"MSV2B_BOOT": "boot_loader_ram",
    b"KT-Micro": "boot_loader_ram",
    b"%PDF": "doc.pdf",
    b"\x89PNG": "png_image",
    b"MZ\x90\x00\x03": "devcon_pe",
}

def sniff(out):
    tags = []
    for magic, name in KNOWN_HINTS.items():
        if out.find(magic) != -1:
            tags.append(name)
    return tags

for name, path in TARGETS.items():
    data = open(path, "rb").read()
    print(f"\n===== {name} =====")
    payloads = {}
    for m in re.finditer(rb"\x78[\x9c\xda\x5e\xbb\x01]", data):
        off = m.start()
        try:
            d = zlib.decompressobj()
            out = d.decompress(data[off:off + 4_000_000])
        except Exception:
            continue
        if len(out) < 200:
            continue
        # key by content hash to dedupe
        h = hashlib.sha256(out).digest()[:12]
        if h in payloads:
            payloads[h] = (out, payloads[h][1] + [off])
        else:
            payloads[h] = (out, [off])
    print(f"  unique payloads: {len(payloads)}")
    for h, (out, offs) in sorted(payloads.items(), key=lambda kv: -len(kv[1][0])):
        tags = sniff(out)
        print(f"  {len(out):9,} B  offs={','.join(hex(o) for o in offs[:3])}  tags={tags}")
        if tags and any(t.startswith('boot_loader') for t in tags):
            fn = os.path.join(OUT, f"{name}_bootloader_{len(out):,}B.bin")
            open(fn, "wb").write(out)
            print("     -> saved", fn)
        elif len(out) > 200000 and not tags:
            fn = os.path.join(OUT, f"{name}_big_{len(out):,}B.bin")
            open(fn, "wb").write(out)
            print("     -> saved", fn)
