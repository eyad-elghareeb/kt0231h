/* Regenerates js/chips.js from the resource pack's product-page manifest.
 *
 * Why this is generated rather than hand-written: the pack lists 125 product
 * pages covering 105 distinct parts. Curating that by hand is how a table
 * silently goes stale, and a stale chip table produces exactly the wrong thing
 * — a confident wrong answer about what a connected device is.
 *
 * What the pack does and does not give us. The chip name, the product section,
 * the page URL and the product count all survive extraction intact. The
 * Chinese prose does NOT — it was flattened to literal '?' during extraction,
 * including inside meta tags, so no per-chip capability data (band count, gain
 * range, register map) is recoverable. This file therefore records identity and
 * class only. Anything that implies a register layout would be a guess, and
 * this project does not ship guesses about hardware.
 *
 *   node tools/build-chip-roster.mjs [pathToPack]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = process.argv[2]
  ?? 'D:/Downloads/KTMicro_Audio_DSP_Complete_Pack_2026-09-26/KTMicro_Resource_Pack';
const manifest = join(pack, '01_Official_Product_Pages', '_manifest.json');

const rows = JSON.parse(readFileSync(manifest, 'utf8'));

/* Section codes are pinyin abbreviations. Some are self-evident from the code
   itself; the rest are kept verbatim rather than guessed at, because a wrong
   class label is worse than an opaque one. */
const CLASS_OF = {
  usb: 'USB audio',
  dac: 'DAC',
  adc: 'ADC',
  dsp: 'DSP',
  codec: 'Codec',
  'afe-soc': 'AFE / SoC',
};

const byChip = new Map();
for (const r of rows) {
  const chip = String(r.name || '').trim();
  if (!chip) continue;
  if (!byChip.has(chip)) byChip.set(chip, { sections: new Set(), products: 0, url: null });
  const e = byChip.get(chip);
  e.products++;
  if (r.section) e.sections.add(r.section);
  if (!e.url && r.url) e.url = r.url;
}

function classify(sections) {
  const codes = [...sections].map(s => s.replace(/[_-]?\d+$/, ''));
  const known = [...new Set(codes.map(c => CLASS_OF[c]).filter(Boolean))];
  // usb_73 and usb_104 are both the USB-dongle catalogue; a part listed in both
  // is a dongle part, not two different things.
  if (known.length === 1) return known[0];
  if (known.includes('USB audio')) return 'USB audio';
  const raw = [...new Set(sections)].sort();
  if (known.length) return known.join(' + ');
  // The pinyin codes we cannot read are kept verbatim and marked, rather than
  // given an invented name. A confident wrong label is worse than an opaque
  // one you can look up — the code is exactly what appears in the vendor URL.
  return 'unclassified (' + raw.join(', ') + ')';
}

const chips = [...byChip.entries()]
  .map(([name, e]) => ({
    name,
    cls: classify(e.sections),
    n: e.products,
    sections: [...e.sections].sort(),
    url: e.url,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const usb = chips.filter(c => c.cls.includes('USB audio'));

const out = `/* GENERATED FILE — do not edit by hand.
   Source: KTMicro_Resource_Pack/01_Official_Product_Pages/_manifest.json
   Regenerate: node tools/build-chip-roster.mjs
   ${chips.length} parts across ${rows.length} product pages, of which ${usb.length} are in the
   USB-audio class this app targets.

   Identity and product class only. The pack's per-chip capability text was
   destroyed by its own extraction step, so nothing here claims a register map,
   band count, or gain range — see device.js PROFILES for the parts whose
   layout is actually verified. */

/** Every part in the vendor catalogue, keyed by name. */
const CHIP_CATALOG = {
${chips.map(c => `  ${JSON.stringify(c.name)}: { cls: ${JSON.stringify(c.cls)}, products: ${c.n}, sections: ${JSON.stringify(c.sections)} },`).join('\n')}
};

/** Parts in the USB-audio class, which is what this app can talk to. */
const CHIP_USB_CLASS = ${JSON.stringify(usb.map(c => c.name))};

/** Product-class totals, for the Device tab's coverage summary. */
const CHIP_CLASS_TOTALS = ${JSON.stringify(
  Object.entries(chips.reduce((m, c) => ((m[c.cls] = (m[c.cls] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1])
)};

/** Longest-first name list, so 'KT02F21' is matched before 'KT02F2'. */
const CHIP_NAMES_BY_LENGTH = ${JSON.stringify(chips.map(c => c.name).sort((a, b) => b.length - a.length))};

/** Look up a catalogue entry by any substring of a product string. */
function chipFromProduct(text) {
  if (!text) return null;
  const up = String(text).toUpperCase();
  for (const name of CHIP_NAMES_BY_LENGTH) {
    if (up.includes(name)) return { name, ...CHIP_CATALOG[name] };
  }
  return null;
}
`;

writeFileSync(join(root, 'js', 'chips.js'), out);
console.log(`wrote js/chips.js — ${chips.length} chips, ${usb.length} in the USB-audio class`);
const totals = chips.reduce((m, c) => ((m[c.cls] = (m[c.cls] || 0) + 1), m), {});
for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
