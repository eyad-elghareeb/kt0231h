#!/usr/bin/env python3
"""Crack the 4-byte tail checksum of 0x69 packets; dump ordered session; extract payloads."""
import os, re, zlib, struct, collections

LOG_DIR = "/home/z/my-project/extracted/writechip/writechip/writechip/Log"

def parse_logs():
    frames = []
    for fn in sorted(os.listdir(LOG_DIR)):
        for line in open(os.path.join(LOG_DIR, fn), errors="replace"):
            m = re.match(r"\s*(TX|RX)\s*:\s*(.*)", line)
            if not m: continue
            h = m.group(2).strip()
            if not h: continue
            try: b = bytes.fromhex(h.replace(" ", ""))
            except ValueError: continue
            frames.append((fn, m.group(1), b))
    return frames

frames = parse_logs()
big = [(b) for _, d, b in frames if d == "TX" and len(b) > 32]

# ---- checksum brute force on payload = pkt[6:-4] vs tail = pkt[-4:] ----
def fletcher32(data):
    s1 = s2 = 0
    for i in range(0, len(data) - len(data) % 2, 2):
        w = data[i] | (data[i+1] << 8)
        s1 = (s1 + w) % 65535; s2 = (s2 + s1) % 65535
    return (s2 << 16) | s1

def sum32(data):
    return sum(data) & 0xFFFFFFFF

def xorw32(data):
    x = 0
    for i in range(0, len(data) - len(data) % 4, 4):
        x ^= struct.unpack_from("<I", data, i)[0]
    return x

def crc32_nr(data, poly=0x04C11DB7, init=0xFFFFFFFF, xorout=0xFFFFFFFF):
    crc = init
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc ^ xorout

def test_names(pkt, data, tail):
    res = {}
    for start_name, d in (("6:", data), ("1:", pkt[1:-4]), ("0:", pkt[:-4])):
        want_be = struct.unpack(">I", tail)[0]; want_le = struct.unpack("<I", tail)[0]
        c = zlib.crc32(d) & 0xFFFFFFFF
        res[f"crc32[{start_name}]"] = (c == want_be, c == want_le)
        a = zlib.adler32(d) & 0xFFFFFFFF
        res[f"adler[{start_name}]"] = (a == want_be, a == want_le)
        f = fletcher32(d)
        res[f"fletch[{start_name}]"] = (f == want_be, f == want_le)
        s = sum32(d)
        res[f"sum32[{start_name}]"] = (s == want_be, s == want_le)
        x = xorw32(d)
        res[f"xorw[{start_name}]"] = (x == want_be, x == want_le)
        n = crc32_nr(d)
        res[f"crc32nr[{start_name}]"] = (n == want_be, n == want_le)
    return res

hits = collections.Counter()
for pkt in big:
    data = pkt[6:-4]; tail = pkt[-4:]
    for name, (be, le) in test_names(pkt, data, pkt[-4:]).items():
        if be: hits[name + "/BE"] += 1
        if le: hits[name + "/LE"] += 1
print("checksum hits across all", len(big), "big packets:")
for k, v in hits.items(): print("  ", k, v)

# ---- ordered session dump (the big log) ----
print("\n--- ordered session: 23-10-11 18-05-56log.txt ---")
seq = [(d, b) for fn, d, b in frames if fn == "23-10-11 18-05-56log.txt"]
for i, (d, b) in enumerate(seq):
    if len(b) > 32:
        print(f"{i:3d} {d} len={len(b):5d} 0x69pkt hdr5={b[1:6].hex(' ')} payload[0:12]={b[6:18].hex(' ')} tail={b[-4:].hex()}")
    else:
        print(f"{i:3d} {d} {b.hex(' ')}")

# ---- extract payloads in order, save ----
payloads = []
for d, b in seq:
    if d == "TX" and len(b) > 32 and b[0] == 0x69:
        payloads.append((b[1:6].hex(), b[6:-4]))
print("\npayload total:", sum(len(p) for _, p in payloads))
out = open("/home/z/my-project/work/flash_session_payloads.bin", "wb")
for h5, p in payloads:
    out.write(p)
out.close()
print("saved /home/z/my-project/work/flash_session_payloads.bin")

# header payload detail
hdr = payloads[1][1]
print("\nheader payload (1008B) layout:")
print(hdr[:64].hex(' '))
print("ascii:", "".join(chr(c) if 32 <= c < 127 else "." for c in hdr[:96]))
print("ENTY area:", hdr[96:130].hex(' '))
print("ascii:", "".join(chr(c) if 32 <= c < 127 else "." for c in hdr[96:130]))
# find non-zero regions
nz = [i for i, c in enumerate(hdr) if c]
print("non-zero offsets:", nz[:50], "... total", len(nz))
