/**
 * KT0231H DAC Control — Offline App  |  app.js  v5
 * ─────────────────────────────────────────────────────────
 * KTMicro register-level DSP control (WebHID)
 *  - KT0231H  (0x31B2:0x1132): 6-band DAC PEQ @ 0x35-0x40 (primary target)
 *  - KT02H20  (0x31B2:0x0111): 5-band DAC PEQ @ 0x26-0x2F (legacy compat)
 * Protocol: 0x4B HID report, 0x52 read / 0x57 write registers
 *
 * v5:  KT0231H support (6 bands, per-profile register maps, VID:PID match,
 *      best-effort volume reads). KT02H20 kept as fallback profile.
 * v6:  Explicit KT0211L profile (shares PID 0x0111 with KT02H20 — told apart
 *      by product-name match). Name match now runs before VID:PID.
 * v4:  register-protocol rewrite (legacy AA/BB command protocol removed)
 *      debug logging, report-ID probe, single-frame send/recv
 *
 * Features:
 *  A  CommandQueue dedup by key (rapid slider → 1 send)
 *  B  Band-freq label sync on edit
 *  C  Queue pending badge
 *  D  Canvas ResizeObserver
 *  E  Band markers on curve
 *  F  Non-blocking toasts
 *  G  Gain color tinting
 *  H  JSON import validation
 *  I  Keyboard shortcuts (R/W/Ctrl+S/Ctrl+Z/Esc)
 *  J  Single-band undo
 */

'use strict';

/* ════════════════════════════════════════════════════════════
   § 1  PROTOCOL CONSTANTS  (defaults = KT02H20 register map;
       per-chip overrides live in PROFILES §3 — hid.reg() wins)
════════════════════════════════════════════════════════════ */

const RPT_ID   = 0x4B;

const CMD_READ  = 0x52;  // 'R' — Read Register
const CMD_WRITE = 0x57;  // 'W' — Write Register (device ACKs with 0x03)
const WRITE_ACK = 0x03;

const REG = Object.freeze({
  MARKER:   0x00,
  FLAGS:    0x01,   // bit9 (0x0200) = single-DAC model
  VERSION:  0x04,   // 2 regs, LE32 ASCII
  TIMESTAMP:0x08,   // date string
  MANUF:    0x40,   // USB manufacturer string (8 regs)
  PRODUCT:  0x48,   // USB product string (8 regs)
  SERIAL:   0x50,   // USB serial string (7 regs)
  VIDPID:   0x5B,   // [PID:16][VID:16]
  EQ_ADC_EN:0x18,   // bit0 = ADC EQ enable
  EQ_ADC:   0x1A,   // ADC EQ bands (5×2 regs)
  EQ_DAC_EN:0x24,   // bit0 = DAC EQ enable
  EQ_DAC:   0x26,   // DAC EQ bands (5×2 regs)
  EQ_STRIDE:2,
  EQ_BANDS: 5,
  PGA_ADC:  0x3A,
  PGA_DAC:  0x3B,
  DIG_ADC:  0x65,   // byte0 = signed gain×2 (0.5 dB)
  DIG_DAC:  0x66,   // byte0 = DACL, byte1 = DACR (single-DAC: byte0 only)
  MAGIC:    0xE1,   // 0x12345678
});

/* ── PGA gain tables (comboBox index → label) ── */
const PGA_ADC_GAINS = ['0 dB', '-6 dB', '8 dB', '14 dB', '20 dB', '26 dB', '32 dB', '44 dB'];
const PGA_DAC_GAINS = ['mute', ...Array.from({length: 15}, (_, i) => `${(1.5*i - 18).toFixed(1)} dB`)];


/* ════════════════════════════════════════════════════════════
   § 2  COMMAND QUEUE
   Serial, 100 ms gap. Dedup by key: rapid slider → last send wins.
════════════════════════════════════════════════════════════ */
class CommandQueue {
  #q    = [];
  #busy = false;
  #gap;
  #onSizeChange = null;

  constructor(gapMs = 100) { this.#gap = gapMs; }

  get size() { return this.#q.length + (this.#busy ? 1 : 0); }

  onSizeChange(fn) { this.#onSizeChange = fn; }

  add(task, key = null) {
    return new Promise((res, rej) => {
      if (key !== null) {
        const idx = this.#q.findIndex(t => t.key === key);
        if (idx !== -1) {
          const existing = this.#q[idx];
          const superseded = existing.superseded
            ? [...existing.superseded, existing.res]
            : [existing.res];
          const wrapped = async () => {
            const result = await task();
            superseded.forEach(fn => fn(result));
            return result;
          };
          this.#q[idx] = { key, task: wrapped, res, rej, superseded };
          this.#notify();
          return;
        }
      }
      this.#q.push({ key, task, res, rej, superseded: [] });
      this.#notify();
      this.#drain();
    });
  }

  async #drain() {
    if (this.#busy) return;
    this.#busy = true;
    this.#notify();
    while (this.#q.length) {
      const { task, res, rej, superseded = [] } = this.#q.shift();
      this.#notify();
      try {
        const result = await task();
        superseded.forEach(fn => fn(result));
        res(result);
      } catch (e) { rej(e); }
      if (this.#q.length) await sleep(this.#gap);
    }
    this.#busy = false;
    this.#notify();
  }

  #notify() { this.#onSizeChange?.(this.size); }

  clear() {
    this.#q.forEach(({ rej }) => rej(new Error('Queue cleared')));
    this.#q = [];
    this.#notify();
  }
}


/* ════════════════════════════════════════════════════════════
   § 3  DEVICE PROFILES
════════════════════════════════════════════════════════════ */
/* KT0231H register map — ASR post #560 (CedarX, Nov 2025) PLUS live hardware
   verification on 0x31B2:0x1132 (2026-09-21, hidapi register dump + write test):
   - DAC PEQ = 6 bands @ 0x35-0x40, enable @ 0x34 (= base-1, NOT base-2 as on
     KT02H20). Factory defaults: 61/122/184/248/316/392 Hz, 0 dB, Peak, Q 0.700.
   - Second 6-band bank @ 0x42-0x4D, enable @ 0x41, same defaults (ADC side).
   - WRITE SUCCESS CODE IS 0x4F, not 0x03 — writes apply fine, only the ACK
     byte differs (proven by distinct-value write + readback + restore).
   - Version string @ 0x06, VID:PID @ 0x1B, serial @ 0x24, product @ 0x2C,
     MAGIC 0x12345678 @ 0x60. The 0x43 handshake is NOT needed (it stalls the
     HID pipe on this chip) — reads/writes work without it.
   - Volume regs still UNKNOWN: 0x3A/0x3B are EQ regs here (not PGA), 0x65/0x66
     read 0x00000000. PGA/DIG entries below are KT02H20 carry-overs read
     best-effort only. */
const FILTER_TYPES_5 = [
  { value: 0, label: 'Peak' },      { value: 1, label: 'LPF' },
  { value: 2, label: 'HPF' },       { value: 3, label: 'Low Shelf' },
  { value: 4, label: 'High Shelf' },
];

const PROFILES = {
  'KT0231H': {
    name: 'KT0231H', vid: 0x31B2, pid: 0x1132,
    matchKeys: ['KT0231H', '0231H'],
    reportId: RPT_ID, probeReportIds: false,
    writeAck: 0x4F, // hardware-verified: this chip ACKs writes with 0x4F
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    defaultBandCount: 6,
    defaultFreqs: [61, 122, 184, 248, 316, 392],
    defaultQ: 0.7,
    versionAddr: 0x06, versionCount: 2,
    reg: {
      EQ_DAC: 0x35, EQ_DAC_EN: 0x34, EQ_STRIDE: 2, EQ_BANDS: 6,
      PGA_ADC: 0x3A, PGA_DAC: 0x3B, DIG_ADC: 0x65, DIG_DAC: 0x66,
    },
    filterTypes: FILTER_TYPES_5,
  },
  'KT02H20': {
    name: 'KT02H20', vid: 0x31B2, pid: 0x0111,
    matchKeys: ['KT02H20', '02H20', 'JM12'],
    reportId: RPT_ID, probeReportIds: false,
    writeAck: WRITE_ACK,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    defaultBandCount: REG.EQ_BANDS,
    defaultFreqs: [60, 230, 910, 3600, 14000],
    defaultQ: 1.0,
    versionAddr: REG.VERSION, versionCount: 2,
    reg: {
      EQ_DAC: REG.EQ_DAC, EQ_DAC_EN: REG.EQ_DAC_EN,
      EQ_STRIDE: REG.EQ_STRIDE, EQ_BANDS: REG.EQ_BANDS,
      PGA_ADC: REG.PGA_ADC, PGA_DAC: REG.PGA_DAC,
      DIG_ADC: REG.DIG_ADC, DIG_DAC: REG.DIG_DAC,
    },
    filterTypes: FILTER_TYPES_5,
  },
  // Listed AFTER KT02H20 on purpose: both share PID 0x0111, so a nameless
  // 0x0111 device must fall through to KT02H20 by default. Name matches
  // ('CDS…'/'0211…') route here regardless of order.
  'KT0211L': {
    // Shares VID:PID 0x31B2:0x0111 with KT02H20 but reports its own product
    // string (seen: 'CDS.KT USB Audio', FW 'CDSV100.003'). Map verified by
    // live hidapi dump 2026-09-21: identical KT02H20 layout. NOTE: EQ enable
    // regs read 3, not 1 — bit1 meaning unknown, the app preserves it
    // (writes val|1 / val&~1, never a bare 0/1).
    name: 'KT0211L', vid: 0x31B2, pid: 0x0111,
    matchKeys: ['KT0211', '0211L', 'CDS'],
    reportId: RPT_ID, probeReportIds: false,
    writeAck: WRITE_ACK, // 0x03 confirmed live (write ACKed, readback matched)
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    defaultBandCount: REG.EQ_BANDS,
    defaultFreqs: [1000, 2000, 5000, 8000, 10000],
    defaultQ: 0.707,
    versionAddr: REG.VERSION, versionCount: 2,
    reg: {
      EQ_DAC: REG.EQ_DAC, EQ_DAC_EN: REG.EQ_DAC_EN,
      EQ_STRIDE: REG.EQ_STRIDE, EQ_BANDS: REG.EQ_BANDS,
      PGA_ADC: REG.PGA_ADC, PGA_DAC: REG.PGA_DAC,
      DIG_ADC: REG.DIG_ADC, DIG_DAC: REG.DIG_DAC,
    },
    filterTypes: FILTER_TYPES_5,
  },
};

const DEFAULT_PROFILE = {
  name: 'DEFAULT', vid: null, pid: null,
  reportId: RPT_ID, probeReportIds: true,
  writeAck: WRITE_ACK,
  gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
  defaultBandCount: REG.EQ_BANDS,
  defaultFreqs: [60, 230, 910, 3600, 14000],
  defaultQ: 1.0,
  versionAddr: REG.VERSION, versionCount: 2,
  reg: {
    EQ_DAC: REG.EQ_DAC, EQ_DAC_EN: REG.EQ_DAC_EN,
    EQ_STRIDE: REG.EQ_STRIDE, EQ_BANDS: REG.EQ_BANDS,
    PGA_ADC: REG.PGA_ADC, PGA_DAC: REG.PGA_DAC,
    DIG_ADC: REG.DIG_ADC, DIG_DAC: REG.DIG_DAC,
  },
  filterTypes: FILTER_TYPES_5,
};

function resolveProfile(productName = '', vendorId = null, productId = null) {
  // 1) product-name match first: KT0211L and KT02H20 share VID:PID 0x0111,
  //    so the name ('CDS…' vs 'KT02H20…') is the only way to tell them apart.
  const uname = (productName || '').toUpperCase();
  for (const p of Object.values(PROFILES)) {
    if ((p.matchKeys || []).some(k => uname.includes(k.toUpperCase()))) return p;
  }
  // 2) exact VID:PID fallback (catches renamed/blank product strings)
  //    NOTE: 0x0111 maps to KT02H20 here — a KT0211L with a wiped product
  //    string will land on KT02H20, which is register-identical for DAC EQ.
  for (const p of Object.values(PROFILES)) {
    if (p.vid !== null && vendorId !== null && productId !== null &&
        vendorId === p.vid && productId === p.pid) return p;
  }
  return DEFAULT_PROFILE;
}


/* ════════════════════════════════════════════════════════════
   § 4  HID CONTROLLER
════════════════════════════════════════════════════════════ */
class HIDController {
  #dev     = null;
  #profile = DEFAULT_PROFILE;
  #queue   = new CommandQueue(100);
  #onDisc  = null;

  constructor() {
    this.#queue.onSizeChange(n => updateQueueBadge(n));
  }

  get connected()   { return this.#dev?.opened ?? false; }
  get profile()     { return this.#profile; }
  get productName() { return this.#dev?.productName ?? ''; }

  /** Active register value: profile override wins, else global REG default. */
  reg(name) { return this.#profile?.reg?.[name] ?? REG[name]; }

  async connect(onDisconnect) {
    dbg('connect() — calling navigator.hid.requestDevice({ filters: [] })…');
    let list;
    try {
      list = await navigator.hid.requestDevice({ filters: [] });
    } catch (err) {
      dbg(`requestDevice() threw ${err.name}: ${err.message}`);
      throw err;
    }
    dbg(`requestDevice() returned ${list.length} device(s).`);
    if (!list.length) {
      dbg('Picker closed with no selection, or browser hid the device.');
      throw new Error('No device selected.');
    }

    list.forEach((d, i) => {
      dbg(`  device[${i}] "${d.productName || '(unnamed)'}" vid=${hex(d.vendorId)} pid=${hex(d.productId)} opened=${d.opened} collections=${d.collections?.length ?? 0}`);
      d.collections?.forEach((c, ci) => {
        const ids = r => (r || []).map(x => x.reportId).join(',') || '-';
        dbg(`      collection[${ci}] usagePage=${hex(c.usagePage)} usage=${hex(c.usage)} inReports=[${ids(c.inputReports)}] outReports=[${ids(c.outputReports)}] featReports=[${ids(c.featureReports)}]`);
      });
    });

    let dev = list[0];
    for (const d of list) {
      if (d.collections?.some(c => c.inputReports?.length && c.outputReports?.length)) {
        dev = d; break;
      }
    }
    dbg(`Selected: "${dev.productName || '(unnamed)'}" (vid=${hex(dev.vendorId)} pid=${hex(dev.productId)})`);

    if (!dev.opened) {
      dbg('Calling device.open()…');
      try {
        await dev.open();
        dbg('device.open() succeeded.');
      } catch (err) {
        dbg(`device.open() threw ${err.name}: ${err.message}`);
        if (err.name === 'NotAllowedError') {
          dbg('Hint (Linux): missing udev rule — check /dev/hidraw* permissions.');
        }
        throw err;
      }
    } else {
      dbg('Device already open.');
    }

    this.#dev     = dev;
    this.#profile = resolveProfile(dev.productName, dev.vendorId, dev.productId);
    dbg(`Profile: ${this.#profile?.name ?? '?'} (vid=${hex(dev.vendorId)} pid=${hex(dev.productId)} "${dev.productName || ''}") — reportId=${this.#profile.reportId} bands=${this.#profile.defaultBandCount} EQ_DAC=0x${this.reg('EQ_DAC').toString(16)}`);
    clearUndoStack();

    this.#onDisc = onDisconnect;
    navigator.hid.addEventListener('disconnect', this.#discHandler, { once: true });

    if (this.#profile.probeReportIds) await this.#probeReportIds();

    return dev.productName;
  }

  #discHandler = (e) => {
    if (e.device === this.#dev) {
      this.#dev = null;
      this.#queue.clear();
      this.#onDisc?.();
    }
  };

  async disconnect() {
    navigator.hid.removeEventListener('disconnect', this.#discHandler);
    this.#queue.clear();
    clearUndoStack();
    if (this.#dev?.opened) await this.#dev.close();
    this.#dev     = null;
    this.#profile = DEFAULT_PROFILE;
  }

  async #probeReportIds() {
    const cands = [...new Set(
      (this.#dev?.collections || []).flatMap(c => (c.outputReports || []).map(r => r.reportId))
    )];
    if (!cands.length) { dbg('Probe: no output report IDs found.'); return; }
    const probe = new Uint8Array([REG.FLAGS, 0, 0, 0, CMD_READ, 0, 0, 0, 0, 0]);
    dbg(`Probe: trying report IDs [${cands.join(', ')}] with readRegister(0x01)…`);
    for (const id of cands) {
      this.#profile = { ...this.#profile, reportId: id };
      dbg(`  Probe [reportId=${id}]: sending…`);
      try {
        const resp = await this.#rawSend(probe);
        if (resp.length >= 10 && resp[4] === CMD_READ) {
          dbg(`  Probe [reportId=${id}]: answered — using this ID.`);
          return;
        }
      } catch (err) {
        dbg(`  Probe [reportId=${id}]: ${err.message}`);
      }
    }
    dbg('Probe: no reportId responded.');
    this.#profile = { ...this.#profile, reportId: cands[0] };
  }

  send(data, key = null) {
    return this.#queue.add(() => this.#rawSend(data), key);
  }

  #rawSend(data) {
    if (!this.connected) throw new Error('Device not connected.');
    const rid = this.#profile.reportId;
    let done = false;

    return new Promise((res, rej) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#dev?.removeEventListener('inputreport', h);
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        dbg(`TIMEOUT: no response within 2000 ms (reportId=${rid}, ${data.length}B sent).`);
        res(new Uint8Array(0));
      }, 2000);

      const h = (e) => {
        if (done || e.reportId !== rid) return;  // ignore other report IDs
        done = true;
        cleanup();
        const resp = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
        dbg(`inputreport: reportId=${e.reportId} len=${e.data.byteLength} data=[${fmt(resp)}]`);
        res(resp);
      };

      this.#dev.addEventListener('inputreport', h);
      dbg(`sendReport(reportId=${rid}, ${data.length}B): [${fmt(data)}]`);
      this.#dev.sendReport(rid, data).catch(err => {
        if (done) return;
        done = true;
        cleanup();
        dbg(`sendReport rejected: ${err.name}: ${err.message}`);
        rej(new Error('sendReport failed: ' + err.message));
      });
    });
  }
}


/* ════════════════════════════════════════════════════════════
   § 5  DEVICE STATE
════════════════════════════════════════════════════════════ */
const DEFAULT_FREQS = [60, 230, 910, 3600, 14000]; // KT02H20 fallback

function profileFreqs() { return hid?.profile?.defaultFreqs ?? DEFAULT_FREQS; }
function profileDefaultQ() { return hid?.profile?.defaultQ ?? 1.0; }

function makeBand(freq, index, q = 1.0) {
  return { index, freq, gain: 0, q, filterType: 0 };
}

const state = {
  bands:      PROFILES.KT0231H.defaultFreqs.map((f, i) => makeBand(f, i, PROFILES.KT0231H.defaultQ)),
  bandCount:  PROFILES.KT0231H.defaultBandCount,
  eqEnabled:  true,
  globalGain: 0,
  pgaADC:     0,
  pgaDAC:     0,
  digADC:     0,
};

const undoStack = [];
const UNDO_LIMIT = 30;

function pushUndo(bandIndex) {
  const snap = { ...state.bands[bandIndex] };
  undoStack.push({ bandIndex, snap });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function clearUndoStack() { undoStack.length = 0; }

/* ── Register read/write (match Python ktmicro.py byte layout) ── */

async function readRegister(addr) {
  const cmd = new Uint8Array([
    addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF,
    CMD_READ, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  logTx(cmd);
  const resp = await hid.send(cmd, `reg-rd-${addr}`);
  logRx(resp);
  if (resp.length >= 10 && resp[4] === CMD_READ) {
    return (resp[6] | (resp[7] << 8) | (resp[8] << 16) | (resp[9] << 24)) >>> 0;
  }
  throw new Error(`Register read failed (0x${addr.toString(16).padStart(2, '0')})`);
}

async function writeRegister(addr, value) {
  const cmd = new Uint8Array([
    addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF,
    CMD_WRITE, 0x00,
    value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF,
  ]);
  logTx(cmd);
  const resp = await hid.send(cmd, `reg-wr-${addr}`);
  logRx(resp);
  const wantAck = hid.profile.writeAck ?? WRITE_ACK;
  if (resp.length >= 10 && resp[4] === CMD_WRITE && resp[6] === wantAck) return;
  throw new Error(`Register write failed (0x${addr.toString(16).padStart(2, '0')}, ACK=${resp.length >= 10 ? resp[6] : 'none'})`);
}

/* ── EQ band encode/decode ──
   A_reg = [freq_Hz:16][gain×10:16 signed]  B_reg = [type:3][rsv:13][Q×1000:16]  */

function encodeBand(freq, gain, q, filterType) {
  const g10  = (Math.round(clamp(gain, -3276.8, 3276.7) * 10) & 0xFFFF);
  const qVal = (Math.round(clamp(q, 0, 65.535) * 1000) & 0xFFFF);
  return {
    aReg: (((freq & 0xFFFF) << 16) | g10) >>> 0,
    bReg: (((filterType & 0x7) << 16) | qVal) >>> 0,
  };
}

function decodeBand(aReg, bReg) {
  const freq  = (aReg >>> 16) & 0xFFFF;
  let gRaw    = aReg & 0xFFFF;
  if (gRaw >= 0x8000) gRaw -= 0x10000;
  const gain       = gRaw / 10;
  const filterType = (bReg >>> 16) & 0x7;
  const q          = (bReg & 0xFFFF) / 1000;
  return { freq, gain, q, filterType };
}

/* ── Digital gain encode/decode (signed byte, 0.5 dB steps) ── */

function encodeDigGain(db) { return (Math.round(clamp(db, -64, 127.5) * 2) & 0xFF); }
function decodeDigGain(b)  { return (b >= 0x80 ? b - 0x100 : b) / 2; }

/* ── Fetch device state ── */

async function readString(addr, count) {
  let chars = [];
  for (let i = 0; i < count; i++) {
    const v = await readRegister(addr + i);
    const b = [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];
    for (const c of b) { if (c >= 32 && c < 127) chars.push(c); }
  }
  return String.fromCharCode(...chars).replace(/\0/g, '').trim();
}

async function fetchEqSwitch() {
  const enAddr = hid.reg('EQ_DAC_EN');
  const val = await readRegister(enAddr);
  state.eqEnabled = (val & 1) !== 0;
  log(`DAC EQ: ${state.eqEnabled ? 'ON' : 'OFF'} (0x${enAddr.toString(16)})`, 'inf');
}

async function fetchAllBands() {
  const base = hid.reg('EQ_DAC');
  const stride = hid.reg('EQ_STRIDE');
  for (let i = 0; i < state.bandCount; i++) {
    const aReg = await readRegister(base + i * stride);
    const bReg = await readRegister(base + i * stride + 1);
    const band = state.bands[i];
    if (band) {
      Object.assign(band, decodeBand(aReg, bReg));
      band.index = i;
    }
  }
}

async function fetchGlobalGain() {
  const val = await readRegister(hid.reg('DIG_DAC'));
  state.globalGain = decodeDigGain(val & 0xFF);
  log(`Digital DAC gain: ${state.globalGain.toFixed(1)} dB`, 'inf');
}

async function fetchPGAADC() {
  const val = await readRegister(hid.reg('PGA_ADC'));
  state.pgaADC = val & 0xFF;
  const label = PGA_ADC_GAINS[state.pgaADC] ?? `idx ${state.pgaADC}`;
  log(`A_ADC PGA: ${label} (idx ${state.pgaADC})`, 'inf');
}

async function fetchPGADAC() {
  const val = await readRegister(hid.reg('PGA_DAC'));
  state.pgaDAC = val & 0xFF;
  const label = PGA_DAC_GAINS[state.pgaDAC] ?? `idx ${state.pgaDAC}`;
  log(`A_DAC PGA: ${label} (idx ${state.pgaDAC})`, 'inf');
}

async function fetchDigADC() {
  const val = await readRegister(hid.reg('DIG_ADC'));
  state.digADC = decodeDigGain(val & 0xFF);
  log(`DIG_ADC: ${state.digADC.toFixed(1)} dB`, 'inf');
}

async function sendPGAADC(idx) {
  if (!hid.connected) return;
  await writeRegister(hid.reg('PGA_ADC'), idx & 0xFF);
  state.pgaADC = idx;
}

async function sendPGADAC(idx) {
  if (!hid.connected) return;
  await writeRegister(hid.reg('PGA_DAC'), idx & 0xFF);
  state.pgaDAC = idx;
}

async function sendDigADC(db) {
  if (!hid.connected) return;
  const digAddr = hid.reg('DIG_ADC');
  const raw = await readRegister(digAddr);
  await writeRegister(digAddr, (raw & 0xFFFFFF00) | encodeDigGain(db));
  state.digADC = db;
}


/* ════════════════════════════════════════════════════════════
   § 6  EQ CURVE VISUALIZER
════════════════════════════════════════════════════════════ */
class EQVisualizer {
  #canvas;
  #ctx;
  #ro;
  #dp;
  #W;
  #H;
  #fMin;
  #fMax;
  #dbMax;
  #bands;
  #onBandChange;
  #dragIndex;
  #isDragging;

  constructor(id) {
    this.#canvas = document.getElementById(id);
    if (!this.#canvas) return;
    this.#ctx = this.#canvas.getContext('2d');
    this.#dragIndex = -1;
    this.#isDragging = false;
    this.#ro = new ResizeObserver(() => this.draw(this.#bands || []));
    this.#ro.observe(this.#canvas.parentElement);
    this.#setupMouse();
    this.draw([]);
  }

  set onBandChange(fn) { this.#onBandChange = fn; }
  set bands(b) { this.#bands = b; }

  destroy() { this.#ro?.disconnect(); }

  #setupMouse() {
    const c = this.#canvas;
    c.style.cursor = 'default';

    c.addEventListener('mousedown', (e) => {
      if (!this.#bands?.length) return;
      const idx = this.#hitTest(e.offsetX, e.offsetY);
      if (idx >= 0) {
        this.#dragIndex = idx;
        this.#isDragging = true;
        c.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.#bands?.length || !this.#dp) return;
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (this.#isDragging && this.#dragIndex >= 0) {
        const ix = mx * this.#dp;
        const iy = my * this.#dp;
        const freq = this.#toFreq(ix);
        const db = this.#toDB(iy);
        const band = this.#bands[this.#dragIndex];
        const oldFreq = band.freq;
        const oldGain = band.gain;
        band.freq = clamp(Math.round(freq), 20, 20000);
        band.gain = clamp(Math.round(db * 2) / 2, hid.profile.gainRange.min, hid.profile.gainRange.max);
        this.draw(this.#bands);
        if (this.#onBandChange && (band.freq !== oldFreq || band.gain !== oldGain)) {
          this.#onBandChange(this.#dragIndex);
        }
      } else {
        const idx = this.#hitTest(mx, my);
        c.style.cursor = idx >= 0 ? 'grab' : 'default';
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.#isDragging) {
        this.#isDragging = false;
        this.#dragIndex = -1;
        this.#canvas.style.cursor = 'default';
        this.draw(this.#bands);
      }
    });
  }

  #toX(f) {
    return (Math.log10(f / this.#fMin) / Math.log10(this.#fMax / this.#fMin)) * this.#W;
  }

  #toY(db) {
    return this.#H / 2 - (clamp(db, -this.#dbMax, this.#dbMax) / this.#dbMax) * (this.#H / 2 - 14 * this.#dp);
  }

  #toFreq(ix) {
    return this.#fMin * Math.pow(this.#fMax / this.#fMin, ix / this.#W);
  }

  #toDB(iy) {
    return (this.#H / 2 - iy) / (this.#H / 2 - 14 * this.#dp) * this.#dbMax;
  }

  #hitTest(mx, my) {
    if (!this.#bands || !this.#dp) return -1;
    const ix = mx * this.#dp;
    const iy = my * this.#dp;
    const threshold = 10 * this.#dp;

    for (let i = this.#bands.length - 1; i >= 0; i--) {
      const b = this.#bands[i];
      const x = this.#toX(b.freq);
      const db = this.#bands.reduce((s, bb) => s + this.#bandAt(b.freq, bb), 0);
      const y = this.#toY(clamp(db, -this.#dbMax, this.#dbMax));
      const dx = ix - x;
      const dy = iy - y;
      if (dx * dx + dy * dy <= threshold * threshold) return i;
    }
    return -1;
  }

  #bandAt(f, { gain, freq: fc, q, filterType }) {
    if (!gain) return 0;
    const r  = f / fc;
    const lg = Math.log2(r);
    if (filterType === 0) {              // Peak
      const bw = 1 / q;
      return gain * Math.exp(-(lg * lg) / (2 * bw * bw));
    }
    if (filterType === 1) return gain / (1 + r ** 2);           // LPF
    if (filterType === 2) return gain / (1 + (1 / r) ** 2);     // HPF
    if (filterType === 3) return gain / (1 + r ** 4);           // Low Shelf
    if (filterType === 4) return gain / (1 + (1 / r) ** 4);     // High Shelf
    return 0;
  }

  draw(bands) {
    this.#bands = bands;
    const canvas = this.#canvas;
    if (!canvas) return;
    const ctx  = this.#ctx;
    const DPR  = this.#dp = window.devicePixelRatio || 1;
    const W    = this.#W = canvas.width  = canvas.offsetWidth  * DPR;
    const H    = this.#H = canvas.height = canvas.offsetHeight * DPR;
    const cs   = getComputedStyle(document.documentElement);

    ctx.clearRect(0, 0, W, H);

    const fMin = this.#fMin = 20, fMax = this.#fMax = 20000, dbMax = this.#dbMax = 14;
    const toX  = f  => (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * W;
    const toY  = db => H / 2 - (clamp(db, -dbMax, dbMax) / dbMax) * (H / 2 - 14 * DPR);

    const col = {
      border: cs.getPropertyValue('--border').trim()    || '#2e2e3a',
      xdim:   cs.getPropertyValue('--text-xdim').trim() || '#44445a',
      dim:    cs.getPropertyValue('--text-dim').trim()  || '#7878a0',
      accent: cs.getPropertyValue('--accent').trim()    || '#e8423a',
      green:  cs.getPropertyValue('--green').trim()     || '#3ddc84',
    };

    [-12, -6, 6, 12].forEach(db => {
      ctx.strokeStyle = col.border; ctx.lineWidth = 0.5 * DPR;
      ctx.setLineDash([4 * DPR, 4 * DPR]);
      ctx.beginPath(); ctx.moveTo(0, toY(db)); ctx.lineTo(W, toY(db)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col.xdim; ctx.font = `${9 * DPR}px sans-serif`;
      ctx.fillText(`${db > 0 ? '+' : ''}${db}dB`, 4 * DPR, toY(db) - 3 * DPR);
    });

    ctx.strokeStyle = col.border; ctx.lineWidth = 1 * DPR; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, toY(0)); ctx.lineTo(W, toY(0)); ctx.stroke();

    [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(f => {
      ctx.strokeStyle = col.border; ctx.lineWidth = 0.5 * DPR;
      ctx.beginPath(); ctx.moveTo(toX(f), 0); ctx.lineTo(toX(f), H); ctx.stroke();
      ctx.fillStyle = col.xdim; ctx.font = `${8 * DPR}px sans-serif`;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, toX(f) + 2 * DPR, H - 4 * DPR);
    });

    if (!bands.length) return;

    const N = 400;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const f  = fMin * Math.pow(fMax / fMin, i / N);
      const db = bands.reduce((s, b) => s + this.#bandAt(f, b), 0);
      pts.push({ x: toX(f), y: toY(db) });
    }

    ctx.beginPath();
    ctx.moveTo(pts[0].x, toY(0));
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, toY(0));
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   col.accent + '33');
    grad.addColorStop(0.5, col.accent + '08');
    grad.addColorStop(1,   col.accent + '00');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = col.accent;
    ctx.lineWidth   = 2 * DPR;
    ctx.shadowColor = col.accent;
    ctx.shadowBlur  = 6 * DPR;
    ctx.stroke();
    ctx.shadowBlur = 0;

    bands.forEach((band, idx) => {
      const x  = toX(band.freq);
      const db = bands.reduce((s, b) => s + this.#bandAt(band.freq, b), 0);
      const y  = toY(clamp(db, -dbMax, dbMax));

      ctx.strokeStyle = col.dim;
      ctx.lineWidth   = 0.5 * DPR;
      ctx.setLineDash([3 * DPR, 3 * DPR]);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, H - 16 * DPR); ctx.stroke();
      ctx.setLineDash([]);

      const isActive = this.#dragIndex === idx;
      const r = (4 + (isActive ? 2 : 0)) * DPR;
      const dotColor = band.gain > 0.05 ? col.accent : band.gain < -0.05 ? col.green : col.dim;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle   = dotColor;
      ctx.shadowColor = dotColor;
      ctx.shadowBlur  = 6 * DPR;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (Math.abs(band.gain) >= 0.5) {
        ctx.fillStyle = dotColor;
        ctx.font      = `bold ${8 * DPR}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)}`, x, y - 6 * DPR);
        ctx.textAlign = 'start';
      }

      const freqLabel = band.freq >= 1000 ? `${band.freq / 1000}k` : `${band.freq}`;
      ctx.fillStyle = col.green;
      ctx.font = `${7 * DPR}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(freqLabel, x, H - 8 * DPR);
      ctx.textAlign = 'start';
    });
  }
}


/* ════════════════════════════════════════════════════════════
   § 7  PRESET STORAGE (localStorage JSON)
════════════════════════════════════════════════════════════ */
const PRESET_KEY = 'kt-dac-presets-v3'; // v3: KT0231H 6-band presets (v2 keys stay untouched in other origins)

function isValidPresetEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!Array.isArray(entry.bands) || !entry.bands.length) return false;
  if (!entry.bands.every(b =>
    typeof b.freq === 'number' && typeof b.gain === 'number' &&
    typeof b.q === 'number'    && typeof b.filterType === 'number'
  )) return false;
  if (typeof entry.globalGain !== 'number') return false;
  return true;
}

const Presets = {
  load() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; }
  },
  save(p) { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); },
  add(name) {
    const p = this.load();
    p[name.trim()] = {
      bands:      state.bands.map(({ freq, gain, q, filterType }) => ({ freq, gain, q, filterType })),
      globalGain: state.globalGain,
      savedAt:    new Date().toISOString(),
    };
    this.save(p);
  },
  remove(name) { const p = this.load(); delete p[name]; this.save(p); },
  exportJSON() {
    const blob = new Blob([JSON.stringify(this.load(), null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: url, download: `kt0231h-presets-${Date.now()}.json`,
    }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async importJSON(file) {
    const text     = await file.text();
    const raw      = JSON.parse(text);
    if (typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid preset file — expected a JSON object of named presets.');
    const valid = {};
    const invalid = [];
    for (const [name, entry] of Object.entries(raw)) {
      if (isValidPresetEntry(entry)) valid[name] = entry;
      else invalid.push(name);
    }
    if (invalid.length)
      log(`Skipped ${invalid.length} invalid preset(s): ${invalid.join(', ')}`, 'warn');
    if (!Object.keys(valid).length)
      throw new Error('No valid presets found in file.');
    this.save({ ...this.load(), ...valid });
    return Object.keys(valid).length;
  },
};


/* ════════════════════════════════════════════════════════════
   § 8  UTILITIES
════════════════════════════════════════════════════════════ */
const $    = id => document.getElementById(id);
const esc  = s  => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt  = a  => Array.from(a).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const hex  = (n, w = 4) => '0x' + Number(n).toString(16).padStart(w, '0').toUpperCase();
const logTx = d => log('TX → ' + fmt(d), 'tx');
const logRx = d => { if (d?.length) log('RX ← ' + fmt(d), 'rx'); };

const DEBUG = true;

function dbg(msg) {
  if (!DEBUG) return;
  console.log('[DBG]', msg);
  log('[DBG] ' + msg, 'dbg');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function setStatus(msg, type = 'idle') {
  $('status-bar').className    = `status-bar status-${type}`;
  $('status-text').textContent = msg;
}

function log(msg, kind = 'inf') {
  const box = $('log');
  const el  = document.createElement('div');
  const ts  = new Date().toLocaleTimeString('en-GB', { hour12: false });
  el.className = `log-entry ${kind}`;
  el.innerHTML = `<span class="log-ts">[${ts}]</span>${esc(String(msg))}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 200) box.removeChild(box.firstChild);
}

function toast(msg, type = 'info', durationMs = 3000) {
  const el   = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, durationMs);
}

function updateQueueBadge(n) {
  const badge = $('queue-badge');
  if (!badge) return;
  badge.textContent = n > 0 ? `${n} pending` : '';
  badge.style.display = n > 0 ? 'inline' : 'none';
}


/* ════════════════════════════════════════════════════════════
   § 9  BAND UI
════════════════════════════════════════════════════════════ */
let visualizer = null;
let disconnectHandled = false;
const hid = new HIDController();

function gainToColor(gain, alpha = 0.18) {
  if (gain > 0.2) return `rgba(232,66,58,${Math.min(gain / 12, 1) * alpha})`;
  if (gain < -0.2) return `rgba(61,220,132,${Math.min(-gain / 12, 1) * alpha})`;
  return 'transparent';
}

function buildBandUI() {
  const profile   = hid.profile;
  const container = $('eq-bands');
  container.innerHTML = '';

  state.bands.forEach((band, i) => {
    const fLabel = band.freq >= 1000 ? `${band.freq / 1000}k` : `${band.freq}`;
    const ftOpts = profile.filterTypes.map(f =>
      `<option value="${f.value}" ${f.value === band.filterType ? 'selected' : ''}>${f.label}</option>`
    ).join('');

    const div = document.createElement('div');
    div.className = 'eq-band'; div.id = `band-${i}`;
    div.innerHTML = `
      <div class="band-freq" id="bfq-${i}">${fLabel} Hz</div>
      <div class="band-slider-wrap">
        <div class="zero-line"></div>
        <input type="range" class="vslider" id="bs-${i}"
               min="${profile.gainRange.min}" max="${profile.gainRange.max}"
               step="0.5" value="${band.gain}" />
      </div>
      <div class="band-gain-val" id="bgv-${i}">${band.gain.toFixed(1)} dB</div>
      <div class="band-controls">
        <label>Q</label>
        <input type="number" id="bq-${i}" value="${band.q.toFixed(2)}"
               min="${profile.qRange.min}" max="${profile.qRange.max}" step="0.05" />
        <label>Freq (Hz)</label>
        <input type="number" id="bf-${i}" value="${band.freq}" min="20" max="20000" />
        <label>Filter</label>
        <select id="bft-${i}">${ftOpts}</select>
      </div>
      <button class="band-send-btn" id="bsend-${i}" title="Send this band (or Ctrl+Click to undo)">↑ Send</button>
    `;
    container.appendChild(div);

    const slider  = $(`bs-${i}`);
    const gainVal = $(`bgv-${i}`);

    const dSend = debounce(() => sendBand(i), 150);

    slider.addEventListener('input', () => {
      band.gain = parseFloat(slider.value);
      gainVal.textContent = band.gain.toFixed(1) + ' dB';
      div.style.background = gainToColor(band.gain);
      markDirty(i);
      visualizer?.draw(state.bands);
      if (hid.connected) dSend();
    });

    $(`bq-${i}`).addEventListener('change', () => {
      band.q = clamp(parseFloat($(`bq-${i}`).value) || 1, profile.qRange.min, profile.qRange.max);
      $(`bq-${i}`).value = band.q.toFixed(2);
      markDirty(i);
    });

    $(`bf-${i}`).addEventListener('change', () => {
      band.freq = clamp(parseInt($(`bf-${i}`).value) || profileFreqs()[i] || 1000, 20, 20000);
      $(`bf-${i}`).value = band.freq;
      const label = $(`bfq-${i}`);
      if (label) label.textContent = (band.freq >= 1000 ? `${band.freq / 1000}k` : `${band.freq}`) + ' Hz';
      markDirty(i);
      visualizer?.draw(state.bands);
    });

    $(`bft-${i}`).addEventListener('change', () => {
      band.filterType = parseInt($(`bft-${i}`).value);
      markDirty(i);
      visualizer?.draw(state.bands);
    });

    $(`bsend-${i}`).addEventListener('click', () => sendBand(i));
  });
}

function refreshBandUI(i) {
  const b = state.bands[i];
  const s = $(`bs-${i}`);   if (s) s.value = b.gain;
  const g = $(`bgv-${i}`);  if (g) g.textContent = b.gain.toFixed(1) + ' dB';
  const q = $(`bq-${i}`);   if (q) q.value = b.q.toFixed(2);
  const f = $(`bf-${i}`);   if (f) f.value = b.freq;
  const t = $(`bft-${i}`);  if (t) t.value = b.filterType;
  const l = $(`bfq-${i}`);
  if (l) l.textContent = (b.freq >= 1000 ? `${b.freq / 1000}k` : `${b.freq}`) + ' Hz';
  const d = $(`band-${i}`);
  if (d) d.style.background = gainToColor(b.gain);
  markClean(i);
}

function markDirty(i)  { $(`band-${i}`)?.classList.add('changed'); }
function markClean(i) { $(`band-${i}`)?.classList.remove('changed'); }

function setControlsEnabled(on) {
  ['btn-eq-on', 'btn-eq-off', 'global-gain', 'btn-read-all', 'btn-write-all',
   'btn-reset-eq', 'btn-save-preset', 'btn-export', 'btn-import']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  document.querySelectorAll('.band-send-btn, .vslider, .band-controls input, .band-controls select,'
    + ' .volume-select, #dig-adc')
    .forEach(el => { el.disabled = !on; });
}

function refreshVolumeUI() {
  const pa = $('pga-adc');  if (pa) pa.value = state.pgaADC;
  const pd = $('pga-dac');  if (pd) pd.value = state.pgaDAC;
  const da = $('dig-adc');  if (da) da.value = state.digADC;
  const dv = $('dig-adc-val');
  if (dv) dv.textContent = (state.digADC >= 0 ? '+' : '') + state.digADC.toFixed(1) + ' dB';
}

function updateEqToggleUI() {
  $('btn-eq-on').classList.toggle('active',  state.eqEnabled);
  $('btn-eq-off').classList.toggle('active', !state.eqEnabled);
}

function renderLocalPresets() {
  const list = $('preset-list');
  const all  = Presets.load();
  list.innerHTML = '';
  const names = Object.keys(all);
  if (!names.length) {
    list.innerHTML = '<span style="color:var(--text-xdim);font-size:12px">No presets saved yet.</span>';
    return;
  }
  names.forEach(name => {
    const chip = document.createElement('div');
    chip.className = 'preset-chip';
    const d  = all[name].savedAt ? new Date(all[name].savedAt).toLocaleDateString() : '';
    chip.innerHTML = `
      <div class="chip-info">
        <span class="preset-chip-name">${esc(name)}</span>
        ${d ? `<span class="chip-date">${d}</span>` : ''}
      </div>
      <button class="preset-chip-del" title="Delete preset">✕</button>
    `;
    chip.querySelector('.chip-info').addEventListener('click', () => applyLocalPreset(name, all[name]));
    chip.querySelector('.preset-chip-del').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete preset "${name}"?`)) { Presets.remove(name); renderLocalPresets(); }
    });
    list.appendChild(chip);
  });
}


/* ════════════════════════════════════════════════════════════
   § 10  OPERATIONS
════════════════════════════════════════════════════════════ */
async function sendBand(i) {
  if (!hid.connected) return;
  const b = state.bands[i];
  pushUndo(i);
  const { aReg, bReg } = encodeBand(b.freq, b.gain, b.q, b.filterType);
  const addrA = hid.reg('EQ_DAC') + i * hid.reg('EQ_STRIDE');
  const addrB = addrA + 1;
  try {
    await writeRegister(addrA, aReg);
    await writeRegister(addrB, bReg);
    markClean(i);
  } catch (err) {
    if (err.message !== 'Queue cleared') {
      log('Band send error: ' + err.message, 'err');
      setStatus('Send error — see log.', 'error');
    }
  }
}

async function onConnect() {
  if (!navigator.hid) {
    setStatus('⚠ WebHID not available — use Chrome/Edge desktop.', 'error');
    return;
  }
  try {
    setStatus('Requesting device…', 'working');
    dbg('── onConnect: requesting device ──');
    const name = await hid.connect(onHWDisconnect);
    disconnectHandled = false;

    $('device-name').textContent = `${hid.profile?.name ?? ''} — ${name || 'Connected'}`;
    $('btn-connect').disabled    = true;
    $('btn-disconnect').disabled = false;
    setControlsEnabled(true);
    setStatus(`Connected: ${name} [${hid.profile?.name ?? 'DEFAULT'}]`, 'ok');
    log(`Connected to: ${name} (profile ${hid.profile?.name ?? 'DEFAULT'})`);
    log(`reportId=${hid.profile.reportId} EQ_DAC=0x${hid.reg('EQ_DAC').toString(16)} x${state.bandCount}`);

    setStatus('Reading device state…', 'working');
    dbg('── onConnect: reading device state ──');

    // Rebuild bands from the active profile (KT0231H = 6, KT02H20 = 5)
    state.bandCount = hid.profile.defaultBandCount ?? hid.reg('EQ_BANDS');
    const freqs = profileFreqs();
    const dq = profileDefaultQ();
    state.bands = Array.from({ length: state.bandCount },
      (_, i) => makeBand(freqs[i] ?? 1000, i, dq));

    try {
      const ver = await readString(hid.profile.versionAddr ?? REG.VERSION,
                                   hid.profile.versionCount ?? 2);
      dbg(`Chip version: "${ver}"`);
      log(`Chip version: ${ver}`, 'inf');
    } catch (err) {
      dbg(`Version read failed: ${err.message}`);
      throw new Error('Device did not respond to register read.');
    }

    // EQ bands are mandatory; volume/PGA regs are best-effort because the
    // KT0231H PGA/DIG addresses are unverified (carried over from KT02H20).
    await fetchEqSwitch();
    await fetchAllBands();
    for (const [label, fn] of [
      ['DIG_DAC', fetchGlobalGain], ['PGA_ADC', fetchPGAADC],
      ['PGA_DAC', fetchPGADAC], ['DIG_ADC', fetchDigADC],
    ]) {
      try { await fn(); }
      catch (err) { log(`${label} read failed (unverified reg on this chip?): ${err.message}`, 'warn'); }
    }
    dbg('── onConnect: state read finished ──');

    buildBandUI();
    state.bands.forEach((_, i) => refreshBandUI(i));
    visualizer.bands = state.bands;

    $('global-gain').value = state.globalGain;
    $('global-gain-val').textContent = state.globalGain.toFixed(1) + ' dB';

    refreshVolumeUI();

    updateEqToggleUI();
    visualizer?.draw(state.bands);

    setStatus('Device ready.', 'ok');
    log(`All state loaded — ${state.bandCount} bands.`);
  } catch (err) {
    setStatus('Connection failed: ' + err.message, 'error');
    log('Connection failed: ' + err.message, 'err');
    dbg(`onConnect failed with ${err?.name ?? 'Error'}: ${err?.message}`);
    try { await hid.disconnect(); } catch {}
    $('btn-connect').disabled    = false;
    $('btn-disconnect').disabled = true;
    setControlsEnabled(false);
  }
}

function onHWDisconnect() {
  if (disconnectHandled) return;
  disconnectHandled = true;
  $('device-name').textContent  = 'No device';
  $('btn-connect').disabled     = false;
  $('btn-disconnect').disabled  = true;
  setControlsEnabled(false);
  updateEqToggleUI();
  setStatus('Device disconnected (USB unplugged).', 'error');
  log('Device disconnected.', 'err');
}

async function onDisconnect() {
  await hid.disconnect();
  onHWDisconnect();
  setStatus('Disconnected.', 'idle');
  log('Disconnected by user.');
}

async function readAll() {
  setStatus('Reading all bands…', 'working');
  try {
    await fetchEqSwitch();
    await fetchAllBands();
    for (const fn of [fetchGlobalGain, fetchPGAADC, fetchPGADAC, fetchDigADC]) {
      try { await fn(); }
      catch (err) { log(`Volume read failed (unverified reg?): ${err.message}`, 'warn'); }
    }
    state.bands.forEach((_, i) => refreshBandUI(i));
    $('global-gain').value = state.globalGain;
    $('global-gain-val').textContent = state.globalGain.toFixed(1) + ' dB';
    refreshVolumeUI();
    updateEqToggleUI();
    visualizer?.draw(state.bands);
    setStatus('Read complete.', 'ok');
    log('Read complete.');
  } catch (err) {
    setStatus('Read error: ' + err.message, 'error');
    log('Read error: ' + err.message, 'err');
  }
}

async function writeAll() {
  setStatus('Writing all bands…', 'working');
  try {
    for (let i = 0; i < state.bandCount; i++) {
      const b = state.bands[i];
      const { aReg, bReg } = encodeBand(b.freq, b.gain, b.q, b.filterType);
      await writeRegister(hid.reg('EQ_DAC') + i * hid.reg('EQ_STRIDE'),     aReg);
      await writeRegister(hid.reg('EQ_DAC') + i * hid.reg('EQ_STRIDE') + 1, bReg);
      markClean(i);
    }
    setStatus('Write complete.', 'ok');
    log('Write complete.');
  } catch (err) {
    setStatus('Write error: ' + err.message, 'error');
    log('Write error: ' + err.message, 'err');
  }
}

function applyLocalPreset(name, preset) {
  preset.bands?.forEach((b, i) => {
    if (!state.bands[i]) return;
    Object.assign(state.bands[i], b);
    refreshBandUI(i); markDirty(i);
  });
  if (preset.globalGain != null) {
    state.globalGain = preset.globalGain;
    $('global-gain').value = state.globalGain;
    $('global-gain-val').textContent = state.globalGain.toFixed(1) + ' dB';
  }
  visualizer?.draw(state.bands);
  toast(`Preset "${name}" loaded — click Write All Bands.`, 'info');
  log(`Preset "${name}" applied.`);
  setStatus(`Preset "${name}" loaded — click Write All Bands.`, 'working');
}

function resetEQ() {
  const freqs = profileFreqs();
  const dq = profileDefaultQ();
  state.bands.forEach((b, i) => {
    b.gain = 0; b.q = dq;
    b.freq = freqs[i] ?? 1000; b.filterType = 0;
    refreshBandUI(i); markDirty(i);
  });
  visualizer?.draw(state.bands);
  log('EQ reset locally.');
  setStatus('EQ reset — click Write All Bands to apply.', 'working');
}

async function undoLastBand() {
  if (!undoStack.length) { toast('Nothing to undo.', 'warn'); return; }
  const { bandIndex, snap } = undoStack.pop();
  Object.assign(state.bands[bandIndex], snap);
  refreshBandUI(bandIndex);
  markDirty(bandIndex);
  visualizer?.draw(state.bands);
  toast(`Undo band ${bandIndex} → ${snap.gain.toFixed(1)} dB`, 'info');
  if (hid.connected) await sendBand(bandIndex);
}


/* ════════════════════════════════════════════════════════════
   § 11  KEYBOARD SHORTCUTS
   R → read  |  W → write  |  Ctrl+S → save  |  Ctrl+Z → undo  |  Esc → clear log
════════════════════════════════════════════════════════════ */
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', async (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          const name = $('preset-name').value.trim();
          if (!name) {
            toast('Type a preset name first (bottom section).', 'warn');
          } else {
            Presets.add(name); $('preset-name').value = '';
            renderLocalPresets(); toast(`Preset "${name}" saved.`, 'ok');
            log(`Preset "${name}" saved via Ctrl+S.`);
          }
          break;
        case 'z':
          e.preventDefault();
          await undoLastBand();
          break;
      }
    } else {
      switch (e.key.toLowerCase()) {
        case 'r':
          if (hid.connected) readAll();
          break;
        case 'w':
          if (hid.connected) writeAll();
          break;
        case 'escape':
          $('log').innerHTML = '';
          break;
      }
    }
  });
}


/* ════════════════════════════════════════════════════════════
   § 12  INIT & EVENT WIRING
════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  $('btn-connect').addEventListener('click', onConnect);
  $('btn-disconnect').addEventListener('click', onDisconnect);

  $('btn-eq-on').addEventListener('click', async () => {
    if (!hid.connected) return;
    try {
      const enAddr = hid.reg('EQ_DAC_EN');
      const val = await readRegister(enAddr);
      await writeRegister(enAddr, val | 1);
      state.eqEnabled = true; updateEqToggleUI(); setStatus('DAC EQ ON.', 'ok');
    } catch (err) { log('EQ ON error: ' + err.message, 'err'); }
  });
  $('btn-eq-off').addEventListener('click', async () => {
    if (!hid.connected) return;
    try {
      const enAddr = hid.reg('EQ_DAC_EN');
      const val = await readRegister(enAddr);
      await writeRegister(enAddr, val & ~1);
      state.eqEnabled = false; updateEqToggleUI(); setStatus('DAC EQ OFF.', 'ok');
    } catch (err) { log('EQ OFF error: ' + err.message, 'err'); }
  });

  $('global-gain').addEventListener('input', () => {
    $('global-gain-val').textContent = parseFloat($('global-gain').value).toFixed(1) + ' dB';
  });
  $('global-gain').addEventListener('change', async () => {
    if (!hid.connected) return;
    const val = parseFloat($('global-gain').value);
    try {
      const digAddr = hid.reg('DIG_DAC');
      const raw = await readRegister(digAddr);
      await writeRegister(digAddr, (raw & 0xFFFFFF00) | encodeDigGain(val));
      state.globalGain = val;
      setStatus(`DAC gain: ${val.toFixed(1)} dB.`, 'ok');
    } catch (err) { log('Gain error: ' + err.message, 'err'); }
  });

  // ── Volume controls ──
  (() => {
    const pa = $('pga-adc');
    if (pa) {
      pa.innerHTML = PGA_ADC_GAINS.map((l, i) => `<option value="${i}">${l}</option>`).join('');
      pa.value = state.pgaADC;
      pa.addEventListener('change', async () => {
        if (!hid.connected) return;
        const idx = parseInt(pa.value);
        try {
          await sendPGAADC(idx);
          setStatus(`A_ADC: ${PGA_ADC_GAINS[idx]}.`, 'ok');
        } catch (err) { log('A_ADC error: ' + err.message, 'err'); }
      });
    }

    const pd = $('pga-dac');
    if (pd) {
      pd.innerHTML = PGA_DAC_GAINS.map((l, i) => `<option value="${i}">${l}</option>`).join('');
      pd.value = state.pgaDAC;
      pd.addEventListener('change', async () => {
        if (!hid.connected) return;
        const idx = parseInt(pd.value);
        try {
          await sendPGADAC(idx);
          setStatus(`A_DAC: ${PGA_DAC_GAINS[idx]}.`, 'ok');
        } catch (err) { log('A_DAC error: ' + err.message, 'err'); }
      });
    }

    $('dig-adc')?.addEventListener('input', () => {
      $('dig-adc-val').textContent = (parseFloat($('dig-adc').value) >= 0 ? '+' : '') + parseFloat($('dig-adc').value).toFixed(1) + ' dB';
    });
    $('dig-adc')?.addEventListener('change', async () => {
      if (!hid.connected) return;
      const db = parseFloat($('dig-adc').value);
      try {
        await sendDigADC(db);
        setStatus(`DIG_ADC: ${db.toFixed(1)} dB.`, 'ok');
      } catch (err) { log('DIG_ADC error: ' + err.message, 'err'); }
    });
  })();

  $('btn-read-all').addEventListener('click', readAll);
  $('btn-write-all').addEventListener('click', writeAll);
  $('btn-reset-eq').addEventListener('click', resetEQ);

  $('btn-save-preset').addEventListener('click', () => {
    const name = $('preset-name').value.trim();
    if (!name) { toast('Enter a preset name first.', 'warn'); return; }
    Presets.add(name); $('preset-name').value = '';
    renderLocalPresets(); log(`Preset "${name}" saved.`);
    toast(`Preset "${name}" saved.`, 'ok');
  });

  $('btn-export').addEventListener('click', () => {
    Presets.exportJSON(); log('Presets exported.');
    toast('Presets exported as JSON.', 'ok');
  });
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const n = await Presets.importJSON(file);
      renderLocalPresets();
      log(`Imported ${n} preset(s) from ${file.name}.`);
      toast(`${n} preset(s) imported.`, 'ok');
      setStatus(`${n} preset(s) imported.`, 'ok');
    } catch (err) {
      log('Import failed: ' + err.message, 'err');
      toast('Import failed: ' + err.message, 'error');
      setStatus('Import failed.', 'error');
    }
    e.target.value = '';
  });

  $('btn-clear-log').addEventListener('click', () => { $('log').innerHTML = ''; });

  // ── INIT ──
  buildBandUI();
  setControlsEnabled(false);
  renderLocalPresets();
  visualizer = new EQVisualizer('eq-canvas');
  visualizer.bands = state.bands;
  (() => {
    const dSend = {};
    visualizer.onBandChange = (i) => {
      refreshBandUI(i);
      markDirty(i);
      if (hid.connected) {
        if (!dSend[i]) dSend[i] = debounce(() => sendBand(i), 150);
        dSend[i]();
      }
    };
  })();
  setupKeyboardShortcuts();

  if (!navigator.hid) {
    setStatus('⚠ WebHID not supported — use Chrome or Edge (desktop).', 'error');
    $('btn-connect').disabled = true;
    log('WebHID not available.', 'err');
  } else {
    setStatus('Ready — click Connect USB to begin.', 'idle');
    log('WebHID ready. Shortcuts: R=read  W=write  Ctrl+S=save  Ctrl+Z=undo');
  }

  // ── DEBUG: environment dump ──
  dbg(`secureContext=${window.isSecureContext} protocol=${location.protocol} origin=${location.origin}`);
  dbg(`navigator.hid=${!!navigator.hid} userAgent=${navigator.userAgent}`);
  if (navigator.hid) {
    navigator.hid.getDevices().then(devs => {
      dbg(`getDevices(): ${devs.length} previously-granted device(s)`);
      devs.forEach((d, i) => dbg(`  granted[${i}] "${d.productName || '(unnamed)'}" vid=${hex(d.vendorId)} pid=${hex(d.productId)} opened=${d.opened}`));
    }).catch(err => dbg(`getDevices() threw ${err.name}: ${err.message}`));
  }
});