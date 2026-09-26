/* ══════════════════════════════════════════════════════════════════════════
   CDC BOOTLOADER TRANSPORT  (js/cdc.js)

   A second, independent way to reach the same vendor bootloader. The
   WebHID path in tools.js talks to it over HID feature reports; this one
   talks to the *serial* face of the same ROM, which the unit enumerates as
   8888:CDC0 once it is in boot mode. The two transports are not
   interchangeable at the byte level — different framing, different CRC, a
   real state machine — so this is a separate implementation rather than a
   second backend on the WebHID one.

   Why bother, when WebHID already works:
     · some units expose only the CDC face in boot mode,
     · WebHID is blocked outright by some enterprise policies and by
       Firefox/Safari entirely, while Web Serial has the same desktop-Chrome
       requirement but a different permission surface,
     · the serial path is what the vendor's own tooling and the upstream
       hardware-verified flasher use, so it is the better-documented one.

   The framing below is transcribed from the reversed protocol (see
   06_Reverse_Engineering_Docs/kt02h20_flasher_toolkit_docs/CDC-PROTOCOL.md),
   which was confirmed on real hardware: a full native reflash of the stock
   JA11 image completed over this exact sequence.

   Everything above the wire is a pure function and is unit-tested in
   functional.cjs — the CRC variant, the header bit-packing, the block-0
   special case and the final packet are all checkable without hardware.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── CRC-32, KTMicro variant ─────────────────────────────────────────────
   The table is the ordinary reflected CRC-32 table (poly 0xEDB88320 — the
   canonical table has table[1] === 0x77073096, which the RE matched
   byte-exactly). What is NOT ordinary is the seed and the final XOR:

       seed    = 0x00000000   (not 0xFFFFFFFF)
       xorout  = 0x00000000   (not 0xFFFFFFFF)
       reflected input and output, little-endian on the wire
       computed over header(6) + payload — the header is prepended BEFORE
       the CRC loop, not after it

   Using a stock crc32() here silently corrupts every packet, and the unit
   will simply stop acknowledging, so this is spelled out rather than
   delegated. The reference "CRC-32 (of the whole image)" reported by the
   INF token uses the same convention, which is the cross-check. */
const CDC_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function cdcCrc32(bytes) {
  let c = 0;                                   // seed 0, no final XOR
  for (let i = 0; i < bytes.length; i++) {
    c = CDC_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return c >>> 0;
}

/* ── Data-packet header (6 bytes) ────────────────────────────────────────
     H[0]  0x69                      constant marker
     H[1]  L & 0xFF                  payload length, low 8 bits
     H[2]  ((L >> 8) & 0x1F) | top3 << 5
     H[3]  addr & 0xFF               24-bit little-endian flash address
     H[4]  (addr >> 8) & 0xFF
     H[5]  (addr >> 16) & 0xFF

   L is a 13-bit field and top3 occupies bits 5..7 of H[2] — which is why the
   length is capped at 0x1FFF and why H[2] masks to 0x1F rather than 0xFF. */
function cdcHeader(len, addr, top3) {
  if (!Number.isInteger(len) || len < 0 || len > 0x1FFF) {
    throw new RangeError(`payload length ${len} does not fit the 13-bit field`);
  }
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xFFFFFF) {
    throw new RangeError(`address ${hex(addr)} does not fit 24 bits`);
  }
  const h = new Uint8Array(6);
  h[0] = 0x69;
  h[1] = len & 0xFF;
  h[2] = ((len >>> 8) & 0x1F) | ((top3 & 0x07) << 5);
  h[3] = addr & 0xFF;
  h[4] = (addr >>> 8) & 0xFF;
  h[5] = (addr >>> 16) & 0xFF;
  return h;
}

/* header + payload + CRC-32 (4 bytes little-endian) */
function cdcPacket(payload, addr, top3) {
  const head = cdcHeader(payload.length, addr, top3);
  const body = new Uint8Array(6 + payload.length);
  body.set(head, 0);
  body.set(payload, 6);
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  new DataView(out.buffer).setUint32(body.length, cdcCrc32(body), true);
  return out;
}

/* ── Image → packet plan ────────────────────────────────────────────────
   One 0x400-byte block per packet, with two documented irregularities:

   1. Block 0 starts at base+0x10, not base+0x00, and carries
      image[0x10 .. 0x400] — 1008 bytes, not 1024. The bootloader wants the
      16-byte image head (the flash tag + chip id) held back.
   2. top3 is the bank id on a region-boundary packet (block % 0x20 === 0,
      value 1 on the JA11 image) and 0b111 everywhere else.

   Then one final packet writes those 16 held-back bytes, so the image only
   becomes bootable once the whole thing has landed. The RE describes that
   final packet as a fixed "69 10 E0 <addr>", but it is not a special case:
   0x10 is L & 0xFF with L = 16, and 0xE0 is 0b111 << 5 with the high length
   bits clear. It falls out of the same encoder as every other block, so it
   gets no branch of its own — one code path, one thing to get wrong. */
function* cdcImagePackets(buf, opts = {}) {
  const { base = 0, bankId = 1, blockSize = 0x400, bankBlocks = 0x20, headSize = 0x10 } = opts;
  const n = Math.ceil(buf.length / blockSize);
  for (let b = 0; b < n; b++) {
    const off = b * blockSize;
    const start = b === 0 ? headSize : off;
    const payload = buf.subarray(start, Math.min(off + blockSize, buf.length));
    yield {
      block: b,
      addr: base + start,
      top3: (b % bankBlocks === 0) ? bankId : 0x07,
      payload,
      final: false,
    };
  }
  yield { block: n, addr: base, top3: 0x07, payload: buf.subarray(0, headSize), final: true };
}

/* ── Fixed command tokens ───────────────────────────────────────────────
   A lead byte plus three ASCII chars, except the 10-byte erase/setup block
   which is binary. The erase block is byte-identical to the WebHID CFG
   packet, so the two transports configure the flash identically. */
const CDC_TOKENS = {
  KTM:   [0x1E, 0x4B, 0x54, 0x4D],                                        // handshake
  VER:   [0xF0, 0x56, 0x45, 0x52],                                        // version
  CHP:   [0xD2, 0x43, 0x48, 0x50],                                        // chip id
  KEY:   [0xF0, 0x4B, 0x45, 0x59],                                        // key / auth
  ERASE: [0x2D, 0x29, 0x00, 0x10, 0x0E, 0x15, 0x00, 0x60, 0x00, 0xBC],    // region / erase
  PWO:   [0x3C, 0x50, 0x57, 0x4F],                                        // power / prepare
  KSTA:  [0x4B, 0x53, 0x54, 0x41],                                        // start programming
  STP:   [0x96, 0x53, 0x54, 0x50],                                        // stop
  INF:   [0xF0, 0x49, 0x4E, 0x46],                                        // image fingerprint
  RESET: [0x5A, 0x52, 0x53, 0x54],                                        // boot the new image
};
const CDC_ACK_OK    = 0x78;   // 'x' — command accepted / ready
const CDC_ACK_BLOCK = 0xA5;   // data block accepted
const CDC_VID = 0x8888, CDC_PID = 0xCDC0;
const CDC_BAUDS = [115200, 256000, 576000, 921600];

/* ── The link ────────────────────────────────────────────────────────────
   ACK handling is the part that bites. The device batches its replies: a
   data packet commonly answers "78 a5" in one read, and the vendor driver
   scans the whole buffer for the byte it wants rather than reading a fixed
   length. A single fixed-length read therefore races the batch and
   mis-reads the ACK — so this keeps a permanent reader task feeding a flat
   buffer, and waits for the byte to appear in it. */
class CdcLink {
  constructor() {
    this.port = null;
    this.connected = false;
    this.info = null;
    this.baud = 921600;
    this._reader = null;
    this._writer = null;
    this._rx = new Uint8Array(0);
    this._reading = false;
    this._abort = false;
  }

  static get available() {
    return typeof navigator !== 'undefined' && !!navigator.serial;
  }

  async connect(baud = 921600) {
    if (!CdcLink.available) {
      throw new Error('Web Serial is unavailable — use Chrome or Edge on desktop.');
    }
    const granted = await navigator.serial.getPorts();
    const match = granted.find(p => p.usbVendorId === CDC_VID && p.usbProductId === CDC_PID)
      || granted.find(p => p.usbVendorId === CDC_VID);
    const port = match || await navigator.serial.requestPort({
      filters: [{ usbVendorId: CDC_VID, usbProductId: CDC_PID }],
    });
    await port.open({
      baudRate: baud, dataBits: 8, stopBits: 1,
      parity: 'none', flowControl: 'none', bufferSize: 4096,
    });
    this.port = port;
    this.baud = baud;
    this._reader = port.readable.getReader();
    this._writer = port.writable.getWriter();
    this.connected = true;
    this._drain();
    this._readLoop();
    log(`CDC port open at ${baud} baud (${hex(CDC_VID, 4)}:${hex(CDC_PID, 4)}).`, 'ok');
    return `${CDC_VID.toString(16)}:${CDC_PID.toString(16)} @ ${baud}`;
  }

  async disconnect() {
    this.connected = false;
    this._reading = false;
    this.info = null;
    const w = this._writer, r = this._reader, p = this.port;
    this._writer = this._reader = this.port = null;
    try { await w?.releaseLock(); } catch { /* already gone */ }
    try { await r?.cancel(); } catch { /* already gone */ }
    try { await r?.releaseLock(); } catch { /* already gone */ }
    try { await p?.close(); } catch { /* already gone */ }
  }

  _drain() { this._rx = new Uint8Array(0); }

  _push(chunk) {
    const merged = new Uint8Array(this._rx.length + chunk.length);
    merged.set(this._rx, 0);
    merged.set(chunk, this._rx.length);
    this._rx = merged;
  }

  /* One permanent read task. Anything else risks abandoning an in-flight
     read whose bytes would then be lost. */
  _readLoop() {
    this._reading = true;
    (async () => {
      while (this._reading) {
        try {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (value && value.length) this._push(value);
        } catch (e) {
          if (this._reading) log('CDC read stopped: ' + e.message, 'warn');
          break;
        }
      }
    })();
  }

  async _tx(bytes) {
    if (!this.connected) throw new Error('CDC link not open.');
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    log(`CDC TX ${fmt(b.subarray(0, 6))}${b.length > 6 ? ` … +${b.length - 6}` : ''}  (${b.length} B)`, 'tx');
    await this._writer.write(b);
  }

  /* The vendor checks the reply with QByteArray::indexOf(byte) — the byte may
     appear anywhere in the batch, so search rather than read a fixed length. */
  async _await(byte, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this._rx.indexOf(byte);
      if (at >= 0) { this._rx = this._rx.subarray(at + 1); return true; }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise(r => setTimeout(r, Math.min(20, left)));
    }
  }

  /* Let whatever is in flight land, then hand back the buffer. */
  async _settle(ms = 60) {
    await new Promise(r => setTimeout(r, ms));
    const out = this._rx;
    this._rx = new Uint8Array(0);
    return out;
  }

  /* Hard tokens: drain, send, require the ACK. */
  async _cmd(name, { expect = CDC_ACK_OK, timeout = 3000 } = {}) {
    this._drain();
    await this._tx(CDC_TOKENS[name]);
    if (!await this._await(expect, timeout)) {
      throw new Error(`${name} was not acknowledged within ${timeout} ms.`);
    }
    return true;
  }

  /* Soft tokens: the RE found VER and KEY do not answer standalone, because
     the state machine gates them. Observed on hardware, a flash that never
     sends them still completes, so these are reported, never fatal. */
  async _try(name, timeout = 800) {
    this._drain();
    await this._tx(CDC_TOKENS[name]);
    const ok = await this._await(CDC_ACK_OK, timeout);
    if (!ok) log(`CDC ${name} did not answer — the state machine gates it; continuing.`, 'warn');
    return ok;
  }

  async chipId() {
    this._drain();
    await this._tx(CDC_TOKENS.CHP);
    await this._await(CDC_ACK_OK, 3000);
    const blob = await this._settle(140);
    const s = String.fromCharCode(...blob).replace(/[^\x20-\x7E]/g, '');
    const m = s.match(/KT[0-9A-Z]+[A-Z]?/i);
    return m ? m[0] : (s.length >= 4 ? s : null);
  }

  /* Image fingerprint — (size, CRC-32) of the whole image, NOT its contents.
     The RE is explicit that INF is a verify check and there is no software
     read-back path on this silicon, so it can confirm a write landed without
     ever returning the firmware. */
  async fingerprint() {
    this._drain();
    await this._tx(CDC_TOKENS.INF);
    const ok = await this._await(CDC_ACK_OK, 2000);
    const blob = await this._settle(120);
    if (blob.length >= 8) {
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      return { size: dv.getUint32(0, true), crc: hex(dv.getUint32(4, true), 8) };
    }
    return ok ? { size: null, crc: null } : null;
  }

  async reset() { return this._try('RESET', 1500); }

  async flash(bytes, onProgress, opts = {}) {
    if (!this.connected) throw new Error('CDC link not open.');
    this._abort = false;
    const { base = 0, bankId = 1 } = opts;

    /* One-shot sequential state machine: once KTM is consumed a repeat gets
       no reply until the unit re-unlocks. This order is load-bearing. */
    await this._cmd('KTM');
    await this._try('VER');
    await this._try('KEY');
    const cid = await this.chipId();
    await this._cmd('ERASE', { timeout: 20000 });
    await this._cmd('PWO');
    await this._cmd('KSTA');
    this.info = { chip: cid, size: bytes.length, transport: 'cdc' };
    log(`CDC handshake ok — chip ${cid ?? '?'}, base ${hex(base, 6)}, bank ${bankId}`, 'ok');

    const plan = [...cdcImagePackets(bytes, { base, bankId })];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      if (this._abort) throw new Error('Aborted by the operator.');
      await this._tx(cdcPacket(p.payload, p.addr, p.top3));
      if (!await this._await(CDC_ACK_BLOCK, 8000)) {
        throw new Error(`Block ${p.block} at ${hex(p.addr, 6)} was not acknowledged — do not unplug.`);
      }
      onProgress?.((i + 1) / plan.length, p.block, plan.length);
    }
    await this._cmd('STP');
    const fp = await this.fingerprint();
    if (fp?.size) log(`CDC INF — size ${fp.size}, crc32 ${fp.crc}`, 'ok');
    onProgress?.(1, bytes.length, plan.length);
    log('CDC flash sequence complete — the unit resets itself; replug it.', 'ok');
    return this.info;
  }

  abort() { this._abort = true; }
}

const CDC = new CdcLink();
