// WCAG contrast audit for the token palette.
//
//   node contrast.mjs
//
// Every text/background pair the UI actually renders is listed here. If a
// token is retuned, this must stay green. Values are read straight out of
// tokens.css so the audit cannot drift from the stylesheet.

import { readFileSync } from 'node:fs';

const css = readFileSync('css/tokens.css', 'utf8');

/* ── colour maths (WCAG 2.1 relative luminance) ──────────────────────── */
function parse(c) {
  c = c.trim();
  if (c === 'transparent') return [0, 0, 0, 0];
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = [...h].map(x => x + x).join('');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).concat(1);
  }
  let m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [(p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255, p[3] === undefined ? 1 : p[3]];
  }
  throw new Error('unparsed colour: ' + c);
}
const lin = u => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
function lum([r, g, b]) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function over(fg, bg) {           // composite a translucent colour onto an opaque one
  const a = fg[3];
  return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)).concat(1);
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/* ── token reader ────────────────────────────────────────────────────── */
function block(selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error('no block for ' + selector);
  const start = css.indexOf('{', i);
  let depth = 0, j = start;
  for (; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) break;
  }
  const out = {};
  for (const m of css.slice(start, j).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const THEMES = {
  graphite: block('[data-theme="graphite"]'),
  oled: block('[data-theme="oled"]'),
  light: block('[data-theme="light"]'),
  contrast: block('[data-theme="contrast"]'),
};
const ACCENTS = Object.fromEntries(
  [...css.matchAll(/\[data-accent="([\w-]+)"\]\s*\{([^}]*)\}/g)].map(([, k, body]) =>
    [k, Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]))]),
);
// graphite is the :root default too, so accents resolve against it.
const SHAPE = block(':root');

/** Resolve a token that may itself reference others, or a color-mix(). */
function resolve(name, theme, accent, seen = 0) {
  if (seen > 6) throw new Error('token cycle at ' + name);
  const raw = THEMES[theme]?.[name] ?? SHAPE[name] ?? ACCENTS[accent]?.[name];
  if (raw === undefined) return undefined;

  // color-mix(in srgb, A P%, B)  /  color-mix(in srgb, A P%, transparent)
  const mix = raw.match(/color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/);
  if (mix) {
    const [, ca, pct, cb] = mix;
    const A = resolveMixOperand(ca, theme, accent, seen);
    const B = cb.trim() === 'transparent' ? [0, 0, 0, 0] : resolveMixOperand(cb, theme, accent, seen);
    const w = +pct / 100;
    return [0, 1, 2].map(i => A[i] * w + B[i] * (1 - w)).concat(1);
  }
  // var(--other)
  const v = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (v) return resolve(v[1], theme, accent, seen + 1);
  return parse(raw);
}
function resolveMixOperand(text, theme, accent, seen) {
  const v = text.trim().match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (v) return resolve(v[1], theme, accent, seen + 1);
  return parse(text);
}

const tok = (theme, accent, name) => {
  const v = resolve('--' + name, theme, accent);
  return v && v.map(x => Math.round(x * 1000) / 1000);
};

/* ── the pairs the UI actually renders ──────────────────────────────────
   surface = what the text sits on. For a translucent surface the value is
   composited onto the theme's --bg first, which is what the eye sees.
   `tint` composites the accent over the surface, matching a
   color-mix(accent N%, transparent) background.                            */
const PAIRS = [
  // label,                      fg token,   bg token,   min,  tint
  ['sidebar label (idle)',      'text-3',   'panel',     4.5, 0],
  ['sidebar label (active)',    'text',     'panel',     4.5, 14],
  ['sidebar group label',       'text-3',   'panel',     4.5, 0],
  ['topbar / panel heading',    'text',     'panel',     4.5, 0],
  ['body copy',                 'text-2',   'panel',     4.5, 0],
  ['hint / meta text',          'text-3',   'bg',        4.5, 0],
  ['status bar ok',             'ok',       'bg',        4.5, 0],
  ['status bar warn',           'warn',     'bg',        4.5, 0],
  ['status bar error',          'err',      'bg',        4.5, 0],
  ['log line tx/rx',            'info',     'bg',        4.5, 0],
  ['log line dbg',              'dbg',      'bg',        4.5, 0],
  ['input text',                'text',     'panel-2',   4.5, 0],
  ['mono readout',              'text-2',   'panel-2',   4.5, 0],
  // Non-text graphics (WCAG 1.4.11): the active marker bar must read as a
  // mark against the sidebar surface, at 3:1.
  ['active marker bar',         'accent-mark', 'panel',   3.0, 0],
  // Text: the badge is dark ink on the solid accent.
  ['log badge (ink on accent)', 'accent-ink', 'accent',  4.5, 0],
];

let fails = 0, checks = 0;
const rows = [];
for (const theme of Object.keys(THEMES)) {
  for (const accent of Object.keys(ACCENTS)) {
    for (const [label, fgName, bgName, min, tint] of PAIRS) {
      const rawFg = tok(theme, accent, fgName);
      const rawBg = tok(theme, accent, bgName);
      if (!rawFg || !rawBg) continue;
      // Accent-varying pairs are swept across all 5 accents; pure base-token
      // pairs only need one pass, so they are not repeated 5x.
      const baseOnly = !['accent', 'accent-ink', 'accent-mark'].includes(fgName);
      if (baseOnly && accent !== 'mint') continue;

      let bg = rawBg;
      if (tint) {
        // color-mix(accent N%, transparent) — the accent at N% alpha over the
        // surface. The parsed accent is solid, so its alpha must be set.
        const a = tok(theme, accent, 'accent').slice();
        a[3] = tint / 100;
        bg = over(a, bg);
      }
      const fg = over(rawFg, bg);
      const r = ratio(fg, bg);
      checks++;
      const ok = r >= min;
      if (!ok) fails++;
      rows.push({ theme, accent: baseOnly ? '-' : accent, label, r: r.toFixed(2), min, ok });
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('theme', 10) + pad('accent', 8) + pad('pair', 26) + pad('ratio', 8) + 'min');
console.log('-'.repeat(60));
for (const r of rows) {
  if (!r.ok || process.argv.includes('-v')) {
    console.log(pad(r.theme, 10) + pad(r.accent, 8) + pad(r.label, 26) + pad(r.r, 8) + r.min + (r.ok ? '' : '   <-- FAIL'));
  }
}
console.log(`\n${checks - fails}/${checks} contrast pairs pass WCAG AA`);
if (fails) {
  console.log(`${fails} FAILING — run with -v to list every pair.`);
  process.exit(1);
}
