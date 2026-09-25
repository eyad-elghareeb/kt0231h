#!/usr/bin/env python3
"""Tolerant Qt RCC walker: after each entry, scan forward up to 64 bytes for the
next valid entry header ([u32 total][u32 rawsize][zlib] or [u32 total][MZ/PDF/PK])."""
import zlib, struct, os, re, hashlib

TARGETS = {
    "KT_BOOT_TOOL": ("/home/z/my-project/kt_work/tools/kt_usb_app/writechip/KT_BOOT_TOOL_1.0.58.exe", 0xfa1bd4),
    "KT_UPGRADE_TOOL": ("/home/z/my-project/kt_work/tools/upgrade_tool/Upgrade Tool/KT Upgrade Tool.exe", None),
    "TANCHJIM_DSPS": ("/home/z/my-project/kt_work/firmware/dsps/tanchjim_dsps_upgrade_20240913/TANCHJIM_DSPS_BOOT_TOOL_1.0.03.exe", None),
}
OUT = "/home/z/my-project/kt_work/tools/carved/resources"

def entry_at(data, pos):
    """Return (total, unc, raw, end) if a valid RCC entry starts at pos."""
    if pos + 8 > len(data): return None
    total = struct.unpack(">I", data[pos:pos+4])[0]
    if not (256 <= total <= 4_000_000): return None
    if pos + 4 + total > len(data): return None
    payload = data[pos+4:pos+4+total]
    if payload[:1] in (b"M", b"%", b"P", b"\x89"):
        if payload[:2] == b"MZ" or payload[:4] == b"%PDF" or payload[:2] == b"PK" or payload[:4] == b"\x89PNG":
            return total, None, payload, pos + 4 + total
    if total >= 8 and payload[4:5] == b"\x78":
        unc = struct.unpack(">I", payload[:4])[0]
        try:
            d = zlib.decompressobj()
            raw = d.decompress(payload[4:])
        except Exception:
            return None
        if raw is not None and len(raw) == unc:
            return total, unc, raw, pos + 4 + total
    return None

def find_next(data, pos, limit=96):
    for p in range(pos, min(pos + limit, len(data) - 8)):
        e = entry_at(data, p)
        if e: return p, e
    return None, None

def classify(raw):
    if raw.startswith(b"%PDF"): return "pdf"
    if raw.startswith(b"MZ"): return "pe"
    if raw.startswith(b"\x89PNG"): return "png"
    if raw.startswith(b"PK"): return "zip"
    return "bin"

for name, (path, anchor) in TARGETS.items():
    data = open(path, "rb").read()
    if anchor is None:
        # find first valid compressed entry with plausible code payload anywhere
        for m in re.finditer(rb"\x78[\x9c\xda]", data):
            e = entry_at(data, m.start() - 4)
            if e and e[2] and len(e[2]) > 10000 and e[2][:4] != b"\x00\x00\x00\x00":
                anchor = m.start() - 4
                break
        if anchor is None:
            print(f"{name}: NO ANCHOR"); continue
    print(f"\n===== {name} walking from {anchor:#x} =====")
    pos, e = find_next(data, anchor)
    n = 0
    while pos is not None and n < 200:
        total, unc, raw, end = e
        c = classify(raw)
        ss = sorted(set(mm.group().decode() for mm in re.finditer(rb"[A-Za-z0-9_.: -]{6,}", raw)))[:8]
        print(f"  @{pos:#x} total={total:,} -> {len(raw):,} B {c} strs={ss if c=='bin' else ''}")
        if c in ("bin", "pdf", "pe", "zip"):
            ext = {"pdf": "pdf", "pe": "exe", "zip": "zip"}.get(c, "bin")
            open(os.path.join(OUT, f"{name}_rcc_{pos:#x}_{len(raw):,}B.{ext}"), "wb").write(raw)
        pos, e = find_next(data, end)
        n += 1
