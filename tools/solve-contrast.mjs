// One-off: solve for token values that hit a WCAG ratio while holding hue.
//   node tools/solve-contrast.mjs
import { readFileSync } from 'node:fs';
const css = readFileSync('css/tokens.css', 'utf8');

function block(sel) {
  const i = css.indexOf(sel), s = css.indexOf('{', i);
  let d = 0, j = s;
  for (; j < css.length; j++) { if (css[j] === '{') d++; else if (css[j] === '}' && --d === 0) break; }
  return Object.fromEntries([...css.slice(s, j).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
const hex = h0 => { const h = h0.length === 4 ? [...h0.slice(1)].map(c => c + c).join('') : h0; return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const lin = u => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const toHex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

/** Walk lightness away from the seed until the target is met, keeping hue. */
function solve(seedHex, bgHex, target, darker) {
  const bg = hex(bgHex);
  const hsl = rgb2hsl(hex(seedHex));
  let best = null;
  for (let step = 0; step <= 100; step++) {
    const l = darker
      ? Math.max(0, hsl.l - step / 100)
      : Math.min(1, hsl.l + step / 100);
    const rgb = hsl2rgb({ ...hsl, l });
    const r = ratio(rgb, bg);
    if (r >= target) return { hex: toHex(rgb), ratio: r, l: +l.toFixed(3) };
    best = { hex: toHex(rgb), ratio: r, l: +l.toFixed(3) };
  }
  return best;
}
function rgb2hsl([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return { h: 0, s: 0, l };
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function hsl2rgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return t.map(v => v + m);
}

const THEMES = ['graphite', 'oled', 'light', 'contrast'];
const rows = [];
for (const th of THEMES) {
  const T = block(`[data-theme="${th}"]`);
  const bgPanel = T['--panel'], bgBg = T['--bg'];
  const dark = lum(hex(bgBg)) > 0.5;   // light background -> darken the text
  // Solve against whichever of --panel / --bg is the harder (lower-contrast)
  // surface for the text, then verify BOTH clear the target.
  const solveBoth = (seed, target) => {
    let cand = solve(seed, bgBg, target, dark);
    if (ratio(hex(cand.hex), hex(bgPanel)) < target) cand = solve(seed, bgPanel, target, dark);
    return cand;
  };
  for (const tokName of ['--text-3', '--ok']) {
    const seed = T[tokName];
    const s = solveBoth(seed, 4.55);
    const onBg = ratio(hex(s.hex), hex(bgBg));
    const onPanel = ratio(hex(s.hex), hex(bgPanel));
    rows.push([th, tokName, seed, s.hex, onBg.toFixed(2), onPanel.toFixed(2),
               (onBg >= 4.5 && onPanel >= 4.5) ? 'ok' : 'FAIL']);
  }
}
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('theme', 10) + pad('token', 9) + pad('from', 10) + pad('to', 10) + pad('on bg', 8) + pad('on panel', 10) + 'note');
console.log('-'.repeat(74));
for (const r of rows) console.log(pad(r[0], 10) + pad(r[1], 9) + pad(r[2], 10) + pad(r[3], 10) + pad(r[4], 8) + pad(r[5], 10) + r[6]);

