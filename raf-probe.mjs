/* Confirms the browser under test is actually producing animation frames.
 *
 * The windowed test runner used to raise Chrome to the foreground for exactly
 * this reason: a backgrounded tab has rAF suspended, and anything waiting on a
 * frame hangs. That raise hijacked the desktop while someone was working.
 *
 * Headless should not need it, but "should" is not evidence. If rAF is
 * suspended, every frame-dependent assertion in the suite would hang or flake
 * for a reason that has nothing to do with the code under test — so this
 * asserts the property directly and refuses to pass quietly. */
const HOST = 'http://127.0.0.1:9222';
const APP = 'http://127.0.0.1:8731/index.html';

const list = await (await fetch(`${HOST}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.log('FAIL  no page target exposed on the debug port'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (method, params = {}) => new Promise(res => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

if (!page.url.includes('8731')) {
  await ev(`location.href = ${JSON.stringify(APP)}`);
  await new Promise(r => setTimeout(r, 2500));
}

const ua = await ev('navigator.userAgent');
const headless = /Headless/i.test(ua);

// Count real frames over a bounded wall-clock window, entirely in-page.
const frames = await ev(`new Promise(resolve => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; (performance.now() - t0 < 1000) ? requestAnimationFrame(tick) : resolve(n); };
  requestAnimationFrame(tick);
  setTimeout(() => resolve(n), 3000);   // hard stop, so a frozen rAF still returns
})`);

// And the thing that actually matters: does the app's graph paint?
const painted = await ev(`(() => {
  App.showView('eq');
  const c = document.getElementById('eq-canvas');
  if (!c || !c.clientWidth) return { error: 'canvas has no layout' };
  Graph.draw();
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 40) if (d[i] || d[i+1] || d[i+2]) lit++;
  return { lit, w: c.width, h: c.height };
})()`);

ws.close();

console.log(`mode      ${headless ? 'headless' : 'HEADED  <-- run-tests.ps1 should have launched headless'}`);
console.log(`user-agent ${ua.split(') ').pop()}`);
console.log(`rAF       ${frames} frame(s) in 1 s`);
console.log(`graph     ${JSON.stringify(painted)}`);

const bad = [];
if (!headless) bad.push('not headless');
if (frames < 5) bad.push(`rAF is suspended (${frames} frames in 1 s)`);
if (!painted || painted.error) bad.push(painted?.error || 'graph did not paint');
if (bad.length) { console.log(`\nFAIL  ${bad.join('; ')}`); process.exit(1); }
console.log('\nok    headless, frames flowing, graph painting');
