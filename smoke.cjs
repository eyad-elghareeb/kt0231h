/* Headless smoke test for KTLAB over the Chrome DevTools Protocol.
   Loads the page in a real Chrome, collects every console error and
   uncaught exception, then runs assertions against the live DOM. */
const HOST = 'http://127.0.0.1:9222';

const rpc = (ws) => {
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  return {
    events,
    send(method, params = {}, sessionId) {
      const mid = ++id;
      return new Promise((res, rej) => {
        pending.set(mid, m => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    },
  };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`${HOST}/json/list`)).json();
  let target = list.find(t => t.type === 'page');
  if (!target) {
    await fetch(`${HOST}/json/new?about:blank`, { method: 'PUT' });
    target = (await (await fetch(`${HOST}/json/list`)).json()).find(t => t.type === 'page');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const c = rpc(ws);

  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable');
  await c.send('Page.bringToFront');   // a backgrounded tab freezes requestAnimationFrame
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  const url = process.argv[2] || 'http://127.0.0.1:8731/';
  await c.send('Page.navigate', { url });
  await sleep(2500);

  /* ── collect problems ── */
  const problems = [];
  for (const e of c.events) {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      problems.push(`EXCEPTION  ${d.text} ${d.exception?.description || ''} @${d.url || ''}:${d.lineNumber}`);
    }
    if (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) {
      problems.push(`CONSOLE.${e.params.type.toUpperCase()}  ${e.params.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) {
      problems.push(`LOG.${e.params.entry.level.toUpperCase()}  ${e.params.entry.text} ${e.params.entry.url || ''}`);
    }
  }

  /* ── assertions against the live DOM ── */
  const probe = `(() => {
    const out = {};
    const q = s => document.querySelector(s);
    out.bandCards   = document.querySelectorAll('#eq-bands .band').length;
    out.railButtons = document.querySelectorAll('.rail-btn[data-view]').length;
    out.views       = document.querySelectorAll('.view').length;
    out.activeView  = q('.view.is-active')?.id;
    out.canvasPainted = (() => {
      const c = document.getElementById('eq-canvas');
      if (!c) return 'no canvas';
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 400) if (d[i] > 8 || d[i+1] > 8 || d[i+2] > 8) lit++;
      return lit;
    })();
    out.statusText  = q('#status-text')?.textContent;
    out.theme       = document.documentElement.dataset.theme;
    out.accent      = document.documentElement.dataset.accent;
    out.tokenAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    out.paletteCmds = typeof App !== 'undefined' ? App.palette.items.length : 'App missing';
    out.presets     = typeof Presets !== 'undefined' ? Object.keys(Presets.load()).length : 'x';
    out.profiles    = typeof PROFILES !== 'undefined' ? Object.keys(PROFILES).length : 'x';
    out.rosterRows  = document.querySelectorAll('#chip-roster .roster-row').length;
    out.logFilters  = document.querySelectorAll('#log-filters .seg').length;
    out.logLines    = document.querySelectorAll('#log .log-line').length;
    out.faders      = document.querySelectorAll('#eq-bands .vslider').length;
    out.snapSlots   = document.querySelectorAll('#snap-list .snap').length;
    out.cssVarsResolve = (() => {
      const bad = [];
      const cs = getComputedStyle(document.documentElement);
      for (const n of ['--bg','--panel','--line','--text','--accent','--boost','--cut','--ok','--warn','--err']) {
        if (!cs.getPropertyValue(n).trim()) bad.push(n);
      }
      return bad.length ? 'UNRESOLVED: ' + bad.join(',') : 'all resolve';
    })();
    return JSON.stringify(out);
  })()`;
  const res = await c.send('Runtime.evaluate', { expression: probe, returnByValue: true });
  const state = JSON.parse(res.result.value);

  console.log('── DOM state ──');
  for (const [k, v] of Object.entries(state)) console.log(`  ${k.padEnd(16)} ${v}`);
  console.log('\n── console problems ──');
  if (!problems.length) console.log('  none');
  else problems.forEach(p => console.log('  ' + p));

  ws.close();
  process.exit(problems.some(p => p.startsWith('EXCEPTION') || p.startsWith('CONSOLE.ERROR') || p.startsWith('LOG.ERROR')) ? 1 : 0);
})();
