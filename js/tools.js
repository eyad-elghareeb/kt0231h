/* ═══════════════════════════════════════════════════════════════════════
   KTLAB · js/tools.js — everything that is not the core EQ loop.
   Loaded fourth. Owns: preset storage and interchange, AutoEQ import,
   the firmware image patcher, the bootloader flasher, the chip prober,
   the DRC editor, the register explorer and the memory peek.

   Reads and writes are honest about their confidence: anything not
   vendor-confirmed is labelled as such in the UI.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ══════════ § 1  PRESET STORAGE ══════════
   Schema v4 keeps both banks, the per-band flags, all four gain controls
   and the profile that produced it. The importer still understands the v3
   shape ({bands, adcBands, globalGain, …}) so older exports keep working. */
const PRESET_KEY = 'kt-dac-presets-v4';

const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cleanBand = b => {
  return {
    freq: clamp(Math.round(Number(b.freq) || 1000), F_MIN, F_MAX),
    gain: clamp(Number(b.gain) || 0, -64, 64),
    q: clamp(Number(b.q) || 0.707, 0.05, 65.535),
    filterType: Number(b.filterType) || 0,
  };
}
function snapshotState() {
  return {
    version: 4,
    savedAt: new Date().toISOString(),
    profile: hid.profile.name,
    banks: Object.fromEntries(Object.entries(state.banks).map(([k, v]) => [k, v.map(cleanBand)])),
    flags: JSON.parse(JSON.stringify(state.flags)),
    gains: {
      globalGain: state.globalGain, globalGainR: state.globalGainR,
      pgaADC: state.pgaADC, pgaDAC: state.pgaDAC, digADC: state.digADC,
    },
  };
}

const Presets = {
  load() {
    try {
      const p = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}');
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch { return {}; }
  },
  save(map) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(map)); return true; }
    catch (err) { log('Could not write presets to localStorage: ' + err.message, 'err'); return false; }
  },
  names() { return Object.keys(this.load()); },
  add(name) {
    const map = this.load();
    map[name.trim()] = snapshotState();
    return this.save(map);
  },
  rename(oldName, newName) {
    const map = this.load();
    if (!(oldName in map) || !newName.trim()) return false;
    map[newName.trim()] = map[oldName];
    delete map[oldName];
    return this.save(map);
  },
  remove(name) { const m = this.load(); delete m[name]; return this.save(m); },
  clearAll() { try { localStorage.removeItem(PRESET_KEY); } catch { /* ignore */ } },

  /** Normalise any accepted shape into a v4 entry, or null if unusable. */
  normalise(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.banks && typeof entry.banks === 'object') {
      const banks = {};
      for (const [k, v] of Object.entries(entry.banks)) {
        if (!Array.isArray(v) || !v.length) continue;
        if (!v.every(b => typeof b?.freq === 'number' && typeof b?.gain === 'number')) return null;
        banks[k] = v.map(cleanBand);
      }
      if (!banks.DAC?.length) return null;
      const g = entry.gains || {};
      return {
        version: 4,
        savedAt: entry.savedAt || new Date().toISOString(),
        profile: entry.profile || 'unknown',
        banks,
        flags: entry.flags && typeof entry.flags === 'object' ? entry.flags : {},
        gains: {
          globalGain: numOr(g.globalGain, 0), globalGainR: numOr(g.globalGainR, numOr(g.globalGain, 0)),
          pgaADC: numOr(g.pgaADC, 0), pgaDAC: numOr(g.pgaDAC, 0), digADC: numOr(g.digADC, 0),
        },
      };
    }
    // v3 shape
    if (!Array.isArray(entry.bands) || !entry.bands.length) return null;
    const ok = a => Array.isArray(a) && a.every(b =>
      typeof b?.freq === 'number' && typeof b?.gain === 'number' &&
      typeof b?.q === 'number' && typeof b?.filterType === 'number');
    if (!ok(entry.bands)) return null;
    if (entry.adcBands !== undefined && !ok(entry.adcBands)) return null;
    return {
      version: 3,
      savedAt: entry.savedAt || new Date().toISOString(),
      profile: 'imported',
      banks: entry.adcBands ? { DAC: entry.bands, ADC: entry.adcBands } : { DAC: entry.bands },
      flags: {},
      gains: {
        globalGain: numOr(entry.globalGain, 0), globalGainR: numOr(entry.globalGain, 0),
        pgaADC: numOr(entry.pgaADC, 0), pgaDAC: numOr(entry.pgaDAC, 0), digADC: numOr(entry.digADC, 0),
      },
    };
  },
  numOr,

  importJSON(file) {
    return file.text().then(text => {
      let raw;
      try { raw = JSON.parse(text); }
      catch { throw new Error('Not valid JSON.'); }

      // A bare AutoEQ file?  Route it to the filter importer instead.
      if (raw && Array.isArray(raw.filters) && raw.filters.length) {
        return { kind: 'autoeq', count: AutoEQ.ingest(raw, file.name) };
      }
      // A single preset object rather than a map of them?
      if (raw && (raw.banks || raw.bands) && !Array.isArray(raw)) {
        const one = this.normalise(raw);
        if (!one) throw new Error('No usable preset found in the file.');
        const map = this.load();
        map[this.guessName(raw) || `imported ${this.names().length + 1}`] = one;
        this.save(map);
        return { kind: 'single', count: 1 };
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Expected a JSON object of named presets.');
      }
      const map = this.load();
      const good = {}, bad = [];
      for (const [name, entry] of Object.entries(raw)) {
        const n = this.normalise(entry);
        if (n) good[name] = n; else bad.push(name);
      }
      if (bad.length) log(`Skipped ${bad.length} unusable entr${bad.length === 1 ? 'y' : 'ies'}: ${bad.join(', ')}`, 'warn');
      if (!Object.keys(good).length) throw new Error('No valid presets found in the file.');
      Object.assign(map, good);
      this.save(map);
      return { kind: 'map', count: Object.keys(good).length, skipped: bad.length };
    });
  },
  guessName(raw) {
    return raw.name || raw.title || raw.model || raw.headphone || null;
  },
  exportJSON() {
    const map = this.load();
    return downloadText(`ktlab-presets-${nowStamp()}.json`, JSON.stringify(map, null, 2), 'application/json');
  },
  exportOne(name) {
    const entry = this.load()[name];
    if (!entry) throw new Error(`No preset named "${name}".`);
    downloadText(`ktlab-preset-${name.replace(/[^\w.-]+/g, '_')}.json`, JSON.stringify(entry, null, 2), 'application/json');
  },
};

/* ══════════ § 2  APPLY / RESTORE ══════════ */
function applyState(entry, { history = true, label = 'apply' } = {}) {
  if (!entry?.banks?.DAC?.length) throw new Error('Nothing to apply.');
  if (history) History.push(label);
  state.banks = JSON.parse(JSON.stringify(entry.banks));
  // Pad or trim to what this chip actually has.
  for (const key of Object.keys(state.banks)) {
    const want = profileBands().length;
    const arr = state.banks[key];
    while (arr.length < want) arr.push(cleanBand(hid.profile.defaultFreqs[arr.length] ?? 1000));
    arr.length = want;
    arr.forEach((b, i) => { b.index = i; });
  }
  if (!state.banks.ADC && hasAdcBank()) state.banks.ADC = profileBands();
  if (state.banks.ADC && !hasAdcBank()) delete state.banks.ADC;

  state.flags = {};
  for (const b of state.bands) {
    const src = entry.flags?.[b.index];
    state.flags[b.index] = { muted: !!src?.muted, solo: !!src?.solo };
  }
  const g = entry.gains || {};
  state.globalGain   = numOr(g.globalGain, 0);
  state.globalGainR  = numOr(g.globalGainR, state.globalGain);
  state.pgaADC       = numOr(g.pgaADC, 0);
  state.pgaDAC       = numOr(g.pgaDAC, 0);
  state.digADC       = numOr(g.digADC, 0);
  state.bank = 'DAC';

  App.buildBands();
  App.refreshAllBands();
  App.refreshGainUI();
  App.refreshBandTools();
  App.updateBankToggle();
  App.updateEqToggles();
  Graph.setBands(state.bands);
  return entry;
}

/* ══════════ § 3  AUTOEQ IMPORT ══════════
   Accepts the standard AutoEQ parametric export shape:
     { filters: [{type, frequency, gain, q}], target: [{freq, gain}] }
   The chip has a fixed band count, so when a file carries more filters than
   the hardware has bands the loudest ones win — dropping a 0.1 dB shelf in
   favour of a 6 dB scoop is almost always the right call, and the app says
   exactly what it dropped rather than silently truncating. */
const AUTOEQ_TYPES = {
  PEAKING: 0, PEAK: 0,
  LOW_PASS: 1, LOWPASS: 1, LPF: 1,
  HIGH_PASS: 2, HIGHPASS: 2, HPF: 2,
  LOW_SHELF: 3, LOWSHELF: 3, LOW_SHELF_FILTER: 3,
  HIGH_SHELF: 4, HIGHSHELF: 4, HIGH_SHELF_FILTER: 4,
  NOTCH: 5, BANDPASS: 5, BAND_PASS: 5,
};

const AutoEQ = {
  last: null,

  ingest(obj, fname) {
    if (!state.banks?.DAC?.length) throw new Error('Connect a device first — there are no bands to fill.');
    const filters = Array.isArray(obj.filters) ? obj.filters : [];
    if (!filters.length) throw new Error('No filters array in that file.');

    const mapped = [];
    for (const f of filters) {
      const freq = Number(f.frequency ?? f.freq);
      if (!Number.isFinite(freq) || freq < F_MIN || freq > F_MAX) continue;
      const typeKey = String(f.type ?? 'PEAKING').toUpperCase().replace(/[\s-]+/g, '_');
      mapped.push({
        freq: Math.round(freq),
        gain: clamp(Number(f.gain) || 0, -12, 12),
        q: clamp(Number(f.q) || 0.707, 0.1, 16),
        filterType: AUTOEQ_TYPES[typeKey] ?? 0,
        rawType: f.type ?? 'PEAKING',
      });
    }
    if (!mapped.length) throw new Error('No filters with a usable frequency in range 20 Hz – 20 kHz.');

    const room = state.banks.DAC.length;
    let chosen = mapped, dropped = [];
    if (mapped.length > room) {
      // Keep the loudest ones: dropping a 0.1 dB shelf in favour of a 6 dB
      // scoop is almost always the right call, and we report what went.
      chosen = [...mapped].sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, room);
      dropped = mapped.filter(f => !chosen.includes(f));
    }
    // Register slots are a fixed ladder, so the chosen bands always go in
    // frequency order — otherwise an imported set would come out shuffled.
    chosen = [...chosen].sort((a, b) => a.freq - b.freq);

    History.push('AutoEQ import');
    chosen.forEach((f, i) => {
      const b = state.banks.DAC[i];
      b.freq = f.freq; b.gain = f.gain; b.q = f.q; b.filterType = f.filterType;
      state.flags[i] = { muted: false, solo: false };
    });

    const target = this.normaliseTarget(obj.target);
    state.target = target;
    Graph.setTarget(target);
    Graph.setBands(state.bands);

    this.last = { name: fname, mapped: chosen, dropped, target, room };
    App.renderAutoEQ(this.last);
    return chosen.length;
  },

  /** Resample a sparse target curve onto our log axis and light-smooth it. */
  normaliseTarget(target) {
    if (!Array.isArray(target) || target.length < 2) return null;
    const pts = target
      .map(p => ({ freq: Number(p.freq ?? p.frequency), gain: Number(p.gain) }))
      .filter(p => Number.isFinite(p.freq) && Number.isFinite(p.gain))
      .filter(p => p.freq >= F_MIN && p.freq <= F_MAX)
      .sort((a, b) => a.freq - b.freq);
    if (pts.length < 2) return null;

    const out = [];
    const N = 180;
    for (let i = 0; i <= N; i++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, i / N);
      let j = 1;
      while (j < pts.length - 1 && pts[j].freq < f) j++;
      const a = pts[j - 1], b = pts[j];
      const t = b.freq === a.freq ? 0 : (f - a.freq) / (b.freq - a.freq);
      out.push({ freq: f, gain: a.gain + (b.gain - a.gain) * t });
    }
    // small moving average — AutoEQ targets are already dense, this only
    // takes the staircase off so the dashed overlay reads as a curve
    const sm = out.map((_, i) => {
      const lo = Math.max(0, i - 1), hi = Math.min(out.length - 1, i + 1);
      return (out[lo].gain + out[i].gain + out[hi].gain) / 3;
    });
    return out.map((p, i) => ({ freq: p.freq, gain: sm[i] }));
  },

  /** RMS and peak error of the current bank against a target curve. */
  error(target) {
    if (!target?.length) return null;
    let se = 0, peak = 0;
    for (const p of target) {
      const d = curveAt(p.freq, state.banks.DAC) - p.gain;
      se += d * d;
      peak = Math.max(peak, Math.abs(d));
    }
    return { rms: Math.sqrt(se / target.length), peak };
  },

  clearTarget() {
    state.target = null;
    Graph.setTarget(null);
    $('btn-graph-target').disabled = true;
    $('autoeq-report').innerHTML = '<p class="empty">No AutoEQ target loaded.</p>';
  },
};

/* ══════════ § 4  FIRMWARE IMAGE PATCHER ══════════
   Image band entry is 8 bytes, little-endian:
     [freq Hz u16][Q ×1000 u16][gain ×10 s16][type u16]
   Known table offsets on JA11/KT0211L-class images: DAC @0x106A,
   ADC @0x109A. The offsets are only a hint — the tables are relocated by
   pattern match every time, so a re-based image still works. */
const FwBin = {
  buf: null, name: '', original: null,
  dacOff: -1, adcOff: -1, enOff: -1, hasKtVid: false,
  TABLES: 5,     // the image table format is fixed at 5 entries
  EN_DELTA: 0x4E,

  encode(band) {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, Math.round(clamp(band.freq, 0, 65535)), true);
    dv.setUint16(2, Math.round(clamp(band.q, 0, 65.535) * 1000), true);
    dv.setInt16(4, Math.round(clamp(band.gain, -3276.8, 3276.7) * 10), true);
    dv.setUint16(6, band.filterType & 0xFFFF, true);
    return b;
  },
  decode(bytes, off) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 8);
    return {
      freq: dv.getUint16(0, true),
      q: dv.getUint16(2, true) / 1000,
      gain: dv.getInt16(4, true) / 10,
      filterType: dv.getUint16(6, true),
    };
  },

  /** A run of n 8-byte entries that looks like an EQ table. */
  locateRun(bytes, n, hint) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const plausible = off => {
      for (let i = 0; i < n; i++) {
        const q = dv.getUint16(off + i * 8 + 2, true);
        const ty = dv.getUint16(off + i * 8 + 6, true);
        const fq = dv.getUint16(off + i * 8 + 0, true);
        if (q < 100 || q > 5000) return false;
        if (ty > 4) return false;
        if (fq < 20 || fq > 20000) return false;
      }
      return true;
    };
    if (hint >= 0 && hint + n * 8 <= bytes.length && plausible(hint)) return hint;
    for (let off = 0; off + n * 8 <= bytes.length; off += 4) if (plausible(off)) return off;
    return -1;
  },

  async load(file) {
    const ab = await file.arrayBuffer();
    this.buf = new Uint8Array(ab);
    // A real copy — two views onto one ArrayBuffer would leave the
    // "bytes changed" count permanently at zero.
    this.original = new Uint8Array(this.buf);
    this.name = file.name;

    this.dacOff = this.locateRun(this.buf, this.TABLES, 0x106A);
    this.adcOff = -1;
    if (this.dacOff >= 0) {
      this.adcOff = this.locateRun(this.buf, this.TABLES, this.dacOff + this.TABLES * 8 + 0x1C);
      if (this.adcOff < 0) this.adcOff = this.locateRun(this.buf, this.TABLES, this.dacOff + 0x30);
    }
    // Bank-enable byte. Verified on two independent images: the Tanchjim
    // KT0211L factory BIN (ADC table at 0x109A → enable byte at 0x10E8 =
    // 0x03, both banks on, matching the live registers) and the JA11 Ellyn
    // preset. Only a low-nibble value is accepted, so a mis-located offset
    // can never corrupt code. Patching ORs bits in, never clears them.
    this.enOff = -1;
    if (this.adcOff >= 0) {
      const eo = this.adcOff + this.EN_DELTA;
      if (eo < this.buf.length && (this.buf[eo] & 0xF0) === 0) this.enOff = eo;
    }
    this.hasKtVid = false;
    for (let i = 0; i + 1 < this.buf.length; i += 2) {
      if (this.buf[i] === 0xB2 && this.buf[i + 1] === 0x31) { this.hasKtVid = true; break; }
    }
    log(`Image loaded: ${file.name} (${fmtBytes(this.buf.length)}) · DAC table ${this.dacOff >= 0 ? hex(this.dacOff) : 'NOT FOUND'} · ADC ${this.adcOff >= 0 ? hex(this.adcOff) : 'not found'}`);
    return this.info();
  },

  info() {
    return {
      name: this.name,
      size: this.buf?.length ?? 0,
      dacOff: this.dacOff, adcOff: this.adcOff, enOff: this.enOff,
      enVal: this.enOff >= 0 ? this.buf[this.enOff] : -1,
      hasKtVid: this.hasKtVid,
      patched: this.patchedBytes(),
    };
  },

  /**
   * Header summary, per the documented meta block:
   *   <flash-tag><chip-id>[NUL] "Size" <u32 LE payload size> <build> ... "ENTY" <u32 LE x N>
   * The tag / chip-id boundary is a naming convention rather than a
   * delimiter, so the tag is read as a fixed-width prefix and the chip id
   * is the printable run after it. "Size" and "ENTY" are found by sentinel,
   * never by guessing an offset.
   */
  header() {
    if (!this.buf) return null;
    const TAG_WIDTH = 16;          // every documented flash tag is 16 chars
    const b = this.buf;
    const printable = c => c >= 0x20 && c < 0x7F;

    let tag = '';
    for (let i = 0; i < TAG_WIDTH && i < b.length; i++) {
      tag += printable(b[i]) ? String.fromCharCode(b[i]) : ' ';
    }
    let chipId = '';
    for (let i = TAG_WIDTH; i < Math.min(b.length, 0x40); i++) {
      if (!printable(b[i])) break;
      chipId += String.fromCharCode(b[i]);
    }

    const findText = s => {
      const needle = Array.from(s, ch => ch.charCodeAt(0));
      outer: for (let i = 0; i + needle.length <= b.length; i++) {
        for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
        return i;
      }
      return -1;
    };
    const u32 = at => (at >= 0 && at + 4 <= b.length)
      ? new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true) : null;

    const sizeAt = findText('Size');
    const entyAt = findText('ENTY');
    // The chip id is the printable run after the tag, but it ends at the
    // "Size" sentinel as well as at the first NUL — both terminate it.
    if (sizeAt >= 0) chipId = chipId.slice(0, Math.max(0, sizeAt - TAG_WIDTH));

    const enty = [];
    if (entyAt >= 0) {
      for (let k = entyAt + 4; k + 4 <= b.length && enty.length < 2; k += 4) enty.push(u32(k));
    }
    return { tag: tag.trim(), chipId: chipId.trim(), sizeField: sizeAt >= 0 ? u32(sizeAt + 4) : null, enty };
  },

  readTable(off, n = this.TABLES) {
    if (off < 0 || !this.buf) return null;
    return Array.from({ length: n }, (_, i) => this.decode(this.buf, off + i * 8));
  },
  patchTable(off, bands) {
    if (off < 0 || !this.buf) return false;
    const n = Math.min(this.TABLES, bands.length);
    for (let i = 0; i < n; i++) this.buf.set(this.encode(bands[i]), off + i * 8);
    return true;
  },
  patchEnable() {
    if (this.enOff < 0 || !this.buf) return null;
    const old = this.buf[this.enOff];
    this.buf[this.enOff] = old | 0x03;
    return [old, this.buf[this.enOff]];
  },
  /** How many bytes differ from the file as loaded. */
  patchedBytes() {
    if (!this.buf || !this.original) return 0;
    let n = 0;
    for (let i = 0; i < this.buf.length; i++) if (this.buf[i] !== this.original[i]) n++;
    return n;
  },
  exportBlob() { return new Blob([this.buf], { type: 'application/octet-stream' }); },

  /**
   * A flashing preflight. A wrong flash is unrecoverable without hardware
   * access, so the checks are deliberately pessimistic and each one says
   * what it looked at.
   */
  preflight() {
    const out = [];
    const push = (state, text) => out.push({ state, text });
    if (!this.buf) {
      push('fail', 'No image loaded.');
      return out;
    }
    const info = this.info();
    const h = this.header();
    push(info.hasKtVid ? 'pass' : 'fail',
      info.hasKtVid
        ? '<b>KTMicro VID marker</b> 0x31B2 present in the image.'
        : '<b>No VID 0x31B2 marker.</b> This may not be a KTMicro image at all — stop and verify.');

    const tagKnown = h?.tag && /^KT_|^KTM_/.test(h.tag);
    push(tagKnown ? 'pass' : 'warn',
      tagKnown
        ? `Flash tag <b>${esc(h.tag)}</b> — a recognised KTMicro platform prefix.`
        : h?.tag
          ? `Flash tag "${esc(h.tag)}" does not start with KT_ or KTM_.`
          : 'No flash tag could be read from the header.');

    if (h?.enty?.length) {
      const [load, span] = h.enty;
      const loadOk = load >= 0x80000 && load <= 0x90000;
      push(loadOk ? 'pass' : 'warn',
        `ENTY load <b>${hex(load)}</b>${span ? `, span ${hex(span)}` : ''} — ${loadOk ? 'inside the usual 0x80000–0x90000 window' : 'outside the expected window'}.`);
      // The second ENTY word is meant to be a target-space size. On the
      // KT0211L factory images it repeats the load address instead, so say
      // so rather than let a reader treat 0x8B000 as a byte count.
      if (span && span <= load) {
        push('warn', `ENTY second word <b>${hex(span)}</b> is not larger than the load address — this image stores no usable target span there. The size field is what the block writer uses.`);
      }
    } else {
      push('warn', 'No ENTY record found in the first 0x80 bytes.');
    }

    push(info.dacOff >= 0 ? 'pass' : 'fail',
      info.dacOff >= 0
        ? `DAC EQ table located at <b>${hex(info.dacOff)}</b> (5 entries).`
        : 'No EQ table pattern found. Patching is disabled and this image should not be flashed.');

    if (info.adcOff >= 0) {
      push('pass', `ADC EQ table located at <b>${hex(info.adcOff)}</b>.`);
    } else {
      push('warn', 'No ADC EQ table found — only the DAC bank will be patched.');
    }
    push(info.enOff >= 0 ? 'pass' : 'warn',
      info.enOff >= 0
        ? `Bank-enable byte at <b>${hex(info.enOff)}</b> = 0x${info.enVal.toString(16)} (OR-only patching).`
        : 'No bank-enable byte found — the image may ship with the EQ banks disabled.');

    push(state.banks?.DAC?.length === FwBin.TABLES ? 'pass' : 'warn',
      `This chip has <b>${state.banks?.DAC?.length ?? 0}</b> bands; the image table holds <b>${FwBin.TABLES}</b>. `
      + (state.banks?.DAC?.length > FwBin.TABLES
        ? 'Extra chip bands will keep the image value — the app cannot express them in this format.'
        : 'Extra image entries keep their factory value.'));

    push('warn', 'Always flash an image you dumped from <b>this exact unit</b>. A foreign image can brick the dongle, and no software-only recovery exists.');
    return out;
  },
};

/* ══════════ § 5  BOOTLOADER FLASHER ══════════
   Transport: HID feature reports. Commands are 4-byte LE u32:
     KTM 0x1E4B544D sync · VER 0xF0564552 · KEY 0xF04B4559 · CHP 0xD2434850
     CFG 0x2D29… · PWO 0x3C50574F · KSTA 0x4B535441 · STP 0x96535450
   ACK 0x78 / CONT 0xA5. Write block = [0x69][sub][region u16][addr u16][512 B].
   Sequence: sync → ver → key → chp → cfg → pwo → ksta → meta(0xF0@0x80) →
   data blocks (0x00, +4 each) → cfgblk(0x90 region 0xE2) → sig(0x10@0x80
   region 0xE0) → stp.
   NOTE: the vendor's own 1.0.58 tool appends a 4-byte tail per block that
   the upstream hardware-verified implementation does not send; this panel
   sends the upstream format. See PROTOCOL.md. */
const BOOT = {
  VID: 0x31B2,
  PIDS: [0x0101, 0x0001, 0x0002],
  BLOCK: 512,
  dev: null, connected: false, info: null,
  _abort: false,

  async connect() {
    if (!navigator.hid) throw new Error('WebHID unavailable.');
    const list = await navigator.hid.requestDevice({ filters: this.PIDS.map(pid => ({ vendorId: this.VID, productId: pid })) });
    if (!list.length) throw new Error('No bootloader device selected.');
    const dev = list[0];
    if (!dev.opened) await dev.open();
    this.dev = dev;
    this.connected = true;
    dev.addEventListener('disconnect', () => {
      this.connected = false; this.dev = null;
      log('Bootloader disconnected.', 'warn');
      App.updateBootUI();
    });
    return `${dev.productName || 'bootloader'} ${hex(dev.vendorId)}:${hex(dev.productId)}`;
  },

  disconnect() {
    const d = this.dev;
    this.dev = null; this.connected = false; this.info = null;
    return d?.opened ? d.close() : Promise.resolve();
  },

  async _feature(data, timeoutMs = 3000) {
    if (!this.connected) throw new Error('Bootloader not connected.');
    await this.dev.sendFeatureReport(0, data);
    return this._waitInput(timeoutMs);
  },

  _waitInput(timeoutMs) {
    return new Promise(res => {
      let done = false;
      const cleanup = () => { clearTimeout(timer); this.dev?.removeEventListener('inputreport', h); };
      const timer = setTimeout(() => {
        if (done) return;
        done = true; cleanup();
        this.dev?.receiveFeatureReport(0)
          .then(r => res(new Uint8Array(r.buffer, r.byteOffset, r.byteLength)))
          .catch(() => res(new Uint8Array(0)));
      }, timeoutMs);
      const h = e => {
        if (done) return;
        done = true; cleanup();
        res(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
      };
      this.dev.addEventListener('inputreport', h);
    });
  },

  async _cmd32(word, label) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, word >>> 0, true);
    log(`BOOT TX ${fmt(b)}  ${label}`, 'tx');
    const rx = await this._feature(b);
    if (rx?.length) log(`BOOT RX ${fmt(rx.subarray(0, 12))}`, 'rx');
    return rx;
  },

  /* Some builds put the ACK at [1], the vendor tool logs it at [0]. */
  staticAck(rx) {
    if (!rx || rx.length < 2) return false;
    return [0x78, 0xA5].includes(rx[0]) || [0x78, 0xA5].includes(rx[1]);
  },

  async sync(retries = 6) {
    for (let i = 0; i < retries; i++) {
      if (this._abort) return false;
      if (this.staticAck(await this._cmd32(0x1E4B544D, 'KTM sync'))) return true;
      await sleep(200);
    }
    return false;
  },
  async version() {
    const rx = await this._cmd32(0xF0564552, 'VER');
    return this.staticAck(rx) ? { byte0: rx[2], byte1: rx[3] } : null;
  },
  async key()   { return this.staticAck(await this._cmd32(0xF04B4559, 'KEY')); },
  async chipId() {
    const rx = await this._cmd32(0xD2434850, 'CHP');
    if (!rx || rx.length < 4) return null;
    const s = String.fromCharCode(...Array.from(rx).filter(c => c >= 0x20 && c < 0x7F))
      .replace(/[^0-9A-Za-z._-]/g, '');
    return s.length >= 4 ? s : null;
  },
  async configure(chipType = 0x10, flashBase = 0x6000, sectorSize = 0x0E, timing = 0x15) {
    const cmd = new Uint8Array([0x2D, 0x29, 0x00, chipType, sectorSize, timing,
      flashBase & 0xFF, (flashBase >> 8) & 0xFF, 0x00, 0xBC]);
    log(`BOOT TX ${fmt(cmd)}  CFG`, 'tx');
    return this.staticAck(await this._feature(cmd));
  },
  async powerOn() { return this.staticAck(await this._cmd32(0x3C50574F, 'PWO')); },
  async start()   { return this.staticAck(await this._cmd32(0x4B535441, 'KSTA')); },
  async stop()    { await this._cmd32(0x96535450, 'STP'); },

  async writeBlock(blockAddr, data, subtype = 0x00, region = 0x00E4) {
    const padded = new Uint8Array(this.BLOCK);
    padded.set(data.subarray(0, Math.min(this.BLOCK, data.length)));
    const pkt = new Uint8Array(6 + this.BLOCK);
    const dv = new DataView(pkt.buffer);
    pkt[0] = 0x69;
    pkt[1] = subtype;
    dv.setUint16(2, region & 0xFFFF, true);
    dv.setUint16(4, blockAddr & 0xFFFF, true);
    pkt.set(padded, 6);
    log(`BOOT 0x69 sub=${hex(subtype, 2)} region=${hex(region)} addr=${hex(blockAddr)} (${this.BLOCK} B)`, 'tx');
    return this.staticAck(await this._feature(pkt, 5000));
  },

  abort() { this._abort = true; },

  async flash(bytes, onProgress) {
    this._abort = false;
    const size = bytes.length;
    if (!await this.sync()) throw new Error('Sync failed — is the unit actually in boot mode?');
    const ver = await this.version();
    if (!await this.key())   throw new Error('KEY unlock failed.');
    const cid = await this.chipId();
    if (!await this.configure()) throw new Error('CFG failed.');
    if (!await this.powerOn())  throw new Error('PWO failed.');
    if (!await this.start())    throw new Error('KSTA failed.');
    this.info = { ver, chip: cid, size };
    log(`BOOT handshake ok — version ${JSON.stringify(ver)}, chip ${cid ?? '?'}`, 'ok');

    let ba = 0x80;
    if (!await this.writeBlock(ba, this.makeMeta(cid, size), 0xF0)) throw new Error('Meta block write failed.');
    ba += 4;

    const n = Math.ceil(size / this.BLOCK);
    for (let i = 0; i < size; i += this.BLOCK) {
      if (this._abort) throw new Error('Aborted by the operator.');
      if (!await this.writeBlock(ba, bytes.subarray(i, i + this.BLOCK))) {
        throw new Error(`Data block at ${hex(ba)} failed — do not unplug.`);
      }
      ba += 4;
      onProgress?.(Math.min(i + this.BLOCK, size) / size, i, n);
    }
    if (!await this.writeBlock(ba, new Uint8Array(this.BLOCK), 0x90, 0x00E2))
      log('Config block write failed — continuing.', 'warn');
    if (!await this.writeBlock(0x80, this.makeSig(cid, bytes), 0x10, 0x00E0))
      log('Signature block write failed — continuing.', 'warn');

    await this.stop();
    onProgress?.(1, size, n);
    log('Flash sequence complete — replug the device.', 'ok');
  },

  makeMeta(chipId, fwSize) {
    const m = new Uint8Array(this.BLOCK);
    const dv = new DataView(m.buffer);
    const cid = (chipId || 'KT_UNKNOWN').slice(0, 15);
    for (let i = 0; i < cid.length; i++) m[i] = cid.charCodeAt(i);
    const put = (s, off) => { for (let i = 0; i < s.length && off + i < m.length; i++) m[off + i] = s.charCodeAt(i); };
    put('Size', 0x08);
    dv.setUint32(0x0C, fwSize, true);
    put('fw', 0x10);
    put(new Date().toISOString().slice(0, 10), 0x14);
    put('ENTY', 0x60);
    dv.setUint32(0x64, 0x0008B000, true);
    dv.setUint32(0x68, 0x0008B000, true);
    return m;
  },

  makeSig(chipId, fw) {
    const s = new Uint8Array(this.BLOCK);
    const name = 'KT_lnv1b_flash_1';
    for (let i = 0; i < name.length; i++) s[i] = name.charCodeAt(i);
    let c = 0xFFFFFFFF;                       // CRC-32 (zlib polynomial)
    for (let i = 0; i < fw.length; i++) {
      c ^= fw[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    new DataView(s.buffer).setUint32(16, (c ^ 0xFFFFFFFF) >>> 0, true);
    return s;
  },
};

/* ══════════ § 6  CHIP PROBER / IDENTITY ══════════ */
const KNOWN_REGS = {
  0x00: 'version[0]', 0x01: 'flags — bit9 single-DAC', 0x04: 'version[1]',
  0x06: 'version (0231H layout)', 0x08: 'build date[0]', 0x0A: 'build date[1]',
  0x18: 'ADC EQ enable (Helios)', 0x1A: 'ADC band 0 A (Helios)',
  0x24: 'DAC EQ enable (Helios)', 0x26: 'DAC band 0 A (Helios)',
  0x34: 'DAC EQ enable (0231H)', 0x35: 'DAC band 0 A (0231H)',
  0x3A: 'A_ADC PGA / EQ (0231H)', 0x3B: 'A_DAC PGA / EQ (0231H)',
  0x40: 'USB manufacturer[0]', 0x48: 'USB product[0]', 0x50: 'USB serial[0]',
  0x5B: 'VID:PID packed', 0x65: 'DIG_ADC', 0x66: 'DIG_DAC',
  0x71: 'noise gate config', 0x72: 'gate attack/release', 0x73: 'gate hold',
  0x78: 'limiter config', 0x79: 'limiter attack/release', 0xE1: 'magic',
};

const Identity = {
  last: null,

  async read() {
    const vpid = await readRegister(0x5B);
    return {
      version:      await readString(0x00, 2),
      flags:        await readRegister(0x01),
      buildDate:    await readString(0x08, 2),
      manufacturer: await readString(0x40, 2),
      product:      await readString(0x48, 2),
      serial:       await readString(0x50, 2),
      vpid,
      magic:        (await readRegister(0xE1)) >>> 0,
    };
  },

  /* A-reg = [freq Hz:16][gain ×10 :16 signed] — sanity-window both halves. */
  looksLikeBand(v) {
    const f = (v >>> 16) & 0xFFFF;
    let g = v & 0xFFFF;
    if (g >= 0x8000) g -= 0x10000;
    return f >= 20 && f <= 20000 && Math.abs(g) <= 120;
  },

  /** Read-only fingerprint plus a layout discriminator. */
  async probe() {
    const id = await this.read();
    const why = [];
    let guess = null;

    // On Helios, 0x26 holds DAC band 0's A-reg; on KT0231H, 0x35 does.
    // Whichever decodes sanely names the layout, and it still works after
    // someone has re-tuned the factory EQ.
    const v26 = await readRegister(0x26);
    const v35 = await readRegister(0x35);
    const h26 = this.looksLikeBand(v26), h35 = this.looksLikeBand(v35);
    if (h26 && !h35) {
      guess = 'KT02H20';
      why.push(`0x26 decodes as a band A-reg (${hex(v26)}, freq ${(v26 >>> 16)} Hz) while 0x35 does not → Helios layout`);
    } else if (h35 && !h26) {
      guess = 'KT0231H';
      why.push(`0x35 decodes as a band A-reg (${hex(v35)}, freq ${(v35 >>> 16)} Hz) while 0x26 does not → KT0231H layout`);
    } else if (h26 && h35) {
      why.push('both 0x26 and 0x35 look like band registers — inconclusive');
    } else {
      why.push('neither 0x26 nor 0x35 holds a band register — inconclusive');
    }

    const v = (id.version || '').toUpperCase();
    if (v.includes('CDS')) { guess = 'KT0211L'; why.push('version string contains "CDS" → the CDS.KT USB Audio family'); }

    /* The identity registers hold the vendor's own strings, so they are a
       better identity source than the USB descriptor — and the exact chip IDs
       (0211LC02 / KT02H20B / 02F20B / TURN2CDC) are known, so an exact hit
       here outranks any string match. Feeding the result back into hid lets
       identification improve *after* connecting, which is the whole point of
       a prober. */
    let chip = null, chipFrom = null;
    for (const [field, text] of [['version', id.version], ['product', id.product], ['manufacturer', id.manufacturer]]) {
      if (!text) continue;
      const exact = chipFromId(text);
      if (exact) { chip = exact.name; chipFrom = `${field} matches chip ID "${exact.evidence}"`; break; }
    }
    if (!chip) {
      for (const [field, text] of [['product', id.product], ['manufacturer', id.manufacturer], ['version', id.version]]) {
        if (!text) continue;
        const loose = chipFromProduct(text);
        if (loose) { chip = loose.name; chipFrom = `${field} string contains ${loose.name}`; break; }
      }
    }
    if (chip) {
      why.push(`chip ${chip} — ${chipFrom}`);
      // A chip ID or descriptor that names a part the layout probe did not
      // reach is worth saying out loud: the two disagree, and one of them is
      // wrong. Silently preferring either would hide a real mismatch.
      if (guess && PROFILES[chip] && guess !== chip) {
        why.push(`note: identity says ${chip} but the register layout looks like ${guess}`);
      } else if (!guess && PROFILES[chip]) {
        guess = chip;
      }
    }

    if (id.flags & 0x0200) why.push('flags bit9 set → single-DAC model (mic-only dongle class)');
    if (id.magic === 0x12345678) why.push('magic 0xE1 reads 0x12345678 as expected');
    else why.push(`magic 0xE1 reads ${hex(id.magic)} — unexpected for a genuine KTMicro part`);

    this.last = { guess, chip, why, id };
    return this.last;
  },

  render() {
    const box = $('dev-id');
    if (!box || !this.last) return;
    const { guess, why, id, chip } = this.last;
    const vid = id.vpid & 0xFFFF, pid = (id.vpid >>> 16) & 0xFFFF;
    const p = hid.profile;
    box.textContent = [
      `version    ${id.version || '(empty)'}`,
      `build      ${id.buildDate || '(empty)'}`,
      `manufacturer ${id.manufacturer || '(empty)'}`,
      `product    ${id.product || '(empty)'}`,
      `serial     ${id.serial || '(empty)'}`,
      `usb        ${hex(vid)}:${hex(pid)}    flags ${hex(id.flags)}    magic ${hex(id.magic)}`,
      '',
      `chip       ${chip ?? 'no catalogue match'}`,
      `active     ${p.name}   ${p.bandCount} bands   DAC base ${hex(hid.reg('EQ_DAC'))}   ACK ${hex(p.writeAck)}`,
      `probe says ${guess ?? 'unresolved'}`,
      ...why.map(w => '  · ' + w),
    ].join('\n');
  },

  fillFields() {
    if (!this.last) return;
    const id = this.last.id;
    $('usb-mfr').value    = id.manufacturer || '';
    $('usb-prod').value   = id.product || '';
    $('usb-serial').value = id.serial || '';
    $('usb-vid').value    = h16(id.vpid & 0xFFFF);
    $('usb-pid').value    = h16((id.vpid >>> 16) & 0xFFFF);
  },

  async refresh() {
    this.last = await this.probe();
    this.render();
    this.fillFields();
    log(`Identity: "${this.last.id.product || '?'}" v"${this.last.id.version}" ${this.last.id.buildDate} — probe says ${this.last.guess ?? 'unresolved'}`);
    /* Feed the prober's verdict back into identification. The device's own
       identity registers know more than the USB descriptor did, so the chip
       panel and the status line are refreshed from them — otherwise the probe
       would print a conclusion into a log nobody reads while the rest of the
       UI kept showing the pre-probe answer. */
    if (this.last.chip) {
      hid.chipId = this.last.chip;
      App.onProfileResolved(hid.profile);
      log(`Identification updated: ${this.last.chip} (from the device's own identity registers).`, 'ok');
    }
    if (this.last.guess && PROFILES[this.last.guess] && this.last.guess !== hid.profile.name) {
      toast(`The probe suggests ${this.last.guess}. Pick it in the override below if the EQ looks wrong.`, 'info', 6000);
    }
    return this.last;
  },

  packAsciiRegs(s, nBytes) {
    const out = [];
    for (let i = 0; i < nBytes; i += 4) {
      let v = 0;
      for (let j = 0; j < 4; j++) {
        const ch = i + j < s.length ? (s.charCodeAt(i + j) & 0xFF) : 0;
        v |= ch << (8 * j);
      }
      out.push(v >>> 0);
    }
    return out;
  },

  async writeStrings() {
    const mfr  = $('usb-mfr').value.trim();
    const prod = $('usb-prod').value.trim();
    const ser  = $('usb-serial').value.trim();
    if (!confirm(
      `Overwrite the USB strings?\n\n` +
      `  manufacturer  "${mfr}"\n  product       "${prod}"\n  serial        "${ser}"\n\n` +
      `These live in run-mode RAM: replug to see them, and use Save to flash where the chip supports it.`
    )) return;
    // mfr 0x40–0x47 (8 B), product 0x48–0x4F (8 B), serial 0x50–0x56 (7 B —
    // deliberately not spilling into 0x57).
    const plan = [
      [REG.MANUF,  this.packAsciiRegs(mfr, 8)],
      [REG.PRODUCT, this.packAsciiRegs(prod, 8)],
      [REG.SERIAL,  this.packAsciiRegs(ser, 7)],
    ];
    for (const [addr, regs] of plan) {
      for (let i = 0; i < regs.length; i++) await writeRegister(addr + i, regs[i]);
    }
    log(`USB strings written: "${mfr}" / "${prod}" / "${ser}"`, 'ok');
    toast('Strings written — replug to see them on the host.', 'ok', 5000);
  },

  async writeVidPid() {
    const vs = $('usb-vid').value.trim(), ps = $('usb-pid').value.trim();
    if (!/^[0-9a-fA-F]{1,4}$/.test(vs) || !/^[0-9a-fA-F]{1,4}$/.test(ps)) {
      toast('VID and PID must be 1–4 hex digits.', 'warn');
      return;
    }
    const vid = parseInt(vs, 16), pid = parseInt(ps, 16);
    if (!confirm(
      `Write USB VID:PID = ${hex(vid)}:${hex(pid)}?\n\n` +
      `The device presents this identity after the next replug, and host drivers match on it. ` +
      `Note the current pair first — it is shown on this page.`
    )) return;
    await writeRegister(REG.VIDPID, ((pid << 16) | vid) >>> 0);
    log(`VID:PID register ${hex(REG.VIDPID)} → ${hex(vid)}:${hex(pid)} (applies after replug, or a flash save)`, 'ok');
    toast('VID/PID written — replug to apply.', 'warn', 6000);
  },
};

/* ══════════ § 7  DRC — NOISE GATE + LIMITER ══════════
   Thresholds encode as byte = 256 + dB, so −60 dB is 0xC4 and −96 dB is 0xA0.
   The sum saturates at 255, which puts −1 dB at the very top of the range
   — 0 dB itself is not representable. Gate: 0x71 [EN bit7 | flags 0x3C]
   [TH][TH][gateVol] · 0x72 [AT][RT] · 0x73 [hold 10 ms][—]. Limiter: 0x78
   [EN bit7 | SOFT bit6][—][TH] · 0x79 [AT][RT]. Decoded from the vendor
   desktop app on KT02H20.

   Two caveats this editor deliberately does not paper over:
     · 0x73 is documented as [hold 0x000A][noiseT_ms:16] — two fields — but
       only `hold` is exposed, so writing the gate also clears noiseT to 0.
       Left as-is rather than guessed at: the value that belongs there is not
       in evidence, and inventing one would be worse than a documented loss.
     · 0x72 declares [AT_ms:16][RT_ms:16] while 0x79 declares bare [AT][RT].
       Both are written here as 16-bit. If 0.79 is really one byte per field,
       an attack or release above 255 ms cannot be expressed; the control's
       range reflects the 16-bit reading. */
const NG_FLAGS = 0x3C, NG_HOLD = 0x000A;
const thrByte = db => clamp(Math.round(256 + db), 0, 255);
const thrDb   = byte => clamp(byte, 0, 255) - 256;

const DRC = {
  async read() {
    try {
      const v71 = await readRegister(0x71);
      $('ng-en').classList.toggle('is-on', !!(v71 & 0x80));
      $('ng-th').value = thrDb((v71 >>> 8) & 0xFF);
      $('ng-gv').value = thrDb((v71 >>> 24) & 0xFF);
      const v72 = await readRegister(0x72);
      $('ng-at').value = v72 & 0xFFFF;
      $('ng-rt').value = (v72 >>> 16) & 0xFFFF;
      App.syncLabels('ng');
    } catch (err) { dbg(`gate readback: ${err.message}`); }
    try {
      const v78 = await readRegister(0x78);
      $('lim-en').classList.toggle('is-on', !!(v78 & 0x80));
      $('lim-soft').classList.toggle('is-on', !!(v78 & 0x40));
      $('lim-th').value = thrDb((v78 >>> 16) & 0xFF);
      const v79 = await readRegister(0x79);
      $('lim-at').value = v79 & 0xFFFF;
      $('lim-rt').value = (v79 >>> 16) & 0xFFFF;
      App.syncLabels('lim');
    } catch (err) { dbg(`limiter readback: ${err.message}`); }
  },

  async writeGate() {
    const on  = $('ng-en').classList.contains('is-on');
    const th  = thrByte(parseFloat($('ng-th').value));
    const gv  = thrByte(parseFloat($('ng-gv').value));
    const at  = clamp(parseInt($('ng-at').value, 10) || 0, 0, 65535);
    const rt  = clamp(parseInt($('ng-rt').value, 10) || 0, 0, 65535);
    await writeRegister(0x71, ((on ? 0x80 : 0) | NG_FLAGS | (th << 8) | (th << 16) | (gv << 24)) >>> 0);
    await writeRegister(0x72, ((at & 0xFFFF) | (rt << 16)) >>> 0);
    await writeRegister(0x73, NG_HOLD >>> 0);
    log(`Gate → ${on ? 'on' : 'off'}, threshold ${$('ng-th').value} dB, gate volume ${$('ng-gv').value} dB, ${at}/${rt} ms`, 'ok');
    toast('Noise gate written.', 'ok');
  },

  async writeLimiter() {
    const on   = $('lim-en').classList.contains('is-on');
    const soft = $('lim-soft').classList.contains('is-on');
    const th   = thrByte(parseFloat($('lim-th').value));
    const at   = clamp(parseInt($('lim-at').value, 10) || 0, 0, 65535);
    const rt   = clamp(parseInt($('lim-rt').value, 10) || 0, 0, 65535);
    await writeRegister(0x78, ((on ? 0x80 : 0) | (soft ? 0x40 : 0) | (th << 16)) >>> 0);
    await writeRegister(0x79, ((at & 0xFFFF) | (rt << 16)) >>> 0);
    log(`Limiter → ${on ? 'on' : 'off'}${soft ? ' (soft)' : ''}, threshold ${$('lim-th').value} dB, ${at}/${rt} ms`, 'ok');
    toast('Limiter written.', 'ok');
  },
};

/* ══════════ § 7b  FIRMWARE DIFFER ══════════
   Two KTMicro images that look like the same product are not necessarily the
   same firmware, and "these builds differ only in the product string" is a
   claim worth being able to check rather than assume. This compares two
   images byte for byte and reports the differences grouped by *what the bytes
   mean*, because an offset on its own is not an answer — a 12-byte run at
   0x1140 is a build number, and 12 bytes in an EQ table is a different tune
   entirely. Both matter, and they call for opposite reactions.

   Regions follow the documented image layout (ARCHITECTURE.md §2): the low
   0x3000 is flasher metadata that is never mapped, 0x1000-0x1140 is build
   info, and file offset 0x3000 is load address 0x83000. The string-table
   region is only meaningful for JA11-class images, so it is passed in rather
   than assumed. */

/** Coalesce differing byte offsets into runs, so a 40-byte string edit is one
 *  difference rather than forty. */
function fwDiffRuns(a, b) {
  const n = Math.min(a.length, b.length);
  const runs = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) { if (start < 0) start = i; }
    else if (start >= 0) { runs.push([start, i]); start = -1; }
  }
  if (start >= 0) runs.push([start, n]);
  // A length difference is itself a finding, not noise.
  if (a.length !== b.length) runs.push([n, Math.max(a.length, b.length)]);
  return runs;
}

const FW_REGIONS = [
  { from: 0x0000, to: 0x1000, key: 'meta',    label: 'flasher metadata (never mapped)' },
  { from: 0x1000, to: 0x1140, key: 'build',   label: 'build info' },
  { from: 0x1140, to: 0x3000, key: 'pre',     label: 'pre-load' },
  { from: 0x3000, to: 0xC7B0, key: 'code',    label: 'code' },
  { from: 0xC7B0, to: 0xFFFF, key: 'strings', label: 'debug string table' },
];

function fwRegionAt(off) {
  return FW_REGIONS.find(r => off >= r.from && off < r.to)?.key ?? 'tail';
}

/** Printable run at an offset, for labelling a difference that is text. */
function fwTextAt(buf, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    s += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '·';
  }
  return s;
}

/**
 * Compare two firmware images.
 * @param {Uint8Array} a  @param {Uint8Array} b
 * @param {object} ctx
 *   eqTables: [{ off, n, decode, name }] — EQ tables compared *semantically*,
 *     not by byte-range overlap. Overlap is not evidence: a byte inside the
 *     table can decode to the same band, because the struct carries fields the
 *     band model does not surface.
 */
function fwDiff(a, b, ctx = {}) {
  if (!a || !b) return null;
  const runs = fwDiffRuns(a, b);
  const byRegion = new Map();
  let codeBytes = 0, buildBytes = 0, textOnly = true;

  for (const [from, to] of runs) {
    const key = fwRegionAt(from);
    if (!byRegion.has(key)) byRegion.set(key, { bytes: 0, runs: [] });
    const g = byRegion.get(key);
    g.bytes += to - from;
    g.runs.push({ from, to, len: to - from });
    if (key === 'code') codeBytes += to - from;
    if (key === 'build') buildBytes += to - from;
    // Whether a difference is an *EQ* change is decided by decoding, below —
    // not by asking whether the byte range overlaps the table.
    for (const g2 of g.runs) {
      if (g2.len <= 64 && /^[·\x20-\x7e]+$/.test(fwTextAt(a, g2.from, g2.len)) && /^[·\x20-\x7e]+$/.test(fwTextAt(b, g2.from, g2.len))) continue;
      textOnly = false;
    }
  }

  /* Which EQ tables actually decode differently? Asked of the band model, not
     of the byte offsets, so the answer means something about sound.

     And a changed field is not automatically an audible change. A filter whose
     gain is 0 dB contributes nothing whatever its shape, so the 2024 and 2025
     Tanchjim cuts differ in band 4's filter type — 0 vs 1 — while every gain
     sits at 0 dB and both ship an identical flat curve. Reporting that as "a
     different EQ tune" would be an overclaim about what you hear, so each
     changed band is marked by whether it can actually move the response. */
  const eqChanged = [];
  const skipped = [];
  const audible = x => (x.gain ?? 0) !== 0;

  /* A decode only counts if it produces something a band could actually be.
     locateRun finds candidate tables by pattern and will happily match a run of
     non-EQ bytes; decoding one of those yields plausible-looking numbers with
     no meaning behind them — a "30 Hz band, type 65472" is not a filter. The
     earlier version reported those as five changed bands, which is worse than
     reporting nothing: it invents a difference the user cannot act on. */
  const plausible = x => Number.isFinite(x.freq) && x.freq >= 15 && x.freq <= 25000
    && Number.isFinite(x.q) && x.q >= 0.05 && x.q <= 20
    && Number.isFinite(x.gain) && x.gain >= -60 && x.gain <= 60
    && Number.isInteger(x.filterType) && x.filterType >= 0 && x.filterType <= 5;

  for (const t of (ctx.eqTables || [])) {
    const n = t.n ?? 5;
    if (t.off == null || t.off < 0) continue;
    let bad = 0, seen = 0;
    for (let i = 0; i < n; i++) {
      const off = t.off + i * 8;
      if (off + 8 > a.length || off + 8 > b.length) break;
      let da, db;
      try { da = t.decode(a, off); db = t.decode(b, off); }
      catch { bad = n; break; }
      seen++;
      if (!plausible(da) || !plausible(db)) bad++;
    }
    if (seen < n || bad > 0) {
      // Report why, and skip: a table that does not decode as bands is not
      // evidence about sound either way.
      skipped.push({ table: t.name ?? 'EQ', off: t.off, bad, of: n });
      continue;
    }
    for (let i = 0; i < n; i++) {
      const off = t.off + i * 8;
      const da = t.decode(a, off), db = t.decode(b, off);
      if (JSON.stringify(da) === JSON.stringify(db)) continue;
      // The response moves only if a magnitude or centre-frequency term moved,
      // or the shape changed on a band that is not at unity.
      const shapeOnly = da.freq === db.freq && da.q === db.q && da.gain === db.gain;
      eqChanged.push({
        table: t.name ?? 'EQ', band: i, a: da, b: db,
        audible: !shapeOnly && (audible(da) || audible(db)),
        shapeOnly,
      });
    }
  }
  const eqAudible = eqChanged.some(c => c.audible);
  const identical = runs.length === 0 && a.length === b.length;
  // A verdict, not a number: what does this mean for the two images?
  let verdict;
  if (identical) verdict = 'byte-identical';
  else if (eqAudible) verdict = 'same code, different EQ tune';
  else if (eqChanged.length) verdict = 'same code, EQ filter shape differs (no audible change — both bands sit at 0 dB)';
  else if (codeBytes > 0) verdict = 'different code — genuinely different firmware';
  else if (textOnly && buildBytes > 0) verdict = 'same code, different build/product strings';
  else if (textOnly) verdict = 'differ only in metadata or strings';
  else verdict = 'mixed differences';

  return {
    identical, verdict, runs: runs.length,
    bytes: runs.reduce((s, [f, t]) => s + (t - f), 0),
    sizeA: a.length, sizeB: b.length,
    eqChanged, eqSkipped: skipped, codeBytes, buildBytes,
    byRegion: [...byRegion].map(([key, g]) => ({ key, label: FW_REGIONS.find(r => r.key === key)?.label ?? key, ...g })),
    // Cap the detail: a 4000-byte run is one line, not four thousand.
    detail: runs.slice(0, 40).map(([from, to]) => ({
      from, to, len: to - from, region: fwRegionAt(from),
      a: fwTextAt(a, from, Math.min(to - from, 48)),
      b: fwTextAt(b, from, Math.min(to - from, 48)),
    })),
  };
}

/* ══════════ § 8  REGISTER EXPLORER ══════════ */
const Registers = {
  rows: null, prev: null, showDiff: false, filter: '',

  async dump() {
    this.prev = this.rows;
    const rows = [];
    const base = hid.profile.reg?.EQ_DAC ?? 0x26;
    for (let a = 0x00; a <= 0xFF; a++) {
      let v = null;
      try { v = await readRegister(a); } catch { v = null; }
      rows.push([a, v]);
      if ((a & 0x1F) === 0x1F) setStatus(`Register sweep ${a + 1}/256…`, 'working', '256 round-trips at the configured queue gap');
    }
    this.rows = rows;
    this.render();
    const ok = rows.filter(r => r[1] !== null).length;
    log(`Register sweep complete — ${ok}/256 answered.`, 'ok');
    setStatus('Register sweep complete.', 'ok', `${ok} of 256 addresses answered`);
    return rows;
  },

  matches(a, v) {
    if (!this.filter) return true;
    const f = this.filter;
    if (KNOWN_REGS[a]?.toLowerCase().includes(f)) return true;
    if (a.toString(16).padStart(2, '0').includes(f)) return true;
    if (v == null) return false;
    return (v >>> 0).toString(16).padStart(8, '0').includes(f);
  },

  render() {
    const box = $('reg-dump');
    if (!box) return;
    if (!this.rows) { box.textContent = '— no dump yet —'; return; }
    const frag = document.createDocumentFragment();
    let shown = 0, changed = 0;
    for (let i = 0; i < this.rows.length; i += 4) {
      const group = [];
      let groupChanged = false;
      for (const [a, v] of this.rows.slice(i, i + 4)) {
        if (!this.matches(a, v)) continue;
        shown++;
        const val = v === null ? '  -- ERR --' : (v >>> 0).toString(16).padStart(8, '0');
        const p = this.prev?.find(r => r[0] === a)?.[1];
        const isDiff = this.showDiff && this.prev && p !== v;
        if (isDiff) groupChanged = true;
        group.push({ a, val, label: KNOWN_REGS[a] || '', isDiff });
        if (isDiff) changed++;
      }
      if (!group.length) continue;
      const row = el('div', 'log-line');
      row.innerHTML = group.map(g =>
        `<b style="color:var(--text-3)">${g.a.toString(16).padStart(2, '0')}</b> ` +
        `<span style="color:${g.isDiff ? 'var(--ok)' : 'var(--text-2)'}">${g.val}</span>` +
        (g.label ? ` <span style="color:var(--text-3)">${esc(g.label)}</span>` : '')
      ).join('\n');
      if (groupChanged) row.style.background = 'var(--accent-soft)';
      frag.appendChild(row);
    }
    if (!shown) { box.innerHTML = '<span class="log-empty">nothing matches that filter</span>'; }
    else box.replaceChildren(frag);
    const st = $('reg-stats');
    if (st) {
      st.textContent = this.rows
        ? `${shown} of 256 shown · ${this.rows.filter(r => r[1] !== null).length} answered` +
          (this.showDiff && this.prev ? ` · ${changed} changed since the previous dump` : '')
        : 'A full sweep is 256 round-trips at the configured queue gap. Annotated addresses come from the reverse-engineered map; unknown ones are listed bare.';
    }
  },

  export(kind) {
    if (!this.rows) { toast('Run a register sweep first.', 'warn'); return; }
    const stamp = nowStamp();
    if (kind === 'csv') {
      const csv = 'addr_hex,addr_dec,value_hex,value_dec,label\n' + this.rows.map(([a, v]) =>
        `0x${a.toString(16).padStart(2, '0')},${a},${v == null ? '' : '0x' + (v >>> 0).toString(16)},${v ?? ''},"${KNOWN_REGS[a] || ''}"`).join('\n');
      downloadText(`ktlab-regs-${stamp}.csv`, csv, 'text/csv');
    } else {
      const json = JSON.stringify({
        kind: 'ktlab-register-dump', capturedAt: new Date().toISOString(),
        profile: hid.profile.name, vid: hex(hid.device?.vendorId ?? 0), pid: hex(hid.device?.productId ?? 0),
        rows: this.rows.map(([a, v]) => ({
          addr: `0x${a.toString(16).padStart(2, '0')}`,
          value: v == null ? null : (v >>> 0).toString(16),
          label: KNOWN_REGS[a] || null,
        })),
      }, null, 2);
      downloadText(`ktlab-regs-${stamp}.json`, json, 'application/json');
    }
    log(`Register dump exported as ${kind.toUpperCase()}.`);
  },
};

/* ══════════ § 9  EXTENDED-SPACE DUMP (0x08) ══════════ */
const ExtSpace = {
  dump: null,

  async dumpWords(start, count) {
    if (!Number.isFinite(start) || start < 0 || start > 0xFFFFFF) throw new Error('Start address must be 0 – 0xFFFFFF.');
    if (!Number.isFinite(count) || count < 1 || count > 4096) throw new Error('Word count must be 1 – 4096.');
    const words = [];
    for (let i = 0; i < count; i++) {
      let v = null;
      try { v = await memRead32(start + i * 4); } catch { v = null; }
      words.push(v);
      if ((i & 0x3F) === 0x3F) setStatus(`Extended dump ${i + 1}/${count} words…`, 'working');
    }
    this.dump = { start, words };
    this.render();
    const nz = words.filter(w => w != null && w !== 0).length;
    log(`Extended dump from ${hex(start)}: ${nz}/${count} words non-zero. Zeros are the expected answer on most runtimes — 0x08 does not read flash (PROTOCOL.md §9.1).`, nz ? 'warn' : 'inf');
    setStatus('Extended dump complete.', nz ? 'ok' : 'idle', `${nz} of ${count} words non-zero`);
    return this.dump;
  },

  render() {
    const box = $('ext-dump');
    if (!box || !this.dump) return;
    const lines = [];
    for (let i = 0; i < this.dump.words.length; i += 4) {
      lines.push((this.dump.start + i * 4).toString(16).padStart(8, '0') + '  ' +
        this.dump.words.slice(i, i + 4)
          .map(w => (w == null ? '        ' : (w >>> 0).toString(16).padStart(8, '0')))
          .join(' '));
    }
    box.textContent = lines.join('\n');
  },

  export() {
    if (!this.dump) { toast('Run an extended dump first.', 'warn'); return; }
    const buf = new ArrayBuffer(this.dump.words.length * 4);
    const dv = new DataView(buf);
    this.dump.words.forEach((w, i) => { if (w != null) dv.setUint32(i * 4, w >>> 0, true); });
    downloadBlob(`ktlab-ext-${hex(this.dump.start)}-${nowStamp()}.bin`, new Blob([buf], { type: 'application/octet-stream' }));
  },
};
