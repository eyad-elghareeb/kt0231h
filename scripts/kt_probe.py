#!/usr/bin/env python3
"""Read-only register probe for KTMicro USB audio DSPs (KT0231H / KT0211L / KT02H20).

This tool was written for *hardware verification without touching device state*:
the only command it can ever put on the wire is `0x52` ('R'). There is no
write/test/mutate code path in this file — greppable guarantee, not a promise.

⚠⚠ DO NOT SEND `0x08` ON THESE CHIPS ⚠⚠
    Upstream (`ktmicro-tools`) documents `0x08` as "read extended space". On a
    live KT0211L that opcode is NOT a read: sending it (2026-09-21) crashed the
    DSP/audio path — the dongle emitted a loud screech and stopped producing
    correct audio until it was re-plugged. The earlier `ext` command that could
    emit 0x08 was removed from this tool for that reason. The handshake `0x43`
    is unsafe too (stalls the HID pipe on KT0231H — see PROTOCOL.md §1).
    **0x52 reads are the only command proven safe on the 0x0111/0x1132 parts.**

Protocol (PROTOCOL.md §1): 11-byte HID reports led by report ID 0x4B
  TX: 4B [addr LE32] 52 00 00 00 00 00
  RX: 4B [addr LE32] 52 00 [value LE32]

Usage
  python scripts/kt_probe.py list                      # enumerate KT HID interfaces
  python scripts/kt_probe.py state                     # decoded identity/EQ/volume/DRC
  python scripts/kt_probe.py dump                      # 0x00-0xFF -> dumps/*.json + *.md
  python scripts/kt_probe.py dump --range 0x30:0x40    # partial sweep
  python scripts/kt_probe.py watch 0x24 --count 5      # sample one register
  python scripts/kt_probe.py diff a.json b.json        # compare two dumps

Requires: pip install hidapi
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import struct
import sys
import time

try:
    import hid
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("hidapi missing: pip install hidapi")

# ── protocol constants ─────────────────────────────────────────
KT_VID      = 0x31B2
RPT_ID      = 0x4B
RPT_SIZE    = 11
CMD_READ    = 0x52   # 'R' — the ONLY command this tool emits
ADDR_MAX    = 0xFF   # 0x52 covers 0x00-0xFF only; anything else is off-limits
UNSAFE_CMDS = {0x08: 'crashed the KT0211L DSP/audio path (screech) on 2026-09-21',
               0x43: 'stalls the HID pipe on KT0231H (PROTOCOL.md §1)'}

RUN_PIDS = {
    0x1132: 'KT0231H',
    0x0111: 'KT0211L/KT02H20',
    0x0101: 'bootloader (feature reports, not handled here)',
}

# ── register maps ──────────────────────────────────────────────
# KT0231H: 6-band dual bank, hardware-verified 2026-09-21 (README/§2).
# KT0211L / KT02H20: 5-band dual bank, upstream-verified on KT02H20 and
#   re-verified read-only on KT0211L (this tool).
PROFILES = {
    'KT0231H': dict(
        name='KT0231H', vid=KT_VID, pid=0x1132, bands=6, stride=2,
        dac_en=0x34, dac_base=0x35, adc_en=0x41, adc_base=0x42,
        version=0x06, manuf=0x40, product=0x48, serial=0x50, vidpid=0x1B,
        magic=0x60, flags=0x01,
    ),
    'KT0211L': dict(
        name='KT0211L', vid=KT_VID, pid=0x0111, bands=5, stride=2,
        dac_en=0x24, dac_base=0x26, adc_en=0x18, adc_base=0x1A,
        version=0x04, manuf=0x40, product=0x48, serial=0x50, vidpid=0x5B,
        magic=0xE1, flags=0x01,
    ),
    'KT02H20': dict(
        name='KT02H20', vid=KT_VID, pid=0x0111, bands=5, stride=2,
        dac_en=0x24, dac_base=0x26, adc_en=0x18, adc_base=0x1A,
        version=0x04, manuf=0x40, product=0x48, serial=0x50, vidpid=0x5B,
        magic=0xE1, flags=0x01,
    ),
}

# 0x0111 is shared by KT0211L and KT02H20 — product string decides (same rule
# as app.js resolveProfile(): name first, VID:PID as fallback).
NAME_HINTS = [('KT0211', 'KT0211L'), ('0211L', 'KT0211L'), ('CDS', 'KT0211L'),
              ('KT02H20', 'KT02H20'), ('02H20', 'KT02H20'), ('JM12', 'KT02H20')]

PGA_ADC_GAINS = ['0 dB', '-6 dB', '8 dB', '14 dB', '20 dB', '26 dB', '32 dB', '44 dB']
PGA_DAC_GAINS = ['mute'] + [f"{1.5 * (i - 1) - 18:+.1f} dB" for i in range(1, 16)]
FILTER_TYPES  = {0: 'Peak', 1: 'LPF', 2: 'HPF', 3: 'Low Shelf', 4: 'High Shelf'}

# DRC blocks (vendor + upstream verified on the 0x0111 family)
DRC_BLOCKS = {'NoiseGate 0x71': 0x71, 'NoiseGate 0x72': 0x72, 'NoiseGate 0x73': 0x73,
              'Limiter 0x78': 0x78, 'Limiter 0x79': 0x79}

# addresses the semantic decoder understands (used by the "unknown non-zero" sweep)
KNOWN_ADDRS = set(range(0x00, 0x0E)) | set(range(0x40, 0x57)) | {0x01, 0x5B, 0xE1}

# volume registers: known-good on 0x0111 family; on KT0231H 0x3A/0x3B are EQ
# regs and 0x65/0x66 read 0 (README "known gaps" #2) — flagged, not trusted.
def profile_volume(profile: dict) -> dict:
    return dict(
        pga_adc=0x3A, pga_dac=0x3B, dig_adc=0x65, dig_dac=0x66,
        best_effort=(profile['name'] == 'KT0231H'),
    )


# ── transport (read-only) ──────────────────────────────────────
class ReadOnlyKT:
    """HID transport that can only issue read requests.

    Deliberately exposes no write method: every public entry point funnels
    into `read_reg()` / `read_ext()`, both of which build `CMD_READ` frames.
    """

    def __init__(self, vid=KT_VID, pid=0x0111, iface=None, verbose=False):
        self.vid, self.pid, self.iface = vid, pid, iface
        self.verbose = verbose
        self.dev = None
        self.path = None
        self.tx_count = 0

    # ---- discovery ----
    @staticmethod
    def enumerate(vid=KT_VID):
        out = []
        for d in hid.enumerate():
            if d.get('vendor_id') == vid:
                out.append(d)
        return sorted(out, key=lambda d: (d.get('product_id', 0), d.get('interface_number', 0)))

    def open(self):
        cands = [d for d in hid.enumerate(self.vid, self.pid)]
        if self.iface is not None:
            cands = [d for d in cands if d.get('interface_number') == self.iface]
        if not cands:
            return False
        d = cands[0]
        self.dev = hid.device()
        self.dev.open_path(d['path'])
        self.path = d['path'].decode(errors='replace')
        if self.verbose:
            print(f"[open] {self.path}\n       usage_page={d.get('usage_page')} "
                  f"usage={d.get('usage')} product={d.get('product_string')!r}")
        # KTMicro parts want a moment after open before the first frame
        time.sleep(0.05)
        try:
            self.dev.set_nonblocking(0)
        except Exception:
            pass
        return True

    def close(self):
        if self.dev is not None:
            self.dev.close()
            self.dev = None

    def __enter__(self):
        if not self.open():
            raise ConnectionError(f"no KTMicro HID device {self.vid:04X}:{self.pid:04X}"
                                  + (f" interface {self.iface}" if self.iface is not None else ""))
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # ---- low level ----
    def _frame(self, addr: int, cmd: int, tail: bytes = b'\x00' * 5) -> bytes:
        assert cmd in (CMD_READ, CMD_READ_EXT), 'read-only transport'
        payload = struct.pack('<I', addr & 0xFFFFFFFF) + bytes([cmd]) + tail
        return bytes([RPT_ID]) + payload[:10]

    def _exchange(self, frame: bytes, timeout_ms=500, retries=2):
        """Send one read frame, return the raw 11-byte reply (or None)."""
        for attempt in range(retries + 1):
            try:
                self.tx_count += 1
                self.dev.write(frame)
                rx = self.dev.read(RPT_SIZE, timeout_ms=timeout_ms)
            except OSError as err:
                if self.verbose:
                    print(f"[wx] {err}")
                rx = None
            if rx:
                if self.verbose:
                    print(f"[rx] {bytes(rx).hex(' ')}")
                return bytes(rx)
            time.sleep(0.01)
        return None

    # ---- public reads ----
    @staticmethod
    def _strip_rid(rx: bytes) -> bytes:
        """hidapi/Windows keeps the report ID in the buffer; WebHID does not.

        Normalise to the WebHID/app.js layout: [addr LE32][cmd][pad][value LE32].
        """
        if rx and rx[0] == RPT_ID:
            return bytes(rx[1:])
        return bytes(rx)

    def read_reg(self, addr: int):
        """Read one 32-bit register at `addr` (0x00-0xFF). None on timeout."""
        rx = self._exchange(self._frame(addr, CMD_READ))
        if rx is None:
            return None
        r = self._strip_rid(rx)
        if len(r) < 10 or r[4] != CMD_READ:      # r[4] echoes the command byte
            return None
        return struct.unpack('<I', r[6:10])[0]

    def read_ext(self, addr: int):
        """Read the extended space (>0x100) via 0x08. Returns None if unsupported."""
        rx = self._exchange(self._frame(addr, CMD_READ_EXT, tail=b'\x00' * 5),
                            timeout_ms=300)
        if rx is None:
            return None
        r = self._strip_rid(rx)
        if len(r) < 10:
            return None
        if r[4] == CMD_READ_EXT:
            return struct.unpack('<I', r[6:10])[0]
        return struct.unpack('<I', r[0:4])[0]    # documented alt layout: value first

    def read_many(self, addrs, settle=0.002):
        out = {}
        for a in addrs:
            out[a] = self.read_reg(a)
            if settle:
                time.sleep(settle)
        return out
# ── decoding helpers ───────────────────────────────────────────
def ascii_from_regs(regs, start, count, strip=True):
    """Decode `count` consecutive LE32 registers into an ASCII string."""
    chars = []
    for a in range(start, start + count):
        v = regs.get(a)
        if v is None:
            continue
        for b in (v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF):
            chars.append(chr(b) if 32 <= b < 127 else '')
    s = ''.join(chars)
    return s.replace('\x00', '').strip() if strip else s


def sig16(v):  # signed 16-bit
    return v - 0x10000 if v & 0x8000 else v


def sig8(v):   # signed 8-bit
    return v - 0x100 if v & 0x80 else v


def decode_band(a_reg, b_reg):
    """[freq_Hz:16][gain×10 s16] / [type:3][Q×1000:16] → dict.

    Matches app.js decodeBand(): freq = hi16 of A, gain = lo16 of A / 10,
    type = bits 16-18 of B, Q = lo16 of B / 1000.
    """
    if a_reg is None or b_reg is None:
        return None
    return {
        'freq': (a_reg >> 16) & 0xFFFF,
        'gain': sig16(a_reg & 0xFFFF) / 10.0,
        'type_raw': (b_reg >> 16) & 0x7,
        'q': (b_reg & 0xFFFF) / 1000.0,
    }


def decode_eq_bank(regs, base, bands, stride=2):
    out = []
    for i in range(bands):
        out.append(decode_band(regs.get(base + i * stride), regs.get(base + i * stride + 1)))
    return out


def decode_dig(v):
    """Digital gain byte: signed, 0.5 dB steps."""
    if v is None:
        return None
    return sig8(v & 0xFF) / 2.0


def decode_drc(regs):
    """NoiseGate 0x71-0x73 + Limiter 0x78-0x79 (vendor/upstream encoding)."""
    out = {}
    v71, v72, v73 = regs.get(0x71), regs.get(0x72), regs.get(0x73)
    v78, v79 = regs.get(0x78), regs.get(0x79)
    if v71 is not None:
        out['ng'] = {
            'en': bool((v71 >> 31) & 1),
            'flags': (v71 >> 24) & 0x7F,
            'gatevol_db': ((v71 >> 16) & 0xFF) - 256,
            'th_high_db': ((v71 >> 8) & 0xFF) - 256,
            'th_low_db': (v71 & 0xFF) - 256,
        }
    if v72 is not None:
        out['ng_at_rt'] = {'at_ms': v72 & 0xFFFF, 'rt_ms': (v72 >> 16) & 0xFFFF}
    if v73 is not None:
        out['ng_hold'] = {'hold': v73 & 0xFFFF, 'noise_t_ms': (v73 >> 16) & 0xFFFF}
    if v78 is not None:
        out['lim'] = {
            'en': bool((v78 >> 31) & 1),
            'soft': bool((v78 >> 30) & 1),
            'threshold_db': (v78 & 0xFF) - 256,
        }
    if v79 is not None:
        out['lim_at_rt'] = {'at_ms': v79 & 0xFFFF, 'rt_ms': (v79 >> 16) & 0xFFFF}
    return out


def decode_snapshot(regs, profile):
    """Full semantic decode of a register dump for `profile`."""
    p = profile
    vol = profile_volume(p)
    s = {
        'profile': p['name'],
        'identity': {
            'marker_0x00': ascii_from_regs(regs, 0x00, 1) or None,
            'flags_0x01': None,
            'version': ascii_from_regs(regs, p['version'], 2),
            'date': ascii_from_regs(regs, 0x08, 6),
            'manufacturer': ascii_from_regs(regs, p['manuf'], 8),
            'product': ascii_from_regs(regs, p['product'], 8),
            'serial': ascii_from_regs(regs, p['serial'], 7),
        },
        'volume': {'best_effort': vol['best_effort']},
        'eq': {},
        'drc': decode_drc(regs),
    }
    flags = regs.get(p['flags'])
    if flags is not None:
        model = 'single-DAC' if flags & 0x0200 else 'stereo-DAC'
        s['identity']['flags_0x01'] = f"0x{flags:08X} ({model})"
    vp = regs.get(p['vidpid'])
    if vp is not None:
        s['identity'][f"vidpid_0x{p['vidpid']:02X}"] = f"{(vp >> 16) & 0xFFFF:04X}:{vp & 0xFFFF:04X}"
    mg = regs.get(p['magic'])
    if mg is not None:
        s['identity'][f"magic_0x{p['magic']:02X}"] = f"0x{mg:08X}"

    pa, pd = regs.get(vol['pga_adc']), regs.get(vol['pga_dac'])
    if pa is not None:
        idx = pa & 0xFF
        s['volume']['pga_adc'] = {'reg': hex(vol['pga_adc']), 'raw': f"0x{pa:08X}", 'idx': idx,
                                  'gain': PGA_ADC_GAINS[idx] if idx < len(PGA_ADC_GAINS) else '?'}
    if pd is not None:
        idx = pd & 0xFF
        s['volume']['pga_dac'] = {'reg': hex(vol['pga_dac']), 'raw': f"0x{pd:08X}", 'idx': idx,
                                  'gain': PGA_DAC_GAINS[idx] if idx < len(PGA_DAC_GAINS) else '?'}
    da, dd = regs.get(vol['dig_adc']), regs.get(vol['dig_dac'])
    if da is not None:
        s['volume']['dig_adc'] = {'reg': hex(vol['dig_adc']), 'raw': f"0x{da:08X}",
                                  'db_byte0': decode_dig(da)}
    if dd is not None:
        s['volume']['dig_dac'] = {'reg': hex(vol['dig_dac']), 'raw': f"0x{dd:08X}",
                                  'db_byte0': decode_dig(dd), 'db_byte1': decode_dig(dd >> 8)}

    for bank, en_addr, base in (('DAC', p['dac_en'], p['dac_base']),
                               ('ADC', p['adc_en'], p['adc_base'])):
        en = regs.get(en_addr)
        s['eq'][bank] = {
            'enable_reg': hex(en_addr),
            'enable_raw': None if en is None else f"0x{en:08X}",
            'enable_bit0': None if en is None else bool(en & 1),
            'enable_extra_bits': None if en is None else f"0x{en & ~1:08X}",
            'bands': decode_eq_bank(regs, base, p['bands'], p['stride']),
        }
    return s


# ── reporting ──────────────────────────────────────────────────
def ascii_row(v):
    raw = struct.pack('<I', v) if v is not None else b''
    return ''.join(chr(c) if 32 <= c < 127 else '.' for c in raw)


def reg_table_md(regs):
    lines = ['| Addr | Value | Bytes | ASCII |', '|------|-------|-------|-------|']
    for a in sorted(regs):
        v = regs[a]
        if v is None:
            lines.append(f"| 0x{a:02X} | *(timeout)* | | |")
            continue
        lines.append(f"| 0x{a:02X} | 0x{v:08X} | {struct.pack('<I', v).hex(' ')} | `{ascii_row(v)}` |")
    return '\n'.join(lines)


def snapshot_md(snap):
    out = []
    ident = snap['identity']
    out.append('### Identity')
    out.append('')
    out.append('| Field | Value |')
    out.append('|-------|-------|')
    for k, v in ident.items():
        out.append(f"| {k} | `{v}` |")
    out.append('')
    out.append('### Volume')
    out.append('')
    vol = snap['volume']
    out.append(f"*best-effort (map unverified on this chip): {vol['best_effort']}*")
    out.append('')
    out.append('| Register | Raw | Decoded |')
    out.append('|----------|-----|---------|')
    if 'pga_adc' in vol:
        out.append(f"| A_ADC PGA ({vol['pga_adc']['reg']}) | `{vol['pga_adc']['raw']}` | "
                   f"idx {vol['pga_adc']['idx']} → {vol['pga_adc']['gain']} |")
    if 'pga_dac' in vol:
        out.append(f"| A_DAC PGA ({vol['pga_dac']['reg']}) | `{vol['pga_dac']['raw']}` | "
                   f"idx {vol['pga_dac']['idx']} → {vol['pga_dac']['gain']} |")
    if 'dig_adc' in vol:
        out.append(f"| DIG_ADC ({vol['dig_adc']['reg']}) | `{vol['dig_adc']['raw']}` | "
                   f"{vol['dig_adc']['db_byte0']:+.1f} dB |")
    if 'dig_dac' in vol:
        out.append(f"| DIG_DAC ({vol['dig_dac']['reg']}) | `{vol['dig_dac']['raw']}` | "
                   f"L {vol['dig_dac']['db_byte0']:+.1f} dB / R {vol['dig_dac']['db_byte1']:+.1f} dB |")
    out.append('')
    for bank in ('DAC', 'ADC'):
        eq = snap['eq'][bank]
        out.append(f"### {bank} EQ bank — enable @ {eq['enable_reg']} raw {eq['enable_raw']} "
                   f"(bit0={eq['enable_bit0']}, extra bits {eq['enable_extra_bits']})")
        out.append('')
        out.append('| # | Freq (Hz) | Gain (dB) | Q | Type |')
        out.append('|---|-----------|-----------|---|------|')
        for i, b in enumerate(eq['bands']):
            if b is None:
                out.append(f"| {i} | *(timeout)* | | | |")
                continue
            out.append(f"| {i} | {b['freq']} | {b['gain']:+.1f} | {b['q']:.3f} | "
                       f"{FILTER_TYPES.get(b['type_raw'], b['type_raw'])} |")
        out.append('')
    if snap['drc']:
        out.append('### DRC (as read)')
        out.append('')
        out.append('```json')
        out.append(json.dumps(snap['drc'], indent=2))
        out.append('```')
        out.append('')
    return '\n'.join(out)


def nonzero_sweep(regs, profile):
    """List non-zero addresses the semantic decoder does not cover."""
    p = profile
    known = set(KNOWN_ADDRS)
    known |= set(range(p['dac_en'], p['dac_base'] + p['bands'] * p['stride']))
    known |= set(range(p['adc_en'], p['adc_base'] + p['bands'] * p['stride']))
    known |= {0x3A, 0x3B, 0x65, 0x66, 0x71, 0x72, 0x73, 0x78, 0x79, p['vidpid'], p['magic']}
    out = []
    for a in sorted(regs):
        v = regs[a]
        if v is None or v == 0 or a in known:
            continue
        raw = struct.pack('<I', v)
        out.append({
            'addr': f"0x{a:02X}",
            'value': f"0x{v:08X}",
            'bytes': raw.hex(' '),
            'ascii': ''.join(chr(c) if 32 <= c < 127 else '.' for c in raw),
        })
    return out


# ── dump / report ──────────────────────────────────────────────
TOOL_VERSION = '1.0'


def pick_profile(pid, product, force=None):
    if force:
        return PROFILES[force]
    if pid == 0x1132:
        return PROFILES['KT0231H']
    if pid == 0x0111:
        up = (product or '').upper()
        for key, name in NAME_HINTS:
            if key.upper() in up:
                return PROFILES[name]
        return PROFILES['KT02H20']   # same fallback rule as app.js resolveProfile()
    return None


def meta_dict(conn, profile, extra=None):
    import platform
    m = {
        'tool': f"scripts/kt_probe.py v{TOOL_VERSION}",
        'read_only': True,
        'timestamp': _dt.datetime.now().isoformat(timespec='seconds'),
        'host': f"{platform.node()} / {platform.platform()}",
        'hid_path': conn.path,
        'vid_pid': f"{conn.vid:04X}:{conn.pid:04X}",
        'product_string': None,
        'profile': profile['name'] if profile else None,
        'tx_frames': conn.tx_count,
    }
    try:
        m['product_string'] = conn.dev.get_product_string()
        m['manufacturer_string'] = conn.dev.get_manufacturer_string()
    except Exception:
        pass
    if extra:
        m.update(extra)
    return m


def write_report(out_dir, name, meta, regs, snapshot, unknown):
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.join(out_dir, name)
    with open(base + '.json', 'w', encoding='utf-8') as f:
        json.dump({
            'meta': meta,
            'registers': {f"0x{a:02X}": v for a, v in sorted(regs.items())},
            'snapshot': snapshot,
            'unknown_nonzero': unknown,
        }, f, indent=2)
    with open(base + '.md', 'w', encoding='utf-8') as f:
        f.write(f"# KTMicro read-only register dump — {meta['profile']}\n\n")
        f.write(f"*{meta['timestamp']} · `{meta['vid_pid']}` · {meta['product_string']!r} · "
                f"`{meta['hid_path']}`*\n\n")
        f.write(f"Generator: `{meta['tool']}` — **read-only** (`0x52` read frames only, "
                f"{meta['tx_frames']} TX frames sent).\n\n")
        f.write(f"Registers read: {len(regs)} · timeouts: "
                f"{sum(1 for v in regs.values() if v is None)}\n\n")
        f.write(snapshot_md(snapshot))
        if unknown:
            f.write('### Non-zero registers outside the decoded map\n\n')
            f.write('| Addr | Value | Bytes | ASCII |\n|------|-------|-------|-------|\n')
            for u in unknown:
                f.write(f"| {u['addr']} | `{u['value']}` | {u['bytes']} | `{u['ascii']}` |\n")
            f.write('\n')
        f.write('### Raw register table\n\n')
        f.write(reg_table_md(regs))
        f.write('\n')
    return base


def parse_range(text):
    sep = ':' if ':' in text else ('-' if '-' in text else None)
    if sep:
        lo, hi = text.split(sep, 1)
    else:
        lo = hi = text
    return int(lo, 0), int(hi, 0)


# ── commands ───────────────────────────────────────────────────
def cmd_list(args):
    rows = ReadOnlyKT.enumerate(args.vid)
    if not rows:
        print(f"no HID device with VID 0x{args.vid:04X}")
        return 1
    print(f"{'PID':>6}  {'IF':>2}  {'usage':>10}  {'product':<24}  path")
    for d in rows:
        usage = f"{d.get('usage_page')}:{d.get('usage')}"
        print(f"{d.get('product_id', 0):#06x}  {d.get('interface_number', -1):>2}  "
              f"{usage:>10}  {(d.get('product_string') or '')[:24]:<24}  "
              f"{d['path'].decode(errors='replace')}")
    return 0


def connect(args):
    conn = ReadOnlyKT(vid=args.vid, pid=args.pid, iface=args.iface, verbose=args.verbose)
    if args.pid == 0x0101:
        raise SystemExit("0x0101 is the bootloader (feature reports) — not handled here")
    if not conn.open():
        raise ConnectionError(f"no device {args.vid:04X}:{args.pid:04X}"
                              + (f" iface {args.iface}" if args.iface is not None else ""))
    product = conn.dev.get_product_string()
    profile = pick_profile(args.pid, product, force=args.chip)
    if profile is None:
        conn.close()
        raise SystemExit(f"unknown chip for PID 0x{args.pid:04X}")
    return conn, profile

def cmd_state(args, conn, profile):
    p = profile
    addrs = sorted(set(
        list(range(0x00, 0x0E)) +
        list(range(p['adc_en'], p['adc_base'] + p['bands'] * p['stride'])) +
        list(range(p['dac_en'], p['dac_base'] + p['bands'] * p['stride'])) +
        [0x3A, 0x3B, 0x65, 0x66, 0x71, 0x72, 0x73, 0x78, 0x79, p['vidpid'], p['magic']] +
        list(range(p['manuf'], p['manuf'] + 8)) +
        list(range(p['product'], p['product'] + 8)) +
        list(range(p['serial'], p['serial'] + 7)) +
        list(range(p['version'], p['version'] + 2))
    ))
    regs = conn.read_many(addrs, settle=args.settle)
    snap = decode_snapshot(regs, profile)
    print(f"# {snap['profile']} — read-only snapshot ({conn.path.split('#')[-1]})\n")
    print(snapshot_md(snap))
    return 0


def cmd_dump(args, conn, profile):
    lo, hi = args.range
    addrs = list(range(lo, hi + 1))
    print(f"reading {len(addrs)} registers (0x{lo:02X}-0x{hi:02X}) …")
    regs = conn.read_many(addrs, settle=args.settle)
    timeouts = [a for a, v in regs.items() if v is None]
    snap = decode_snapshot(regs, profile)
    unknown = nonzero_sweep(regs, profile)
    stamp = _dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    name = args.name or f"{profile['name'].lower()}-readonly-{stamp}"
    meta = meta_dict(conn, profile, extra={
        'range': f"0x{lo:02X}-0x{hi:02X}",
        'timeouts': [f"0x{a:02X}" for a in timeouts],
    })
    base = write_report(args.out, name, meta, regs, snap, unknown)
    print(f"wrote {base}.json / {base}.md")
    if timeouts:
        print(f"timeouts: {', '.join(f'0x{a:02X}' for a in timeouts)}")
    print(snapshot_md(snap))
    if unknown:
        print('non-zero registers outside the decoded map:')
        for u in unknown:
            print(f"  {u['addr']}  {u['value']}  {u['bytes']}  |{u['ascii']}|")
    return 0


def cmd_watch(args, conn, profile):
    print(f"# watch 0x{args.addr:02X} x{args.count} @ {args.interval} ms")
    for i in range(args.count):
        v = conn.read_reg(args.addr)
        ts = _dt.datetime.now().strftime('%H:%M:%S.%f')[:-3]
        print(f"{ts}  [{i:02d}]  " + ("(timeout)" if v is None else f"0x{v:08X}"))
        if i + 1 < args.count:
            time.sleep(args.interval / 1000.0)
    return 0


def cmd_ext(args, conn, profile):
    print(f"# extended-space read (0x08) 0x{args.start:02X}+{args.count}")
    found = 0
    for i in range(args.count):
        a = args.start + i
        v = conn.read_ext(a)
        if v is None:
            print(f"  0x{a:05X}  (no response)")
            continue
        found += 1
        raw = struct.pack('<I', v)
        print(f"  0x{a:05X}  0x{v:08X}  {raw.hex(' ')}  |{ascii_row(v)}|")
    print(f"{found}/{args.count} addresses answered")
    return 0


def cmd_diff(args):
    def load(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    a, b = load(args.a), load(args.b)
    ra = {int(k, 16): v for k, v in a['registers'].items()}
    rb = {int(k, 16): v for k, v in b['registers'].items()}
    print(f"A: {a['meta']['profile']} {a['meta']['timestamp']} ({args.a})")
    print(f"B: {b['meta']['profile']} {b['meta']['timestamp']} ({args.b})")
    diffs = [(addr, ra[addr], rb[addr]) for addr in sorted(set(ra) & set(rb))
             if ra[addr] != rb[addr]]
    if not diffs:
        print('identical')
    for addr, va, vb in diffs:
        fa = '(nil)' if va is None else f"0x{va:08X}"
        fb = '(nil)' if vb is None else f"0x{vb:08X}"
        print(f"  0x{addr:02X}  {fa}  ->  {fb}")
    for tag, lst in (('only in A', sorted(set(ra) - set(rb))),
                     ('only in B', sorted(set(rb) - set(ra)))):
        if lst:
            print(f"{tag}: {', '.join(f'0x{x:02X}' for x in lst)}")
    return 0

def resolve_pid(args):
    if args.pid is not None:
        return args.pid
    have = {d['product_id'] for d in ReadOnlyKT.enumerate(args.vid)}
    for pid in (0x1132, 0x0111, 0x0101):
        if pid in have:
            return pid
    raise SystemExit(f"no KTMicro device with VID 0x{args.vid:04X} found")


def add_common(sp):
    sp.add_argument('--vid', type=lambda s: int(s, 0), default=KT_VID)
    sp.add_argument('--pid', type=lambda s: int(s, 0), default=None,
                    help='USB product id (default: auto — 0x1132, then 0x0111)')
    sp.add_argument('--iface', type=int, default=3, help='HID interface number (default 3)')
    sp.add_argument('--chip', choices=sorted(PROFILES), default=None,
                    help='force a register-map profile')
    sp.add_argument('--settle', type=float, default=0.002, help='delay between reads (s)')
    sp.add_argument('-v', '--verbose', action='store_true')


def main(argv=None):
    try:                                   # Windows consoles are cp1252 — keep
        sys.stdout.reconfigure(errors='replace')   # the dump files UTF-8 but never crash
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)

    sp = sub.add_parser('list', help='enumerate KTMicro HID interfaces'); add_common(sp)

    sp = sub.add_parser('state', help='decoded read-only snapshot'); add_common(sp)

    sp = sub.add_parser('dump', help='sweep registers and save JSON/MD evidence')
    add_common(sp)
    sp.add_argument('--range', type=parse_range, default=(0x00, 0xFF))
    sp.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), 'dumps'))
    sp.add_argument('--name', default=None)

    sp = sub.add_parser('watch', help='sample one register repeatedly'); add_common(sp)
    sp.add_argument('addr', type=lambda s: int(s, 0))
    sp.add_argument('--count', type=int, default=5)
    sp.add_argument('--interval', type=int, default=250, help='ms between samples')

    sp = sub.add_parser('ext', help='probe the >0x100 space via 0x08'); add_common(sp)
    sp.add_argument('--start', type=lambda s: int(s, 0), default=0x100)
    sp.add_argument('--count', type=int, default=32)

    sp = sub.add_parser('diff', help='compare two dump JSONs')
    sp.add_argument('a'); sp.add_argument('b')

    args = ap.parse_args(argv)
    if args.cmd == 'list':
        return cmd_list(args)
    if args.cmd == 'diff':
        return cmd_diff(args)

    args.pid = resolve_pid(args)
    conn, profile = connect(args)
    try:
        if args.cmd == 'state':
            return cmd_state(args, conn, profile)
        if args.cmd == 'dump':
            return cmd_dump(args, conn, profile)
        if args.cmd == 'watch':
            return cmd_watch(args, conn, profile)
        if args.cmd == 'ext':
            return cmd_ext(args, conn, profile)
    finally:
        conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())

