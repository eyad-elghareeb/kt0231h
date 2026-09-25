#!/usr/bin/env python3
"""Recon all KTMicro vendor EXEs: PE headers, and for the Tanchjim boot tool,
locate & carve the embedded kt_usb_cmd_tool.exe (MinGW PE inside installer)."""
import pefile, sys, os, re, hashlib

FILES = {
    "KT_USB_APP_1.0.17": "/home/z/my-project/kt_work/tools/kt_usb_app/KT_USB_APP.exe",
    "KT_BOOT_TOOL_1.0.58": "/home/z/my-project/kt_work/tools/kt_usb_app/writechip/KT_BOOT_TOOL_1.0.58.exe",
    "KT_UPGRADE_TOOL_1.2.10": "/home/z/my-project/kt_work/tools/upgrade_tool/Upgrade Tool/KT Upgrade Tool.exe",
    "TANCHJIM_DSPS_BOOT_TOOL_1.0.03": "/home/z/my-project/kt_work/firmware/dsps/tanchjim_dsps_upgrade_20240913/TANCHJIM_DSPS_BOOT_TOOL_1.0.03.exe",
}

OUT = "/home/z/my-project/kt_work/tools/carved"
os.makedirs(OUT, exist_ok=True)

for name, path in FILES.items():
    print(f"\n===== {name} : {os.path.basename(path)} ({os.path.getsize(path):,} B) =====")
    data = open(path, "rb").read()
    print("  md5 :", hashlib.md5(data).hexdigest())
    print("  sha256:", hashlib.sha256(data).hexdigest())
    try:
        pe = pefile.PE(path, fast_load=True)
        mach = pe.FILE_HEADER.Machine
        print(f"  Machine: {mach:#x} ({'i386' if mach==0x14c else 'x64' if mach==0x8664 else 'arm64' if mach==0xaa64 else '?'})")
        print(f"  EntryPoint: {pe.OPTIONAL_HEADER.AddressOfEntryPoint:#x}  ImageBase: {pe.OPTIONAL_HEADER.ImageBase:#x}")
        print("  Sections:", [(s.Name.decode().rstrip('\x00'), f"vsize={s.Misc_VirtualSize:#x}", f"raw={s.PointerToRawData:#x}+{s.SizeOfRawData:#x}") for s in pe.sections])
        ts = pe.FILE_HEADER.TimeDateStamp
        import datetime
        print("  Link time:", datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"))
    except Exception as e:
        print("  PE parse FAILED:", e)

# ---- carve embedded PEs from the Tanchjim installer ----
print("\n\n===== Carving embedded PE files from TANCHJIM_DSPS_BOOT_TOOL_1.0.03.exe =====")
data = open(FILES["TANCHJIM_DSPS_BOOT_TOOL_1.0.03"], "rb").read()
found = []
for m in re.finditer(b"MZ", data):
    off = m.start()
    if off + 0x40 > len(data): continue
    try:
        e_lfanew = int.from_bytes(data[off+0x3c:off+0x40], "little")
    except Exception:
        continue
    if off + e_lfanew + 6 > len(data) or data[off+e_lfanew:off+e_lfanew+4] != b"PE\x00\x00":
        continue
    machine = int.from_bytes(data[off+e_lfanew+4:off+e_lfanew+6], "little")
    nsec = int.from_bytes(data[off+e_lfanew+6:off+e_lfanew+8], "little")
    if nsec == 0 or nsec > 16: continue
    sopt = off + e_lfanew + 24
    sizeopt = int.from_bytes(data[off+e_lfanew+20:off+e_lfanew+22], "little")
    last = sopt + sizeopt + (nsec-1)*40
    if last + 40 > len(data): continue
    rawsz = int.from_bytes(data[last+16:last+20], "little")
    rawptr = int.from_bytes(data[last+20:last+24], "little")
    end = rawptr + rawsz
    if rawsz == 0 or end > len(data): continue
    found.append((off, machine, nsec, end))
    print(f"  PE at {off:#x}: machine={machine:#x} nsec={nsec} ends~{end:#x} ({end-off:,} B)")

for off, mach, nsec, end in found:
    if end - off < 100000: continue
    out = os.path.join(OUT, f"carved_{off:#x}_{end-off:#x}.exe")
    open(out, "wb").write(data[off:end])
    print("  saved:", out)
