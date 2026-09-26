/* ═══════════════════════════════════════════════════════════════════════
   KTLAB · js/device.js — the protocol and the transport.
   Loaded second. Owns: register constants, device profiles and routing,
   the serialised command queue, the WebHID controller, the register
   read/write/SAVE/peek primitives, band encoding, and the live state.

   Every register address here is traceable to PROTOCOL.md / CHIPS.md.
   Unknown semantics are marked in comments — they are never guessed.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ══════════ § 1  PROTOCOL CONSTANTS ══════════ */
const RPT_ID   = 0x4B;

const CMD_READ  = 0x52;  // 'R' — read register, value at response[6..9]
const CMD_WRITE = 0x57;  // 'W' — write register, device ACKs with writeAck
const CMD_SAVE  = 0x53;  // 'S' — vendor commit of DSP RAM state to flash
const CMD_MEMRD = 0x08;  // extended-space word reader (answer usually zeros)
const WRITE_ACK = 0x03;  // the ACK byte most Helios firmware returns

/** Address defaults, matching the KT02H20 / Helios-class layout. */
const REG = Object.freeze({
  FLAGS:    0x01,   // bit9 (0x0200) = single-DAC model
  VERSION:  0x04,   // 2 regs, LE32 ASCII
  TIMESTAMP:0x08,   // build date string
  EQ_ADC_EN:0x18,
  EQ_ADC:   0x1A,   // ADC-side (mic) bands
  EQ_DAC_EN:0x24,
  EQ_DAC:   0x26,   // DAC bands
  EQ_STRIDE:2,      // A-reg then B-reg
  EQ_BANDS: 5,
  MANUF:    0x40,   // USB strings
  PRODUCT:  0x48,
  SERIAL:   0x50,
  VIDPID:   0x5B,   // [PID:16][VID:16]
  PGA_ADC:  0x3A,
  PGA_DAC:  0x3B,
  DIG_ADC:  0x65,   // byte0 = signed gain ×2 (0.5 dB)
  DIG_DAC:  0x66,   // byte0 = DACL, byte1 = DACR
  MAGIC:    0xE1,   // 0x12345678 on a genuine KTMicro part
});

/* PGA index → label. Vendor-confirmed on KT0211L / KT02H20. */
const PGA_ADC_GAINS = ['0 dB', '−6 dB', '8 dB', '14 dB', '20 dB', '26 dB', '32 dB', '44 dB'];
const PGA_DAC_GAINS = ['mute', ...Array.from({ length: 15 }, (_, i) => `${(1.5 * i - 18).toFixed(1)} dB`)];

const FILTER_TYPES = [
  { value: 0, label: 'Peak' },
  { value: 1, label: 'Low pass' },
  { value: 2, label: 'High pass' },
  { value: 3, label: 'Low shelf' },
  { value: 4, label: 'High shelf' },
];

/* ══════════ § 2  DEVICE PROFILES ══════════ */
/* The Helios register block, shared verbatim by every 5-band part. Spread
   it and override only what actually differs — a new chip then costs four
   lines instead of twenty, and there is no way to fat-finger a common
   address into one chip only. */
const HELIOS_REG = Object.freeze({
  EQ_DAC: 0x26, EQ_DAC_EN: 0x24,
  EQ_ADC: 0x1A, EQ_ADC_EN: 0x18,
  EQ_STRIDE: 2, EQ_BANDS: 5,
  PGA_ADC: 0x3A, PGA_DAC: 0x3B,
  DIG_ADC: 0x65, DIG_DAC: 0x66,
});

/* Confidence tiers, and what each one licenses.
 *
 * A profile is a claim about a chip's register block. Most of these claims are
 * inherited rather than measured, and the difference matters enormously the
 * moment someone writes to hardware: a wrong offset does not error, it
 * reconfigures something else. So the tier travels with the profile and is
 * shown in the UI rather than left to a paragraph of prose.
 *
 *   verified - a run-mode dump confirmed this layout on this part, with a
 *              distinct-value write, a readback and a restore.
 *   inferred - the layout is derived: a family sibling, or read out of a
 *              vendor firmware image. Believable, not measured on hardware.
 *   guess    - no evidence for this specific part at all. A best-effort
 *              default that must be read back after writing.
 */
/* One clause each: the tier name is the headline, the blurb is the single most
   useful fact or action. An earlier draft chained three clauses here, which
   turned a status chip into a paragraph in a panel header (apple-design §16.6).
   Anything longer belongs in the title attribute, not on screen. */
const CONFIDENCE = {
  verified: { rank: 2, label: 'verified', blurb: 'run-mode dump confirmed here' },
  inferred: { rank: 1, label: 'inferred', blurb: 'derived from family or image' },
  guess:    { rank: 0, label: 'guess',    blurb: 'unverified here — read back after writing' },
};

const PROFILES = {
  /* KT0231H - a different register block entirely: 6-band banks whose base
     is one above the Helios base, and a write ACK of 0x4F instead of 0x03.
     Layout and ACK are hardware-verified (2026-09-21: dump, distinct-value
     write, readback, restore). The 0x43 handshake is NOT required and
     actively stalls the HID pipe on this part, so it is never sent. */
  'KT0231H': {
    name: 'KT0231H', vid: 0x31B2, pid: 0x1132, confidence: 'verified',
    matchKeys: ['KT0231H', '0231H'],
    writeAck: 0x4F,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    bandCount: 6, defaultFreqs: [61, 122, 184, 248, 316, 392], defaultQ: 0.70,
    versionAddr: 0x06, versionCount: 2,
    supportsAdcBank: true, supportsSave: false,
    reg: { ...HELIOS_REG, EQ_DAC: 0x35, EQ_DAC_EN: 0x34, EQ_ADC: 0x42, EQ_ADC_EN: 0x41, EQ_BANDS: 6 },
    notes: 'Hardware-verified. 6-band DAC bank @0x35, 6-band ADC bank @0x42, write ACK 0x4F. Volume registers are still unknown on this part — 0x3A/0x3B are EQ data here and 0x65/0x66 read zero, so the Chain panel is best-effort. SAVE is deliberately withheld.',
  },

  /* KT02H20 is listed before KT0211L on purpose: both answer 0x31B2:0x0111,
     so a device with a blank product string must fall through to this one.
     Product-name matches (CDS…/0211…/TANGZU/WAN'ER) reach KT0211L
     regardless of ordering. */
  'KT02H20': {
    name: 'KT02H20', vid: 0x31B2, pid: 0x0111, confidence: 'verified',
    matchKeys: ['KT02H20', '02H20', 'JM12'],
    writeAck: WRITE_ACK,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    bandCount: 5, defaultFreqs: [60, 230, 910, 3600, 14000], defaultQ: 1.0,
    versionAddr: REG.VERSION, versionCount: 2,
    supportsAdcBank: true, supportsSave: true,
    reg: { ...HELIOS_REG },
    notes: 'Upstream-verified against real hardware. 5-band DAC bank @0x26 with enable @0x24, plus the Helios ADC-side (mic) bank @0x1A. Digital gain is 0.5 dB per step; the DRC registers at 0x71–0x79 were decoded from the vendor desktop app on this part.',
  },

  'KT0211L': {
    name: 'KT0211L', vid: 0x31B2, pid: 0x0111, confidence: 'verified',
    // 'FISSION' and 'DSP S' are here because the Tanchjim images carry those
    // product strings internally, and the June-2025 Fission image is
    // byte-identical to the 2024 DSP S one apart from 67 header bytes. The
    // name really is the only thing separating these two dongles.
    matchKeys: ['KT0211', '0211L', 'CDS', "WAN'ER", 'WANER', 'TANGZU', 'FISSION', 'DSP S'],
    writeAck: WRITE_ACK,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    bandCount: 5, defaultFreqs: [1000, 2000, 5000, 8000, 10000], defaultQ: 0.707,
    versionAddr: REG.VERSION, versionCount: 2,
    supportsAdcBank: true, supportsSave: true,
    reg: { ...HELIOS_REG },
    notes: 'Hardware-verified (full register dump, write ACK, flash save; 2026-09-21, reported as "CDS.KT USB Audio" / firmware CDSV100.003). Register-identical to KT02H20 for the EQ map. One quirk: the EQ-enable registers read 3 rather than 1, and the app preserves the unknown bits instead of forcing 0 or 1. Tangzu Wan\'er 2 DSP is owner-reported to be this same die class.',
  },

  'KT0210': {
    name: 'KT0210 (Bunny DSP)', vid: 0x31B2, pid: 0x1112, confidence: 'verified',
    // Deliberately keyed on 'BUNNY' alone. A bare 'TANCHJIM' key would
    // also swallow "TANCHJIM-FISSION  DSP" (a KT0211L) and
    // "TANCHJIM-DSP S" (also a KT0211L), because name matching runs
    // before the VID:PID fallback.
    matchKeys: ['BUNNY'],
    writeAck: WRITE_ACK,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    bandCount: 5, defaultFreqs: [1000, 2000, 5000, 8000, 10000], defaultQ: 0.707,
    versionAddr: REG.VERSION, versionCount: 2,
    supportsAdcBank: true, supportsSave: true,
    reg: { ...HELIOS_REG },
    notes: 'Tanchjim Bunny DSP, distinct PID 0x1112 so routing is unambiguous. Map taken from hardware probing of firmware v1.01 plus a Tanchjim app decompile. Community reports mention 8 bands on newer firmware — that layout is not reproduced here, and probing is the way to settle it.',
  },

  /* v10 Helios expansion. KT02F20 is image-confirmed: two vendor SDK
     builds carry the tag KT_Helios_v1b___KT02F20B with EQ tables at the
     same offsets as 02H20. The rest are roster entries with no run-mode
     dump yet, so they are name-matched only — vid/pid stay null and they
     can never hijack the VID:PID fallback. */
  'KT02F20': {
    name: 'KT02F20', vid: 0x31B2, pid: 0x0111, confidence: 'inferred',
    matchKeys: ['KT02F20', '02F20'],
    writeAck: WRITE_ACK,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    bandCount: 5, defaultFreqs: [1000, 2000, 5000, 8000, 10000], defaultQ: 0.707,
    versionAddr: REG.VERSION, versionCount: 2,
    supportsAdcBank: true, supportsSave: false,
    reg: { ...HELIOS_REG },
    notes: 'Image-confirmed Helios layout — two vendor SDK builds in firmware/ share byte offsets with 02H20. The write ACK is assumed from the family, not measured, and SAVE is withheld until someone confirms it on a real unit.',
  },
  'KT02F21': heliosRosterProfile('KT02F21', ['KT02F21', '02F21']),
  'KT02F22': heliosRosterProfile('KT02F22', ['KT02F22', '02F22']),
  'KT02H22': heliosRosterProfile('KT02H22', ['KT02H22', '02H22']),
  'KT0210S': heliosRosterProfile('KT0210S', ['KT0210S', '0210S']),
};

function heliosRosterProfile(name, matchKeys) {
  return {
    name, vid: null, pid: null, matchKeys, confidence: 'inferred',
    writeAck: WRITE_ACK,
    gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
    bandCount: 5, defaultFreqs: [1000, 2000, 5000, 8000, 10000], defaultQ: 0.707,
    versionAddr: REG.VERSION, versionCount: 2,
    supportsAdcBank: true, supportsSave: false,
    reg: { ...HELIOS_REG },
    notes: 'Named in the KT_BOOT_TOOL 1.0.58 chip roster as a Helios sibling. No run-mode dump exists, so this profile is name-matched only: pick it manually if your device reports this name. The app will not send SAVE or any unverified command to it.',
  };
}

const DEFAULT_PROFILE = {
  name: 'DEFAULT (Helios guess)', vid: null, pid: null, matchKeys: [], confidence: 'guess',
  writeAck: WRITE_ACK,
  gainRange: { min: -12, max: 12 }, qRange: { min: 0.1, max: 16 },
  bandCount: 5, defaultFreqs: [60, 230, 910, 3600, 14000], defaultQ: 1.0,
  versionAddr: REG.VERSION, versionCount: 2,
  supportsAdcBank: true, supportsSave: false,
  reg: { ...HELIOS_REG },
  notes: 'No product-string or VID:PID match. This is a best-effort Helios guess, so treat every write as experimental and read back to confirm. The chip prober on the Device tab can usually name the real part.',
};

/** The complete vendor roster, for the reference table on the Device tab. */
const ROSTER = [
  { name: 'KT0231H',  state: 'verified', note: '6-band, 0x1132, hardware-verified 2026-09-21' },
  { name: 'KT0211L',  state: 'verified', note: 'Tanchjim DSP S, Fission · 0x0111' },
  { name: 'KT02H20',  state: 'verified', note: 'FiiO JA11, JCALLY JM12, Moondrop KT02, TINHIFI' },
  { name: 'KT0210',   state: 'verified', note: 'Tanchjim Bunny DSP · 0x1112' },
  { name: 'KT02F20',  state: 'expected', note: 'image-confirmed Helios layout, unverified on hardware' },
  { name: 'KT02F21',  state: 'expected', note: 'roster only — probe and report' },
  { name: 'KT02F22',  state: 'expected', note: 'roster only — probe and report' },
  { name: 'KT02H22',  state: 'expected', note: 'roster only — probe and report' },
  { name: 'KT0210S',  state: 'expected', note: 'roster only — probe and report' },
  { name: 'KT0211',   state: 'doc',      note: 'base part, presumably the 0211L die at another SKU' },
  { name: 'KT02H2',   state: 'doc',      note: 'roster family prefix' },
  { name: 'KT02F2',   state: 'doc',      note: 'roster family prefix' },
  { name: 'KT0200',   state: 'doc',      note: 'MSV2B platform — no run-mode map (ARCHITECTURE.md §4)' },
  { name: 'KT0201',   state: 'doc',      note: 'MSV2B platform — no run-mode map' },
  { name: 'KT0203N',  state: 'doc',      note: 'MSV2B platform — no run-mode map' },
  { name: 'KT0206',   state: 'doc',      note: 'MSV2B boot loader — KT0206_boot_v1.05 in firmware/' },
  { name: 'KT0712',   state: 'doc',      note: 'TT V3 platform — USB→I²S bridge family' },
  { name: 'KT1200',   state: 'doc',      note: 'roster only, platform unknown' },
];

/** Parts the vendor catalogue knows about, merged with the curated roster.
 *  A chip can be named without being profiled: identification and capability
 *  are separate questions, and answering the first while admitting the second
 *  is unknown is far more useful than reporting an unknown device. */
function catalogueEntry(name) {
  return CHIP_CATALOG[String(name || '').toUpperCase()] || null;
}

/** Everything we can say about a product string, with what is still unknown
 *  kept explicitly unknown. Returns { chip, cls, profile, exact }. */
function identify(productName = '', vendorId = null, productId = null, chipId = '') {
  const uname = (productName || '').toUpperCase();
  const profile = resolveProfile(productName, vendorId, productId, chipId);
  const alias = fromVidPid(vendorId, productId);
  // A chip-ID hit outranks a name hit: the ID came out of the device.
  const byId = chipFromId(chipId);
  const hit = chipFromProduct(uname);
  // A VID:PID alias that names a specific part is real evidence too — the FiiO
  // JA11 is the case in point: its product string contains no chip name, so
  // without this the profile would resolve correctly while the chip readout
  // claimed "no catalogue match" for the same device.
  const chip = byId?.name ?? hit?.name ?? alias?.chip ?? null;
  const entry = chip ? CHIP_CATALOG[chip] : null;
  return {
    chip,
    cls: entry?.cls ?? null,
    products: entry?.products ?? 0,
    inUsbClass: chip ? CHIP_USB_CLASS.includes(chip) : false,
    profile,
    // Which piece of evidence actually decided this, so the UI can show the
    // user why it believes what it believes instead of asking for trust.
    evidence: byId ? `chip ID "${byId.evidence}"`
      : hit ? 'product string'
      : alias?.chip ? `${vidKey(vendorId, productId)}`
      : alias ? `${vidKey(vendorId, productId)} (platform only)`
      : null,
    // "exact" means the profile came from real evidence rather than the
    // catch-all default, so the UI can be honest about confidence.
    exact: profile !== DEFAULT_PROFILE,
    profileIsDefault: profile === DEFAULT_PROFILE,
    platform: alias?.platform ?? null,
  };
}

/* A catalogue part outside the USB-audio class. Zero bands and no writable
   register: the app must refuse to guess a layout for a part it cannot even
   reach, and bandCount 0 is what makes every control disable itself rather
   than offering sliders that would write to addresses that mean nothing here. */
const INCOMPATIBLE = new Map();
function INCOMPATIBLE_PROFILE(cat) {
  if (INCOMPATIBLE.has(cat.name)) return INCOMPATIBLE.get(cat.name);
  const p = {
    name: `${cat.name} (not USB audio)`,
    vid: null, pid: null,
    matchKeys: [cat.name],
    incompatible: true,
    chip: cat.name,
    writeAck: WRITE_ACK,
    gainRange: { min: 0, max: 0 }, qRange: { min: 0, max: 0 },
    bandCount: 0, defaultFreqs: [], defaultQ: 1,
    versionAddr: 0, versionCount: 0,
    supportsAdcBank: false, supportsSave: false,
    reg: {},
    notes: `${cat.name} is in the vendor catalogue as ${cat.cls} (${cat.products} product${cat.products === 1 ? '' : 's'}), not USB audio. This app talks to the KTMicro USB-audio dongles over HID, so there is no register map to offer and nothing is written.`,
  };
  INCOMPATIBLE.set(cat.name, p);
  return p;
}

/* ══════════ § 1b  IDENTITY ALIASES ══════════
   Sourced from the vendor's own product catalogue and the reverse-engineering
   notes in the resource pack. The single most important fact here: 31B2:0111
   is shared by THREE different chips — KT0211L, KT02H20 and KT02F20 all ship
   on it. So a VID:PID is a *platform class* hint and can never be a chip
   identity; treating it as one is how a Tanchjim gets configured as a FiiO.

   What is reliable, in descending order:
     1. the chip-ID string the prober reads out of the device
     2. the USB product string
     3. VID:PID, which only narrows the platform
   The lookup below follows that order. */
const CHIP_ID_ALIASES = new Map(Object.entries({
  '0211LC02': 'KT0211L',
  'KT02H20B': 'KT02H20',
  '02F20B':   'KT02F20',
  'TURN2CDC': 'KT0210',
  'KT0712A':  'KT0712',
  '020xB04':  'KT020x',
}));

/* FiiO ships the JA11 under its own vendor ID rather than KTMicro's, so a
   real JA11 never presents 31B2:0111. Without this row it falls through to
   the catch-all guess despite being one of the best-documented parts here. */
const VID_ALIASES = new Map(Object.entries({
  '0x2972:0x0102': { chip: 'KT02H20', platform: 'helios', note: 'FiiO JadeAudio JA11' },
  '0x31b2:0x0111': { chip: null,       platform: 'helios', note: 'KT0211L / KT02H20 / KT02F20 share this' },
  '0x31b2:0x1132': { chip: 'KT0231H',  platform: 'helios6', note: 'Moondrop-style dongles' },
  '0x31b2:0x1112': { chip: 'KT0210',   platform: 'helios',  note: 'Tanchjim Bunny DSP' },
  '0x31b2:0x0101': { chip: null,       platform: 'boot',    note: 'Helios-class bootloader' },
  '0x31b2:0x0001': { chip: null,       platform: 'boot',    note: 'MSV2B / Helios bootloader' },
}));

/* Zero-padded to 4 hex digits on both halves. Without the padding, PID 0x0102
   stringifies as "102" and misses a key written "0x0102", which silently
   disables the whole alias table while every lookup still looks correct. */
const vidKey = (v, p) =>
  '0x' + Number(v).toString(16).padStart(4, '0') + ':0x' + Number(p).toString(16).padStart(4, '0');

/** Resolve a chip from a prober-read chip-ID string. */
function chipFromId(id) {
  if (!id) return null;
  const clean = String(id).trim();
  const hit = CHIP_ID_ALIASES.get(clean.toUpperCase());
  return hit ? { name: hit, source: 'chip id', evidence: clean } : null;
}

/** Resolve what a VID:PID can tell us — a platform, and sometimes a chip. */
function fromVidPid(vendorId, productId) {
  if (vendorId == null || productId == null) return null;
  const a = VID_ALIASES.get(vidKey(vendorId, productId));
  return a ? { ...a, source: 'VID:PID' } : null;
}

function resolveProfile(productName = '', vendorId = null, productId = null, chipId = '') {
  /* 1) Chip ID first, ahead of everything else. It is the only source that is
     unambiguous: 31B2:0111 is shared by KT0211L, KT02H20 and KT02F20, and a
     product string can be renamed, blank, or simply wrong. A product name that
     disagrees with the chip ID loses, because the chip ID came out of the
     device. */
  const byId = chipFromId(chipId);
  if (byId && PROFILES[byId.name]) return PROFILES[byId.name];
  // 2) Product name. KT0211L and KT02H20 share a VID:PID, so the name is the
  //    only way to tell those two apart when no chip ID is available.
  const uname = (productName || '').toUpperCase();
  for (const p of Object.values(PROFILES)) {
    if (p.matchKeys.some(k => uname.includes(k.toUpperCase()))) return p;
  }
  // 3) VID:PID against a profile, which catches renamed or blank product
  //    strings. Skipped when the alias is known to be ambiguous.
  const alias = fromVidPid(vendorId, productId);
  if (alias?.chip && PROFILES[alias.chip]) return PROFILES[alias.chip];
  for (const p of Object.values(PROFILES)) {
    if (p.vid !== null && p.vid === vendorId && p.pid === productId) return p;
  }
  // 4) A catalogue part that is not in the USB-audio class cannot be reached
  //    over this transport at all. Saying so is better than handing back a
  //    Helios layout and letting the user write to registers that do not
  //    exist on, say, a Bluetooth or codec part.
  const cat = chipFromProduct(uname) ?? (byId && CHIP_CATALOG[byId.name] ? { name: byId.name, ...CHIP_CATALOG[byId.name] } : null);
  if (cat && !CHIP_USB_CLASS.includes(cat.name)) return INCOMPATIBLE_PROFILE(cat);
  return DEFAULT_PROFILE;
}

/* ══════════ § 3  COMMAND QUEUE ══════════
   Strictly serial with a configurable gap — vendor firmware serialises
   HID reports, and firing faster is how a session ends up wedged. Items
   sharing a key collapse: while a slider is moving, only the newest send
   for that register survives, and every superseded caller still resolves. */
class CommandQueue {
  #q = [];
  #busy = false;
  #gap = 100;
  #onSize = null;
  #paused = false;

  constructor(gapMs = 100) { this.#gap = gapMs; }
  get size() { return this.#q.length + (this.#busy ? 1 : 0); }
  get gap() { return this.#gap; }
  get paused() { return this.#paused; }
  onSizeChange(fn) { this.#onSize = fn; }
  setGap(ms) { this.#gap = Math.max(0, Number(ms) || 0); }

  add(task, key = null) {
    return new Promise((res, rej) => {
      if (key !== null) {
        const i = this.#q.findIndex(t => t.key === key);
        if (i !== -1) {
          const old = this.#q[i];
          const waiters = old.superseded ? [...old.superseded, old.res] : [old.res];
          this.#q[i] = {
            key,
            res, rej, superseded: waiters,
            task: async () => {
              const r = await task();
              waiters.forEach(fn => fn(r));
              return r;
            },
          };
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
      if (this.#paused) break;
      const { task, res, rej, superseded = [] } = this.#q.shift();
      this.#notify();
      try {
        const r = await task();
        superseded.forEach(fn => fn(r));
        res(r);
      } catch (e) { rej(e); }
      if (this.#q.length) await sleep(this.#gap);
    }
    this.#busy = false;
    this.#notify();
  }

  resume() { if (this.#paused) { this.#paused = false; this.#drain(); } }
  pause() { this.#paused = true; }

  #notify() { this.#onSize?.(this.size); }

  clear(reason = 'Queue cleared') {
    this.#q.forEach(({ rej }) => rej(new Error(reason)));
    this.#q = [];
    this.#notify();
  }
}

/* ══════════ § 4  HID CONTROLLER ══════════ */
class HIDController {
  #dev = null;
  #profile = DEFAULT_PROFILE;
  #queue = new CommandQueue(Settings.data.queueGap);
  #onDisc = null;
  #timeoutMs = 2000;
  #outstanding = 0;

  constructor() { this.#queue.onSizeChange(n => App.updateQueueBadge(n)); }

  get connected() { return this.#dev?.opened ?? false; }
  get profile() { return this.#profile; }
  set profile(p) { this.#profile = p ?? DEFAULT_PROFILE; }
  get productName() { return this.#dev?.productName ?? ''; }
  get vendorId() { return this.#dev?.vendorId ?? null; }
  get productId() { return this.#dev?.productId ?? null; }
  /* Set by the chip prober from the device's own identity registers, which
     know more than the USB descriptor. Cleared on every new connection so a
     previous device's verdict can never leak onto the next one. */
  chipId = '';
  get device() { return this.#dev; }
  get queue() { return this.#queue; }
  setTimeout(ms) { this.#timeoutMs = Math.max(250, Number(ms) || 2000); }

  /** Active register address: profile override wins, else the default. */
  reg(name) { return this.#profile?.reg?.[name] ?? REG[name]; }

  /** Devices the browser has already been granted, for one-click reconnect. */
  static async granted() {
    if (!navigator.hid) return [];
    try { return await navigator.hid.getDevices(); }
    catch (err) { dbg(`getDevices() failed: ${err.name}`); return []; }
  }

  async connect(onDisconnect) {
    if (!navigator.hid) throw new Error('WebHID is not available in this browser.');

    dbg('connect() — requestDevice({filters: []})');
    let list;
    try {
      list = await navigator.hid.requestDevice({ filters: [] });
    } catch (err) {
      dbg(`requestDevice threw ${err.name}: ${err.message}`);
      throw err;
    }
    if (!list.length) throw new Error('No device selected.');

    list.forEach((d, i) => {
      dbg(`  [${i}] "${d.productName || '(unnamed)'}" ${hex(d.vendorId)}:${hex(d.productId)} opened=${d.opened}`);
      d.collections?.forEach((c, ci) => {
        const ids = r => (r || []).map(x => x.reportId).join(',') || '—';
        dbg(`      coll[${ci}] up=${hex(c.usagePage)} use=${hex(c.usage)} in=[${ids(c.inputReports)}] out=[${ids(c.outputReports)}] feat=[${ids(c.featureReports)}]`);
      });
    });

    // Prefer a collection that actually has input AND output reports — a
    // vendor-interface-only device answers nothing useful otherwise.
    let dev = list[0];
    for (const d of list) {
      if (d.collections?.some(c => c.inputReports?.length && c.outputReports?.length)) { dev = d; break; }
    }

    if (!dev.opened) {
      try { await dev.open(); dbg('device.open() ok'); }
      catch (err) {
        dbg(`device.open() threw ${err.name}: ${err.message}`);
        if (err.name === 'NotAllowedError') {
          throw new Error('Permission denied. On Linux add a udev rule for VID 31b2 (see README) and reload the page.');
        }
        throw err;
      }
    }

    this.#dev = dev;
    this.chipId = '';
    this.#profile = resolveProfile(dev.productName, dev.vendorId, dev.productId, this.chipId);
    const p = this.#profile;
    dbg(`profile ${p.name} reportId=${RPT_ID} bands=${p.bandCount} EQ_DAC=${hex(this.reg('EQ_DAC'))} ack=${hex(p.writeAck)}`);
    App.onProfileResolved(p);
    /* The prober reads the device's own identity registers, which identify the
       part better than the USB descriptor. Run it on connect so the chip panel
       is right from the first frame rather than only after a button press. */
    if (!p.incompatible) {
      Identity.refresh()
        .then(() => log(`Probed on connect: ${Identity.last.chip ?? 'no catalogue match'} (probe says ${Identity.last.guess ?? 'unresolved'}).`))
        .catch(err => dbg('connect probe: ' + err.message));
    }

    clearHistory();

    this.#onDisc = onDisconnect;
    navigator.hid.addEventListener('disconnect', this.#discHandler);

    return dev.productName || 'unnamed device';
  }

  #discHandler = e => {
    if (e.device === this.#dev) {
      this.#dev = null;
      this.#queue.clear('Device disconnected');
      this.#onDisc?.();
    }
  };

  async disconnect() {
    navigator.hid.removeEventListener('disconnect', this.#discHandler);
    this.#queue.clear();
    clearHistory();
    if (this.#dev?.opened) await this.#dev.close();
    this.#dev = null;
    this.#profile = DEFAULT_PROFILE;
  }

  send(data, key = null) { return this.#queue.add(() => this.#rawSend(data), key); }

  #rawSend(data) {
    if (!this.connected) throw new Error('Device not connected.');
    const rid = this.#profile.reportId ?? RPT_ID;
    this.#outstanding++;
    let done = false;

    return new Promise((res, rej) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#dev?.removeEventListener('inputreport', h);
        this.#outstanding--;
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        dbg(`TIMEOUT ${this.#timeoutMs} ms (reportId=${rid}, ${data.length} B)`);
        res(new Uint8Array(0));
      }, this.#timeoutMs);

      const h = e => {
        if (done || e.reportId !== rid) return;
        done = true;
        cleanup();
        res(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
      };

      this.#dev.addEventListener('inputreport', h);
      dbg(`sendReport(${rid}, ${data.length} B) [${fmt(data)}]`);
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

/* ══════════ § 5  LIVE STATE ══════════ */
const state = {
  bank: 'DAC',
  banks: null,                       // { DAC: [band], ADC?: [band] }
  get bands() { return this.banks[this.bank]; },
  eqEnabled: { DAC: true, ADC: true },
  globalGain: 0,                     // DIG_DAC left, dB
  globalGainR: 0,                    // DIG_DAC right, dB (stereo only)
  pgaADC: 0,
  pgaDAC: 0,
  digADC: 0,
  /** Per-band local flags. `muted` bands are excluded from the curve and
      from writes; `solo` dims the rest. Neither touches the device. */
  flags: {},                         // index -> { muted, solo }
  ghost: null,                       // curve captured from the device
  target: null,                      // AutoEQ target curve
};

function makeBand(freq, index, q) {
  return { index, freq, gain: 0, q, filterType: 0 };
}
function profileBands() {
  const p = hid.profile;
  /* ?? not ||: an incompatible profile carries bandCount 0 on purpose, and ||
     would treat that 0 as "absent" and hand it five bands — which is precisely
     the wrong answer for a part we cannot reach. */
  const n = p.bandCount ?? p.reg?.EQ_BANDS ?? 5;
  return Array.from({ length: n }, (_, i) => makeBand(p.defaultFreqs[i] ?? 1000, i, p.defaultQ ?? 1));
}
function makeBanks() {
  const banks = { DAC: profileBands() };
  if (hid.profile.supportsAdcBank) banks.ADC = profileBands();
  return banks;
}
function rebuildFlags() {
  const f = {};
  for (const b of state.bands) f[b.index] = f[b.index] || { muted: false, solo: false };
  state.flags = f;
}
function bandFlag(i) { return (state.flags[i] ||= { muted: false, solo: false }); }
function anySolo() { return Object.values(state.flags).some(f => f.solo); }
function activeBands() { return state.bands.filter(b => !bandFlag(b.index).muted); }

function switchBank(bank) {
  if (!state.banks[bank] || state.bank === bank) return;
  state.bank = bank;
  rebuildFlags();
  App.buildBands();
  App.refreshAllBands();
  Graph.setBands(state.bands);
  App.updateEqToggles();
  App.updateBankToggle();
  log(`Switched to the ${bank} bank (base ${hex(eqBase())}).`);
}

function eqBase(bank = state.bank) {
  if (bank === 'ADC') { const a = hid.reg('EQ_ADC'); if (a != null) return a; }
  return hid.reg('EQ_DAC');
}
function eqEnableAddr(bank = state.bank) {
  if (bank === 'ADC') { const a = hid.reg('EQ_ADC_EN'); if (a != null) return a; }
  return hid.reg('EQ_DAC_EN');
}
function hasAdcBank() { return !!hid.profile.supportsAdcBank && hid.reg('EQ_ADC') != null; }

/* ══════════ § 6  REGISTER PRIMITIVES ══════════ */
async function readRegister(addr) {
  const cmd = new Uint8Array([
    addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF,
    CMD_READ, 0, 0, 0, 0, 0,
  ]);
  logTx(cmd);
  const resp = await hid.send(cmd, `rd-${addr}`);
  logRx(resp);
  if (resp.length >= 10 && resp[4] === CMD_READ) {
    return (resp[6] | (resp[7] << 8) | (resp[8] << 16) | (resp[9] << 24)) >>> 0;
  }
  throw new Error(`read 0x${addr.toString(16).padStart(2, '0')} failed`);
}

async function writeRegister(addr, value) {
  const cmd = new Uint8Array([
    addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF,
    CMD_WRITE, 0x00,
    value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >> 24) & 0xFF,
  ]);
  logTx(cmd);
  const resp = await hid.send(cmd, `wr-${addr}`);
  logRx(resp);
  const want = hid.profile.writeAck ?? WRITE_ACK;
  const got = resp.length >= 10 ? resp[6] : null;
  if (resp.length >= 10 && resp[4] === CMD_WRITE && got === want) return got;
  throw new Error(`write 0x${addr.toString(16).padStart(2, '0')} failed (ACK ${got == null ? 'none' : hex(got, 2)}, expected ${hex(want, 2)})`);
}

/* Vendor SAVE — recovered from KT_USB_APP 1.0.17 (function @0x546900):
   report 0x4B, payload [addr=0][0x53][0x00][value=0]. The firmware accepts
   0x03 (KT02H20 era) or 0x4F (newer) as success. Commits EQ + gains to
   flash; the unit usually reboots, so reconnect and read back afterwards. */
async function saveToFlash() {
  const cmd = new Uint8Array([0, 0, 0, 0, CMD_SAVE, 0x00, 0, 0, 0, 0]);
  logTx(cmd);
  const resp = await hid.send(cmd, 'save');
  logRx(resp);
  const st = resp.length >= 10 ? resp[6] : -1;
  if (st === 0x03 || st === 0x4F) return st;
  throw new Error(`SAVE rejected (status ${st < 0 ? 'none' : hex(st, 2)})`);
}

/* Extended-space word peek — READ-ONLY, cannot alter device state. The word
   comes back at payload[0..3], unlike register reads which use [6..9]. Most
   runtimes answer zeros because nothing is mapped there. Not a flash read. */
async function memRead32(addr) {
  const cmd = new Uint8Array([
    addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF,
    CMD_MEMRD, 0, 0, 0, 0, 0,
  ]);
  logTx(cmd);
  const resp = await hid.send(cmd, `mem-${addr.toString(16)}`);
  logRx(resp);
  if (resp.length >= 10) {
    return (resp[0] | (resp[1] << 8) | (resp[2] << 16) | (resp[3] << 24)) >>> 0;
  }
  throw new Error(`peek 0x${addr.toString(16).padStart(2, '0')} failed`);
}

/* ══════════ § 7  BAND / GAIN ENCODING ══════════
   A-reg = [freq Hz:16][gain ×10 :16 signed]   B-reg = [type:3][Q ×1000:16] */
function encodeBand(freq, gain, q, filterType) {
  const g10 = Math.round(clamp(gain, -3276.8, 3276.7) * 10) & 0xFFFF;
  const qv = Math.round(clamp(q, 0, 65.535) * 1000) & 0xFFFF;
  return {
    aReg: ((((freq & 0xFFFF) << 16) | g10) >>> 0),
    bReg: ((((filterType & 0x7) << 16) | qv) >>> 0),
  };
}
function decodeBand(aReg, bReg) {
  let gRaw = aReg & 0xFFFF;
  if (gRaw >= 0x8000) gRaw -= 0x10000;
  return {
    freq: (aReg >>> 16) & 0xFFFF,
    gain: gRaw / 10,
    q: (bReg & 0xFFFF) / 1000,
    filterType: (bReg >>> 16) & 0x7,
  };
}
const encodeDigGain = db => Math.round(clamp(db, -64, 127.5) * 2) & 0xFF;
const decodeDigGain = b  => (b >= 0x80 ? b - 0x100 : b) / 2;

/** Sum of a band's magnitude response at f, in dB. */
function bandResponse(f, band) {
  const { gain, freq: fc, q, filterType } = band;
  if (!gain || !fc) return 0;
  const r = f / fc, lg = Math.log2(r);
  switch (filterType) {
    case 0: { const bw = 1 / Math.max(q, 0.05); return gain * Math.exp(-(lg * lg) / (2 * bw * bw)); }
    case 1: return gain / (1 + r * r);
    case 2: return gain / (1 + 1 / (r * r));
    case 3: return gain / (1 + r ** 4);
    case 4: return gain / (1 + 1 / r ** 4);
    default: return 0;
  }
}
function curveAt(f, bands) {
  let s = 0;
  for (const b of bands) s += bandResponse(f, b);
  return s;
}

/* ══════════ § 7b  HEADROOM / CLIPPING ANALYSIS ══════════
   Boosting EQ bands raises the signal level. If the summed response of the
   active bands pushes a 0 dBFS input past full scale, the DAC clips — which
   sounds like harsh intermodulation, not "louder", and the user cannot hear
   the cause while hearing the effect. The KT02H20 vendor tool documents the
   same hazard and the same remedy (a global preamp sized to the largest
   boost), so the guard belongs here rather than in a manual.

   The peak is found by a coarse logarithmic sweep and then a refinement pass,
   because a narrow high-Q band can peak *between* two coarse samples. A grid
   scan alone under-reports exactly the case that matters most — a +12 dB bell
   at Q=10 reads as "fine" if you sample either side of it — which would make
   the guard worse than none. */
const HEADROOM_DEFAULT = {
  fMin: 20,
  fMax: 20000,
  stepsPerOctave: 48,   // coarse sweep density
  refineSteps: 40,      // golden-section iterations inside the winning cell
  marginDb: 0.5,        // headroom kept in hand for host volume + DAC filtering
};

/** Largest summed response over the audible band, in dB, and where it sits. */
function peakBoost(bands, opt = {}) {
  const { fMin, fMax, stepsPerOctave, refineSteps } = { ...HEADROOM_DEFAULT, ...opt };
  const live = bands.filter(b => b && b.gain && b.freq);
  if (!live.length) return { db: 0, hz: 0, band: null };

  const octaves = Math.log2(fMax / fMin);
  const steps = Math.max(8, Math.round(octaves * stepsPerOctave));
  const ratio = Math.pow(fMax / fMin, 1 / steps);

  let bestHz = fMin, bestDb = -Infinity;
  let f = fMin;
  for (let i = 0; i <= steps; i++) {
    const db = curveAt(f, live);
    if (db > bestDb) { bestDb = db; bestHz = f; }
    f *= ratio;
  }

  // Refine inside the cell either side of the best coarse sample. Search in
  // log-frequency because that is the axis the sweep is uniform in.
  if (bestDb > -Infinity) {
    const lo = bestHz / ratio, hi = bestHz * ratio;
    const gr = (Math.sqrt(5) - 1) / 2;
    let a = lo, b = hi;
    let c = b - gr * (b - a), d = a + gr * (b - a);
    for (let i = 0; i < refineSteps; i++) {
      if (curveAt(c, live) > curveAt(d, live)) b = d; else a = c;
      c = b - gr * (b - a); d = a + gr * (b - a);
    }
    const fRef = (a + b) / 2;
    const dbRef = curveAt(fRef, live);
    if (dbRef > bestDb) { bestDb = dbRef; bestHz = fRef; }
  }

  // Attribute the peak to the band contributing most there, so the UI can name
  // a culprit instead of just reporting a number.
  let band = null, worst = 0;
  for (const b of live) {
    const c = bandResponse(bestHz, b);
    if (c > worst) { worst = c; band = b; }
  }
  return { db: bestDb, hz: bestHz, band };
}

/** Preamp trim that brings the peak back under 0 dBFS with margin in hand. */
function suggestedTrim(bands, opt = {}) {
  const { marginDb = HEADROOM_DEFAULT.marginDb } = { ...HEADROOM_DEFAULT, ...opt };
  const { db } = peakBoost(bands, opt);
  return db <= 0 ? 0 : -(db + marginDb);
}

/* ══════════ § 8  DEVICE FETCH ══════════ */
async function readString(addr, count) {
  const chars = [];
  for (let i = 0; i < count; i++) {
    const v = await readRegister(addr + i);
    for (const b of [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]) {
      if (b >= 32 && b < 127) chars.push(b);
    }
  }
  return String.fromCharCode(...chars).replace(/\0/g, '').trim();
}

async function fetchEqSwitch(bank = state.bank) {
  const addr = eqEnableAddr(bank);
  const val = await readRegister(addr);
  state.eqEnabled[bank] = (val & 1) !== 0;
  log(`${bank} EQ ${state.eqEnabled[bank] ? 'ON' : 'OFF'} (${hex(addr)} raw 0x${val.toString(16)})`);
}

async function fetchBank(bank) {
  const base = eqBase(bank);
  const stride = hid.reg('EQ_STRIDE');
  const bands = state.banks[bank];
  for (let i = 0; i < bands.length; i++) {
    const a = await readRegister(base + i * stride);
    const b = await readRegister(base + i * stride + 1);
    Object.assign(bands[i], decodeBand(a, b), { index: i });
  }
  await fetchEqSwitch(bank);
}

async function fetchAllBanks() {
  for (const bank of Object.keys(state.banks)) await fetchBank(bank);
}

async function fetchGains() {
  state.globalGain   = decodeDigGain((await readRegister(hid.reg('DIG_DAC'))) & 0xFF);
  const rawLr = await readRegister(hid.reg('DIG_DAC'));
  state.globalGainR = decodeDigGain((rawLr >>> 8) & 0xFF);
  state.pgaADC = (await readRegister(hid.reg('PGA_ADC'))) & 0xFF;
  state.pgaDAC = (await readRegister(hid.reg('PGA_DAC'))) & 0xFF;
  state.digADC = decodeDigGain((await readRegister(hid.reg('DIG_ADC'))) & 0xFF);
  log(`Gains: DAC ${sgn(state.globalGain)}/${sgn(state.globalGainR)} dB · `
    + `A_ADC ${PGA_ADC_GAINS[state.pgaADC] ?? state.pgaADC} · `
    + `A_DAC ${PGA_DAC_GAINS[state.pgaDAC] ?? state.pgaDAC} · ADC ${sgn(state.digADC)} dB`);
}

/* ══════════ § 9  HISTORY ══════════
   Snapshot-based rather than per-field, so undo covers band edits, preset
   loads, imports, resets and profile switches uniformly. */
const History = {
  past: [], future: [], LIMIT: 60,
  push(label) {
    this.past.push({ label, data: cloneBanks(state.banks) });
    if (this.past.length > this.LIMIT) this.past.shift();
    this.future.length = 0;
    App.updateHistoryButtons();
  },
  canUndo() { return this.past.length > 0; },
  canRedo() { return this.future.length > 0; },
  undo() { return this._step('past', 'future'); },
  redo() { return this._step('future', 'past'); },
  /** Move one step: take an entry off `from`, park the current state on `to`. */
  _step(from, to) {
    if (!this[from].length) return null;
    const entry = this[from].pop();
    this[to].push({ label: entry.label, data: cloneBanks(state.banks) });
    state.banks = cloneBanks(entry.data);
    rebuildFlags();
    App.buildBands();
    App.refreshAllBands();
    App.updateBankToggle();
    App.updateEqToggles();
    Graph.setBands(state.banks[state.bank]);
    App.updateHistoryButtons();
    return entry.label;
  },
  clear() { this.past.length = 0; this.future.length = 0; App.updateHistoryButtons(); },
};
const cloneBanks = b => JSON.parse(JSON.stringify(b));
function clearHistory() { History.clear(); }
