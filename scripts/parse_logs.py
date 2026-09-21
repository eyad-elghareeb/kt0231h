#!/usr/bin/env python3
"""Parse KT BOOT TOOL hex logs -> frame inventory + protocol inference."""
import os, re, json, collections

LOG_DIR = "/home/z/my-project/extracted/writechip/writechip/writechip/Log"

def parse_logs():
    frames = []  # (logfile, dir, bytes)
    for fn in sorted(os.listdir(LOG_DIR)):
        path = os.path.join(LOG_DIR, fn)
        for line in open(path, errors="replace"):
            m = re.match(r"\s*(TX|RX)\s*:\s*(.*)", line)
            if not m:
                continue
            h = m.group(2).strip()
            if not h:
                continue
            try:
                b = bytes.fromhex(h.replace(" ", ""))
            except ValueError:
                continue
            frames.append((fn, m.group(1), b))
    return frames

frames = parse_logs()
print(f"total frames: {len(frames)}")

# ---- classify TX by length & ascii content ----
def ascii_of(b):
    return "".join(chr(c) if 32 <= c < 127 else "." for c in b)

tx_lens = collections.Counter(len(b) for _, d, b in frames if d == "TX")
rx_lens = collections.Counter(len(b) for _, d, b in frames if d == "RX")
print("TX length histogram:", dict(sorted(tx_lens.items())[:20]))
print("RX length histogram:", dict(sorted(rx_lens.items())[:20]))

# unique TX frames that are short (commands, not data)
print("\n--- unique TX frames <= 32 bytes (count) ---")
short_tx = collections.Counter(bytes(b) for _, d, b in frames if d == "TX" and len(b) <= 32)
for b, n in sorted(short_tx.items()):
    print(f"{n:6d}x  {b.hex(' '):60s}  |{ascii_of(b)}|")

print("\n--- unique RX frames <= 32 bytes (count) ---")
short_rx = collections.Counter(bytes(b) for _, d, b in frames if d == "RX" and len(b) <= 32)
for b, n in sorted(short_rx.items()):
    print(f"{n:6d}x  {b.hex(' '):60s}  |{ascii_of(b)}|")

# TX frames > 32 bytes: first 16 bytes as command signature
print("\n--- TX >32B: signatures (first 16B) ---")
sig = collections.Counter((len(b), bytes(b[:16])) for _, d, b in frames if d == "TX" and len(b) > 32)
for (l, s), n in sorted(sig.items()):
    print(f"{n:6d}x len={l:6d}  {s.hex(' ')}")
