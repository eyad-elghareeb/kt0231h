#!/usr/bin/env python3
"""Reconstruct the flashed KT0211L image from the boot log; locate EQ tables."""
import os, re, json, struct

LOG = "/home/z/my-project/extracted/writechip/writechip/writechip/Log/23-10-11 18-05-56log.txt"
frames = []
for line in open(LOG, errors="replace"):
    m = re.match(r"\s*(TX|RX)\s*:\s*(.*)", line)
    if not m: continue
    h = m.group(2).strip()
    if not h: continue
    try: frames.append((m.group(1), bytes.fromhex(h.replace(" ", ""))))
    except ValueError: pass

pkts = []
for d, b in frames:
    if d == "TX" and len(b) > 4 and b[0] == 0x69:
        subtype = b[1]
        region = struct.unpack("<H", b[2:4])[0]
        addr = struct.unpack("<H", b[4:6])[0]
        pkts.append({"sub": subtype, "region": region, "addr": addr,
                     "data": b[6:], "tail": b[-4:].hex() if len(b) > 6 else None})

print(f"0x69 packets: {len(pkts)}")
for p in pkts:
    print(f"  sub={p['sub']:#04x} region={p['region']:#06x} addr={p['addr']:#06x} len={len(p['data'])}")

# reconstruct by addr within region
image = {}
for p in pkts:
    key = (p["region"], p["sub"])
    # data chunk = payload minus trailing crc32 (upstream packs crc inside meta/sig content;
    # for data blocks the vendor appends 4B tail) — store raw
    image.setdefault(key, bytearray())
for p in pkts:
    image[(p["region"], p["sub"])] += p["data"]

for k, v in image.items():
    print(f"region {k[0]:#06x} sub {k[1]:#04x}: {len(v)} bytes")

# save the main data region (sub=0, region=0xe4) as the firmware body
body = image.get((0x00E4, 0x00), bytearray())
open("/home/z/my-project/work/fw_body.bin", "wb").write(body)
meta = image.get((0x1023, 0xF0), bytearray())
open("/home/z/my-project/work/fw_meta.bin", "wb").write(meta)
sig = image.get((0x00E0, 0x10), bytearray())
open("/home/z/my-project/work/fw_sig.bin", "wb").write(sig)
cfg = image.get((0x00E2, 0x90), bytearray())
open("/home/z/my-project/work/fw_cfg.bin", "wb").write(cfg)
print("\nbody:", len(body), "meta:", len(meta), "sig:", len(sig), "cfg:", len(cfg))

# ---- locate EQ tables in body: KT0211L 5-band defaults ----
# A_reg = [freq u16][gain x10 s16]; B_reg = [type:3<<16][Q x1000]
# defaults per README (KT0231H): 61/122/184/248/316/392 Hz, 0 dB, Peak, Q 0.700
# KT02H20/KT0211L: 5 bands
freqs5 = [61, 122, 184, 248, 316]
pats = []
for f in freqs5:
    pats.append(struct.pack("<Hh", f, 0))
# search consecutive A,B pairs: A=[freq][gain0], B=[type0 q700]
blob = body
print("\nscan for default EQ band pairs (freq, gain0, type0, Q700):")
hits = []
i = 0
while i < len(blob) - 8:
    f, g = struct.unpack_from("<Hh", blob, i)
    t_q = struct.unpack_from("<I", blob, i + 4)[0]
    typ = (t_q >> 16) & 0x7
    q = t_q & 0xFFFF
    if f in freqs5 and g == 0 and typ == 0 and 690 <= q <= 710:
        hits.append((i, f, q))
    i += 4
# find runs of 5
runs = []
run = []
prev = None
for off, f, q in hits:
    if prev is not None and off - prev == 8 and f == freqs5[len(run) % 5]:
        run.append(off)
    else:
        if len(run) >= 5: runs.append(run[0])
        run = [off]
    prev = off
if len(run) >= 5: runs.append(run[0])
print("5-band default table starts at body offsets:", [hex(x) for x in runs])

# Also scan for the JA11-style layout [freq u16][Q u16][gain s16][type u16]
print("\nscan JA11-style 8-byte band entries:")
runs2 = []
i = 0
while i < len(blob) - 40:
    ok = True
    for k, f in enumerate(freqs5):
        o = i + k * 8
        fq, qq, gg, tt = struct.unpack_from("<HHhH", blob, o)
        if fq != f or qq != 700 or gg != 0 or tt != 0:
            ok = False; break
    if ok:
        runs2.append(i); i += 40
    else:
        i += 1
print("JA11-style table starts:", [hex(x) for x in runs2])

# meta header details
print("\nmeta header first 128 bytes:")
print(meta[:128].hex(' '))
print("ascii:", "".join(chr(c) if 32 <= c < 127 else "." for c in meta[:64]))
