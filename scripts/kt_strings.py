#!/usr/bin/env python3
"""Extract targeted strings from KTMicro vendor EXEs + carve Qt embedded resources."""
import re, os, sys

TARGETS = {
    "KT_USB_APP": "/home/z/my-project/kt_work/tools/kt_usb_app/KT_USB_APP.exe",
    "KT_BOOT_TOOL": "/home/z/my-project/kt_work/tools/kt_usb_app/writechip/KT_BOOT_TOOL_1.0.58.exe",
    "KT_UPGRADE_TOOL": "/home/z/my-project/kt_work/tools/upgrade_tool/Upgrade Tool/KT Upgrade Tool.exe",
    "kt_usb_cmd_tool": "/home/z/my-project/kt_work/tools/carved/carved_0x5570_0x590e90.exe",
}

PATTERNS = [
    rb"KT[0-9A-Z]{3,6}[A-Z]?",            # chip names KT0231H etc
    rb"KT_[a-z0-9_]+",                      # KT_lnv1b_flash_1, KT_VCP etc
    rb"[A-Za-z0-9_\-]*flash[a-zA-Z0-9_\-]*",
    rb"ram_[a-z]+\.bin",
    rb"[A-Z]{3,4} [A-Za-z0-9_/. ]{0,40}",   # step names
    rb"\\\.\\[A-Za-z]+",                    # device paths
    rb"vid_[0-9a-f&]+pid_[0-9a-f&]+[a-z0-9_&]*",
    rb"https?://[^\x00\x20]{5,80}",
    rb"[0-9]+\.[0-9]+\.[0-9]+",
    rb"(?i)(shakehand|ShakeHand|burn|erase|restore|query_ver|flash_write|flash_read|crc)",
    rb"(?i)(boot|cdc|serial|hid)[A-Za-z_]{0,20}",
    rb"(?i)(EQ|VOLUME|DRC|PGA|NOISEGATE|LIMITER|AGC|COMPRESSOR|EXPANDER)[A-Za-z_]{0,15}",
    rb"(?i)(KT02|KT07|MSV|TURN|CDS)[0-9A-Za-z_]{0,12}",
    rb"(?i)(tanchjim|moondrop|fiio|jcally|tinhifi|fransun|ddhiFi|EPZ|TANGZU)",
    rb"(?i)(chipType|ChipNum|Interface|Baund|CompareChip|Devcon|Erase|BinPath)",
]

def ascii_strings(data, minlen=5):
    return re.finditer(rb"[\x20-\x7e]{%d,}" % minlen, data)

def utf16_strings(data, minlen=4):
    return re.finditer((rb"[\x20-\x7e]\x00{%d}" % 1) * 1 + rb"[\x20-\x7e]\x00", data)

for name, path in TARGETS.items():
    if not os.path.exists(path):
        print("missing", path); continue
    data = open(path, "rb").read()
    print(f"\n\n########## {name} ({len(data):,} B) ##########")
    hits = {}
    for pat in PATTERNS:
        s = set()
        for m in re.finditer(pat, data):
            try: v = m.group().decode("ascii")
            except Exception: continue
            if len(v) >= 4: s.add(v)
        if s: hits[pat.decode(errors="replace")[:40]] = s
    for pat, s in hits.items():
        vals = sorted(s)[:60]
        print(f"  [{pat}] ({len(s)} uniq)")
        for v in vals:
            print("     ", v)
