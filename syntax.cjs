/* Parse-checks every source file, and cross-checks the ids the JS reaches
   for against the ones index.html actually declares. Exit 1 on any fault. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
let fail = 0;
const say = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail = 1;
};

console.log('── parse ──');
for (const f of ['js/chips.js', 'js/core.js', 'js/device.js', 'js/graph.js', 'js/tools.js', 'js/cdc.js', 'js/app.js',
                 'smoke.cjs', 'functional.cjs', 'fwtest.cjs', 'serve.cjs']) {
  const p = path.join(root, f);
  /* A file listed here but absent is a failure, not a skip. Reporting "ok" for
     a missing suite is the same false green as a suite that never ran, and it
     is how a deleted file keeps looking tested. */
  if (!fs.existsSync(p)) { say(false, f, 'listed for parsing but missing on disk'); continue; }
  try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); say(true, f); }
  catch (e) { say(false, f, String(e.stderr || e).split('\n').slice(0, 3).join(' ')); }
}

console.log('\n── static id cross-check ──');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const used = new Map();
for (const f of ['core', 'device', 'graph', 'tools', 'app']) {
  const src = fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8');
  // only single-$ lookups: $$() takes a CSS selector, not an id
  for (const m of src.matchAll(/(?<!\$)\$\(\s*'([^']+)'\s*\)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(f);
  }
  for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(f);
  }
}
const missing = [...used.keys()].filter(k => !ids.has(k)).sort();
say(missing.length === 0, `${used.size} id lookups all resolve`,
    missing.length ? 'missing: ' + missing.join(', ') : '');

const dynamic = ['band-', 'bs-', 'bgv-', 'bf-', 'bq-', 'bft-'];
const clash = [...ids].filter(i => dynamic.some(d => i.startsWith(d) && /-\d+$/.test(i)));
say(clash.length === 0, 'no hardcoded band ids in the markup', clash.join(', '));

console.log('\n── theming discipline ──');
let rawColours = 0;
for (const f of ['css/app.css']) {
  const css = fs.readFileSync(path.join(root, f), 'utf8');
  const hits = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)]
    .map(m => m[0]);
  rawColours += hits.length;
  say(hits.length === 0, `${f} declares no raw colour`,
      hits.length ? hits.slice(0, 8).join(' ') : '');
}

/* A colour literal is only a violation when it is used AS a colour. The
   alpha() helper in core.js necessarily contains "rgb(" and "#" as part of
   parsing a token, so its body is exempt. */
let jsColours = [];
for (const f of ['core', 'device', 'graph', 'tools', 'app']) {
  const src = fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8');
  let inTokenParser = false, depth = 0;
  src.split('\n').forEach((line, i) => {
    if (/^\s*function (alpha|readAccent)\s*\(/.test(line)) { inTokenParser = true; depth = 0; }
    if (inTokenParser) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0 && /^\s*\}/.test(line)) inTokenParser = false;
      return;
    }
    for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b|\brgba?\(/g)) {
      jsColours.push(`${f}.js:${i + 1} ${m[0]}`);
    }
  });
}
say(jsColours.length === 0, 'no hardcoded colour in the JS', jsColours.slice(0, 6).join(' | '));

const tokens = fs.readFileSync(path.join(root, 'css/tokens.css'), 'utf8');
const themes = [...tokens.matchAll(/\[data-theme="([a-z]+)"\]/g)].map(m => m[1]);
say(themes.length >= 4, `${themes.length} themes declared`, themes.join(', '));
const accents = [...tokens.matchAll(/\[data-accent="([a-z]+)"\]/g)].map(m => m[1]);
say(accents.length >= 4, `${accents.length} accents declared`, accents.join(', '));

console.log('\n── typography discipline ──');
/* apple-design §15: tracking is size-specific. One global letter-spacing is
   wrong somewhere on the scale, so every step of the scale owns its own
   tracking token and any rule that sets a size must pair it. This is the
   check that stops the 50 hand-paired declarations drifting apart again. */
const appCss = fs.readFileSync(path.join(root, 'css/app.css'), 'utf8');
let unpaired = [];
let literal = [];
let sizeCount = 0;

/* Walk rule blocks, not lines. The invariant is about a *rule* — a declaration
   pair can straddle a line break, and a line-scoped check reports a correctly
   paired rule as broken. That fires the moment a rule is written the normal way,
   with its declarations on separate lines. */
for (const block of appCss.match(/\{[^{}]*\}/g) || []) {
  const lineNo = appCss.slice(0, appCss.indexOf(block)).split('\n').length;
  for (const m of block.matchAll(/font-size:\s*var\(--fs-(\w+)\)/g)) {
    sizeCount++;
    if (!block.includes(`var(--tr-${m[1]})`)) unpaired.push(`app.css:${lineNo} --fs-${m[1]}`);
  }
  /* A raw letter-spacing value is the rule the tokens exist to prevent — and
     it is also easy to smuggle in *alongside* a correct one, since a later
     declaration silently wins. Checking only for the token's presence missed
     exactly that case, so the literal is banned outright. */
  for (const raw of block.matchAll(/letter-spacing:\s*(-?[\d.]+(?:px|rem|em))\s*;/g)) {
    literal.push(`app.css:${lineNo} ${raw[1]}`);
  }
}
say(unpaired.length === 0, `${sizeCount} font sizes all pair their tracking token`,
    unpaired.slice(0, 6).join(' | '));
say(literal.length === 0, 'no raw letter-spacing values — tracking comes from the scale',
    literal.slice(0, 6).join(' | '));

/* Sizes must come from the scale too. A hand-typed 9px label is smaller than
   the smallest step and is a legibility problem as well as a consistency one;
   the root size on <html> is the scale's own anchor and is exempt. */
let offScale = [];
appCss.split('\n').forEach((line, i) => {
  if (/^\s*html\s*\{/.test(line)) return;
  const m = /font-size:\s*([\d.]+px)/.exec(line);
  if (m) offScale.push(`app.css:${i + 1} ${m[1]}`);
});
say(offScale.length === 0, 'every font size comes from the type scale',
    offScale.slice(0, 6).join(' | '));

/* The type scale must define a tracking and a leading step for every size,
   or the pairing above can reference a token that does not exist. */
let missingSteps = [];
for (const step of ['xs', 'sm', 'md', 'lg', 'xl']) {
  for (const kind of ['tr', 'lh']) {
    if (!new RegExp(`--${kind}-${step}\\s*:`).test(tokens)) missingSteps.push(`--${kind}-${step}`);
  }
}
say(missingSteps.length === 0, 'type scale defines tracking + leading for every step',
    missingSteps.join(' '));

/* No gradients. They are not part of this design language; the two that
   merely *drew* a glyph (select chevron, checkbox tick) were replaced with
   inline SVG so the rule could hold without losing the affordance. */
const grads = [...appCss.matchAll(/[a-z-]*gradient\(/g)].map(m => `${m[0]}`);
say(grads.length === 0, 'no gradients in app.css', grads.slice(0, 6).join(' '));

console.log(fail ? '\nsyntax/id/theme check FAILED' : '\nsyntax/id/theme check passed');
process.exit(fail);
