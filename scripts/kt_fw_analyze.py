#!/usr/bin/env python3
"""KTMicro firmware image cross-analysis:
- identify family via flash tag / meta strings / chip id
- locate EQ tables, USB descriptors (VID/PID), product strings
- dump REG: blocks and enable bytes
Covers: Tanchjim DSP S (KT0211L), KT02H20 TINHIFI, KT02F20 SDK x2, KT0712 SDK, KT0206 boot."""
import re, os, struct, hashlib

FW = {
    "Tanchjim_DSPS_KT0211L_1.0.2": "/home/z/my-project/kt_work/firmware/dsps/tanchjim_dsps_upgrade_20240913/KT0211L_TANCHJIM-DSP_20240815_1.0.2.bin",
    "KT02H20_TINHIFI": "/home/z/my-project/kt_work/tools/kt_usb_app/KT02H20_TINHIFI.bin",
    "KT02F20_SDK_disable_jack": "/home/z/my-project/kt_work/firmware/KT02F20_SDK_20250206_disable_jack.bin",
    "KT02F20_SDK_jack_GPIO03": "/home/z/my-project/kt_work/firmware/KT02F20_SDK_20250206_jack_GPIO_03.bin",
    "KT0712_SDK_V2.1": "/home/z/my-project/kt_work/tools/carved/resources/KT_BOOT_TOOL_entry_0xfbd841_160,400B.bin",
    "KT0206_boot_v1.05": "/home/z/my-project/kt_work/tools/carved/resources/KT0206_boot_v1.05_extracted.bin",
}

for name, path in FW.items():
    if not os.path.exists(path):
        print("missing", path); continue
    data = open(path, "rb").read()
    print(f"\n########## {name} — {len(data):,} B ##########")
    print("  md5:", hashlib.md5(data).hexdigest(), " sha256:", hashlib.sha256(data).hexdigest()[:32])
    # flash tag / meta
    for pat in (rb"KT_lnv1b_flash[0-9A-Za-z_]*", rb"KT_msv2b_flash[0-9A-Za-z_]*", rb"KTM_TT_V3_flash[0-9A-Za-z_]*",
                rb"[0-9]{4}[A-Z]{2}[0-9]", rb"Size", rb"ENTY", rb"REG:"):
        hits = [m.start() for m in re.finditer(pat, data)]
        if hits:
            print(f"  {pat.decode()}: {[hex(h) for h in hits[:6]]}")
    # meta strings near start
    ss = [m.group().decode() for m in re.finditer(rb"[ -~]{4,}", data[:1024])]
    print("  head strings:", ss[:14])
    # build date/version strings anywhere
    for pat in (rb"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d+ \d{4}", rb"\d+\.\d+\.\d+"):
        hits = sorted(set(m.group().decode() for m in re.finditer(pat, data)))[:8]
        if hits: print("  versions/dates:", hits)
    # USB descriptor VID 0x31B2: bytes b2 31 with following PID
    for m in re.finditer(rb"\x12\x01\x10\x01", data):  # config descriptor? actually device descriptor starts 12 01 00 02/10 01
        off = m.start()
        idv = int.from_bytes(data[off+8:off+10], "little"); idp = int.from_bytes(data[off+10:off+12], "little")
        print(f"  possible USB device descriptor @{off:#x}: VID={idv:#06x} PID={idp:#06x}")
    for m in re.finditer(rb"\xb2\x31", data):
        off = m.start()
        pid = int.from_bytes(data[off+2:off+4], "little")
        if pid in (0x0111, 0x1112, 0x1132, 0x0101, 0x0020, 0x0100, 0x1130, 0x1131, 0x1133, 0x1134):
            print(f"  VID:PID @{off:#x}: 31B2:{pid:04x}")
    # product strings
    for pat in (rb"TANCHJIM[ -~]{0,24}", rb"KT02[0-9A-Z]{2,5}[ -~]{0,20}", rb"CDS[ .KTA-Za-z0-9]{0,24}",
                rb"TINHIFI[ -~]{0,20}", rb"KTMICRO[ -~]{0,20}", rb"KTMicro[ -~]{0,20}", rb"USB[ -~]{0,20}Audio[ -~]{0,12}"):
        hits = sorted(set(m.group().decode() for m in re.finditer(pat, data)))[:6]
        if hits: print(f"  {pat.decode()[:20]}: {hits}")
    # EQ table pattern: freq u16, Q u16, gain s16, type u16 (8B each) — known factory defaults
    # KT0211L factory: 1000/2000/5000/8000/10000 Hz Q707 gain0 peak
    def find_eq(freqs, q=707, g=0, t=0):
        for f in freqs:
            pat = struct.pack("<HHH", f, q, g)
            for m in re.finditer(re.escape(pat), data):
                yield f, m.start()
    print("  factory-freq hits (1000/2000/5000/8000/10000):", [(f, hex(o)) for f, o in find_eq([1000, 2000, 5000, 8000, 10000])][:8])
    print("  factory-freq hits (61/122/184/248/316/392):", [(f, hex(o)) for f, o in find_eq([61, 122, 184, 248, 316, 392])][:8])
    # 'REG:' defaults block
    for m in re.finditer(rb"REG:", data):
        off = m.start()
        print(f"  REG: block @{off:#x}: {data[off:off+64].hex()}")
