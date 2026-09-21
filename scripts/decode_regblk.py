#!/usr/bin/env python3
"""Decode the REG: factory register-default block from the vendor flash session."""
import struct

data = open("/home/z/my-project/work/fw_cfg.bin", "rb").read()  # region 0x0024? no - cfg
# rebuild region 0x24 from packets: it's fw 'region 0x0024 sub 0' - I saved only 4 regions; redo quickly:
import re, os
LOG = "/home/z/my-project/extracted/writechip/writechip/writechip/Log/23-10-11 18-05-56log.txt"
frames = []
for line in open(LOG, errors="replace"):
    m = re.match(r"\s*(TX|RX)\s*:\s*(.*)", line)
    if not m: continue
    h = m.group(2).strip()
    if not h: continue
    try: frames.append((m.group(1), bytes.fromhex(h.replace(" ", ""))))
    except ValueError: pass

regblk = bytearray()
body = bytearray()
for d, b in frames:
    if d == "TX" and len(b) > 6 and b[0] == 0x69:
        region = struct.unpack("<H", b[2:4])[0]
        if region == 0x0024:
            regblk += b[6:-4]   # strip tail
        elif region == 0x00E4:
            body += b[6:-4]

open("/home/z/my-project/work/fw_regblk.bin", "wb").write(regblk)
print("REG block:", len(regblk), "bytes; body:", len(body))

# The REG block starts with "REG:" then presumably [addr u16][value u32] pairs or similar
print("\nfirst 256 bytes:")
for i in range(0, 256, 16):
    row = bytes(regblk[i:i+16])
    print(f"{i:04x}  {row.hex(' ')}  |{''.join(chr(c) if 32<=c<127 else '.' for c in row)}|")

# try parsing as: 'REG:' + [u16 addr][u32 value] entries
print("\nparse REG: + [addr u16][val u32] entries:")
i = 4
entries = []
while i + 6 <= len(regblk):
    a, v = struct.unpack_from("<HI", regblk, i)
    entries.append((a, v))
    i += 6
print("count:", len(entries))
for a, v in entries[:40]:
    print(f"  reg[{a:#04x}] = {v:#010x}")

# alternative: [u16 addr][u16 value] pairs
print("\nparse REG: + [addr u16][val u16]:")
i = 4
pairs = []
while i + 4 <= len(regblk):
    a, v = struct.unpack_from("<HH", regblk, i)
    pairs.append((a, v))
    i += 4
for a, v in pairs[:40]:
    print(f"  reg[{a:#04x}] = {v:#06x}")
EOF