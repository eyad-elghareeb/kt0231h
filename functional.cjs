/* Functional test for KTLAB. Runs inside the live page and exercises every
   path that does not need real hardware: editing, history, presets,
   snapshots, AutoEQ, theming, the palette, the register renderer, and the
   firmware patcher against a genuine vendor image from firmware/.
   Usage: node functional.cjs <path-to-firmware-bin> */
const HOST = 'http://127.0.0.1:9222';
const BIN = process.argv[2];

const rpc = (ws) => {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, m => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
};

const TEST = `(async () => {
  const R = [];
  const ok  = (n, d = '') => R.push({ n, pass: true,  d: String(d) });
  const bad = (n, d = '') => R.push({ n, pass: false, d: String(d) });
  const t   = (n, fn) => { try { const r = fn(); r === true ? ok(n) : bad(n, r); } catch (e) { bad(n, e.message); } };
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

  /* ── 1. band encode / decode round-trip ── */
  t('encode/decode round-trip', () => {
    for (const [f, g, q, ty] of [[1000, 6, 1.4, 0], [60, -12, 0.7, 3], [20000, 0.5, 16, 4], [20, 12, 0.1, 1]]) {
      const { aReg, bReg } = encodeBand(f, g, q, ty);
      const d = decodeBand(aReg, bReg);
      if (d.freq !== f || !near(d.gain, g, 0.01) || !near(d.q, q, 0.001) || d.filterType !== ty) {
        return 'mismatch for ' + [f, g, q, ty].join('/') + ' -> ' + JSON.stringify(d);
      }
    }
    return true;
  });
  t('negative gain survives the signed encoding', () => {
    const { aReg } = encodeBand(1000, -6.5, 1, 0);
    return near(decodeBand(aReg, 0).gain, -6.5, 0.01) || 'decoded ' + decodeBand(aReg, 0).gain;
  });
  t('digital gain encode/decode', () => {
    for (const db of [-64, -12.5, 0, 0.5, 63.5]) {
      if (!near(decodeDigGain(encodeDigGain(db)), db, 0.001)) return 'failed at ' + db;
    }
    return true;
  });

  /* ── 2. profile routing (the regression table) ── */
  t('profile routing: name beats VID:PID', () => {
    const cases = [
      ['CDS.KT USB Audio', 0x31B2, 0x0111, 'KT0211L'],
      ["TANGZU WAN'ER 2 DSP", 0x31B2, 0x0111, 'KT0211L'],
      ['KT02H20', 0x31B2, 0x0111, 'KT02H20'],
      ['JCALLY JM12', 0x31B2, 0x0111, 'KT02H20'],
      ['TANCHJIM BUNNY DSP', 0x31B2, 0x1112, 'KT0210'],
      ['KT0231H', 0x31B2, 0x1132, 'KT0231H'],
      ['', 0x31B2, 0x1132, 'KT0231H'],
      ['', 0x31B2, 0x0111, 'KT02H20'],
      ['', 0x31B2, 0x1112, 'KT0210'],
      ['renamed dongle', 0x31B2, 0x0111, 'KT02H20'],
      ['who knows', 0x1234, 0x5678, 'DEFAULT'],
      // Real product strings, read out of the vendor firmware images.
      ['TANCHJIM-DSP S',        0x31B2, 0x0111, 'KT0211L'],
      ['TANCHJIM-FISSION  DSP',  0x31B2, 0x0111, 'KT0211L'],
      ['FISSION-Rational HiFi Edition', 0x31B2, 0x0111, 'KT0211L'],
      ['TANCHJIM BUNNY DSP',    0x31B2, 0x1112, 'KT0210'],
      ['KT USB Audio',          0x31B2, 0x0111, 'KT02H20'],
      ['USB-C Audio',           0x31B2, 0x0111, 'KT02H20'],
    ];
    const keyOf = p => Object.keys(PROFILES).find(k => PROFILES[k] === p) || 'DEFAULT';
    const wrong = cases.filter(c => keyOf(resolveProfile(c[0], c[1], c[2])) !== c[3]);
    return wrong.length ? 'wrong: ' + JSON.stringify(wrong.map(c => [c[0], keyOf(resolveProfile(c[0], c[1], c[2])), c[3]])) : true;
  });
  t('KT0231H map is the 6-band one, others 5', () => {
    const bad = Object.entries(PROFILES).filter(([, p]) => {
      const want = p.name.startsWith('KT0231H') ? 6 : 5;
      return p.bandCount !== want || p.reg.EQ_BANDS !== want;
    });
    return bad.length ? JSON.stringify(bad.map(([k]) => k)) : true;
  });
  t('SAVE is only offered where it is verified', () => {
    const withSave = Object.keys(PROFILES).filter(k => PROFILES[k].supportsSave).sort();
    const expect = ['KT02H20', 'KT0210', 'KT0211L'].sort();
    return JSON.stringify(withSave) === JSON.stringify(expect)
      || 'unexpected: ' + JSON.stringify(withSave);
  });
  t('roster-only profiles cannot hijack VID:PID', () => {
    const bad = ['KT02F21', 'KT02F22', 'KT02H22', 'KT0210S'].filter(k => PROFILES[k].vid !== null || PROFILES[k].pid !== null);
    return bad.length ? 'these claim a VID:PID: ' + bad : true;
  });

  /* ── 3. curve maths ── */
  t('peak at centre returns the band gain', () => {
    const b = { freq: 1000, gain: 6, q: 1, filterType: 0 };
    return near(curveAt(1000, [b]), 6, 0.001) || 'got ' + curveAt(1000, [b]);
  });
  t('low shelf passes low and blocks high', () => {
    const b = { freq: 200, gain: 6, q: 0.7, filterType: 3 };
    const lo = curveAt(20, [b]), hi = curveAt(20000, [b]);
    return (lo > 5.9 && hi < 0.01) || 'lo=' + lo.toFixed(2) + ' hi=' + hi.toFixed(3);
  });
  t('high shelf is the mirror image', () => {
    const b = { freq: 5000, gain: -6, q: 0.7, filterType: 4 };
    const lo = curveAt(20, [b]), hi = curveAt(20000, [b]);
    return (Math.abs(lo) < 0.01 && hi < -5.9) || 'lo=' + lo.toFixed(3) + ' hi=' + hi.toFixed(2);
  });
  t('band gain sums across bands', () => {
    const bands = [
      { freq: 100,  gain: 3, q: 1, filterType: 0 },
      { freq: 5000, gain: -3, q: 1, filterType: 0 },
    ];
    return near(curveAt(100, bands), 3, 0.01) || 'got ' + curveAt(100, bands);
  });

  /* ── 4. editing + history ── */
  t('history records and replays', () => {
    state.banks = makeBanks();
    rebuildFlags();
    History.clear();
    const before = state.banks.DAC[0].gain;
    History.push('test');
    state.banks.DAC[0].gain = 7.5;
    App.refreshAllBands();
    const label = History.undo();
    if (state.banks.DAC[0].gain !== before) return 'undo did not restore ' + state.banks.DAC[0].gain;
    History.redo();
    if (state.banks.DAC[0].gain !== 7.5) return 'redo did not replay';
    History.undo();
    return label === 'test' || 'label was ' + label;
  });
  t('history has a floor', () => {
    History.clear();
    for (let i = 0; i < 200; i++) History.push('flood ' + i);
    return History.past.length === History.LIMIT || 'length ' + History.past.length;
  });
  t('mute keeps a band out of the curve and out of writes', () => {
    state.banks = makeBanks(); rebuildFlags();
    state.banks.DAC[0].gain = 8;
    bandFlag(0).muted = true;
    const withMute = curveAt(state.banks.DAC[0].freq, activeBands());
    bandFlag(0).muted = false;
    const without = curveAt(state.banks.DAC[0].freq, activeBands());
    return (withMute === 0 && without > 0) || 'muted=' + withMute + ' plain=' + without;
  });
  t('band swap exchanges register slots', () => {
    state.banks = makeBanks(); rebuildFlags();
    state.banks.DAC[0].freq = 111; state.banks.DAC[1].freq = 222;
    const tmp = { ...state.banks.DAC[0] };
    state.banks.DAC[0] = { ...state.banks.DAC[1], index: 0 };
    state.banks.DAC[1] = { ...tmp, index: 1 };
    return (state.banks.DAC[0].freq === 222 && state.banks.DAC[1].freq === 111) || 'swap failed';
  });
  t('fader is wired to band state', () => {
    state.banks = makeBanks(); rebuildFlags();
    App.buildBands();
    const s = document.getElementById('bs-2');
    if (!s) return 'no fader for band 3';
    s.value = '4.5';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return near(state.banks.DAC[2].gain, 4.5) || 'band gain is ' + state.banks.DAC[2].gain;
  });
  t('band tool buttons are all wired', () => {
    const tools = document.querySelectorAll('#eq-bands .band-tool');
    return tools.length === state.bands.length * 5 || 'expected ' + state.bands.length * 5 + ', found ' + tools.length;
  });

  /* ── 5. presets ── */
  t('preset round-trip through the v4 schema', () => {
    Presets.clearAll();
    state.banks = makeBanks(); rebuildFlags();
    state.banks.DAC[1].gain = -4.25; state.banks.DAC[1].q = 1.75; state.banks.DAC[1].filterType = 3;
    state.globalGain = -3.5; state.pgaADC = 3; state.digADC = 2.5;
    Presets.add('unit test');
    const back = Presets.normalise(Presets.load()['unit test']);
    if (!back) return 'failed to normalise';
    if (back.banks.DAC[1].gain !== -4.25 || back.banks.DAC[1].q !== 1.75) return 'band lost: ' + JSON.stringify(back.banks.DAC[1]);
    if (back.gains.globalGain !== -3.5 || back.gains.pgaADC !== 3 || back.gains.digADC !== 2.5) return 'gains lost: ' + JSON.stringify(back.gains);
    applyState(back, { history: false });
    return near(state.banks.DAC[1].gain, -4.25) || 'apply did not take';
  });
  t('legacy v3 presets still import', () => {
    const legacy = { 'old one': { bands: [{ freq: 1000, gain: 3, q: 0.7, filterType: 0 }], adcBands: [{ freq: 2000, gain: -2, q: 0.7, filterType: 0 }], globalGain: -1.5, pgaADC: 2, pgaDAC: 3, digADC: 0, savedAt: '2025-01-01T00:00:00.000Z' } };
    const n = Presets.normalise(legacy['old one']);
    return (n && n.banks.DAC.length === 1 && n.banks.ADC.length === 1 && n.gains.globalGain === -1.5)
      || 'legacy import broken: ' + JSON.stringify(n);
  });
  t('junk presets are rejected, not silently accepted', () => {
    const junk = [{ bands: [] }, { bands: [{ freq: 'x' }] }, { nope: 1 }, null, 'string', { bands: [{ freq: 1, gain: 2 }] }];
    const accepted = junk.filter(j => Presets.normalise(j));
    return accepted.length === 0 || 'accepted ' + accepted.length + ' junk entries';
  });
  t('preset apply pads to the chip band count', () => {
    const one = { version: 4, banks: { DAC: [{ freq: 500, gain: 2, q: 1, filterType: 0 }] }, gains: {} };
    applyState(Presets.normalise(one), { history: false });
    const want = hid.profile.bandCount;
    return state.banks.DAC.length === want || 'padded to ' + state.banks.DAC.length + ', want ' + want;
  });
  Presets.clearAll();

  /* ── 6. snapshots ── */
  t('snapshot capture and restore', () => {
    App.saveSnaps([]);
    state.banks = makeBanks(); rebuildFlags();
    state.banks.DAC[0].gain = 9;
    App.captureSnap(0);
    state.banks.DAC[0].gain = -9;
    App.restoreSnap(0);
    return near(state.banks.DAC[0].gain, 9) || 'restored ' + state.banks.DAC[0].gain;
  });
  t('snapshot slots render with sparklines', () => {
    App.renderSnaps();
    const slots = document.querySelectorAll('#snap-list .snap');
    const filled = document.querySelectorAll('#snap-list .snap.is-filled');
    return (slots.length === 4 && filled.length === 1) || slots.length + ' slots, ' + filled.length + ' filled';
  });
  App.saveSnaps([]);

  /* ── 7. AutoEQ ── */
  t('AutoEQ maps filters onto the hardware bands', () => {
    state.banks = makeBanks(); rebuildFlags();
    const n = AutoEQ.ingest({
      filters: [
        { type: 'peaking', frequency: 105, gain: -4.2, q: 1.1 },
        { type: 'low_shelf', frequency: 80, gain: 5.5, q: 0.7 },
        { type: 'high_shelf', frequency: 9000, gain: -2.5, q: 0.7 },
      ],
      target: [{ freq: 20, gain: 5 }, { freq: 1000, gain: 0 }, { freq: 20000, gain: 2 }],
    }, 'unit.json');
    if (n !== 3) return 'mapped ' + n;
    const types = state.banks.DAC.slice(0, 3).map(b => b.filterType);
    const freqs = state.banks.DAC.slice(0, 3).map(b => b.freq);
    return (JSON.stringify(types) === JSON.stringify([3, 0, 4]) && JSON.stringify(freqs) === JSON.stringify([80, 105, 9000]))
      || 'types ' + JSON.stringify(types) + ' at ' + JSON.stringify(freqs);
  });
  t('AutoEQ keeps the loudest filters when there are too many', () => {
    state.banks = makeBanks(); rebuildFlags();
    const room = state.banks.DAC.length;
    const filters = [];
    for (let i = 0; i < room + 6; i++) filters.push({ type: 'peaking', frequency: 100 + i * 90, gain: i / 10, q: 1 });
    const n = AutoEQ.ingest({ filters }, 'too many');
    if (n !== room) return 'mapped ' + n + ' into ' + room + ' bands';
    const gains = state.banks.DAC.map(b => b.gain).sort((a, b) => b - a);
    const loudest = filters.map(f => f.gain).sort((a, b) => b - a).slice(0, room);
    return JSON.stringify(gains) === JSON.stringify(loudest) || 'kept ' + JSON.stringify(gains);
  });
  t('AutoEQ sorts the chosen bands by frequency', () => {
    const freqs = state.banks.DAC.map(b => b.freq);
    const sorted = [...freqs].sort((a, b) => a - b);
    return JSON.stringify(freqs) === JSON.stringify(sorted) || 'out of order: ' + freqs;
  });
  t('AutoEQ target is resampled onto the log axis', () => {
    const target = AutoEQ.normaliseTarget([{ freq: 20, gain: 0 }, { freq: 20000, gain: 0 }]);
    return (target && target.length > 100 && target[0].freq < 25 && target[target.length-1].freq > 19000)
      || 'target shape wrong: ' + (target ? target.length : 'null');
  });
  t('AutoEQ target drives the graph overlay', () => {
    AutoEQ.ingest({ filters: [{ type: 'peaking', frequency: 1000, gain: 0, q: 1 }], target: [{ freq: 20, gain: 1 }, { freq: 20000, gain: 1 }] }, 't');
    const drawn = !!Graph.target && Graph.target.length > 100;
    const err = AutoEQ.error(Graph.target);
    const rep = document.getElementById('autoeq-report').textContent;
    AutoEQ.clearTarget();
    return (drawn && err && rep.includes('RMS')) || 'overlay=' + drawn + ' report=' + rep.slice(0, 60);
  });
  t('AutoEQ reports what it dropped', () => {
    state.banks = makeBanks(); rebuildFlags();
    const room = state.banks.DAC.length;
    const filters = Array.from({ length: room + 3 }, (_, i) => ({ type: 'peaking', frequency: 100 * (i + 1), gain: 1, q: 1 }));
    AutoEQ.ingest({ filters }, 'x');
    const rep = document.getElementById('autoeq-report').textContent;
    AutoEQ.clearTarget();
    return rep.includes('dropped') || 'no drop notice in: ' + rep.slice(0, 120);
  });
  t('a perfectly flat target against a flat EQ scores zero error', () => {
    state.banks = makeBanks(); rebuildFlags();
    state.banks.DAC.forEach(b => { b.gain = 0; b.filterType = 0; });
    const target = AutoEQ.normaliseTarget([{ freq: 20, gain: 0 }, { freq: 20000, gain: 0 }]);
    const e = AutoEQ.error(target);
    return (e && e.rms < 0.001) || 'rms ' + (e && e.rms);
  });

  /* ── 8. theming ── */
  t('every theme resolves every colour token', () => {
    const need = ['--bg','--bg-deep','--panel','--panel-2','--raised','--hover','--line','--line-2',
                  '--text','--text-2','--text-3','--ok','--warn','--err','--info','--dbg',
                  '--accent','--accent-hi','--accent-ink','--accent-soft','--accent-line',
                  '--boost','--cut','--graph-bg'];
    const prev = Settings.data.theme;
    const bad = [];
    for (const th of THEME_ORDER) {
      Settings.setTheme(th);
      for (const n of need) if (!token(n)) bad.push(th + ' ' + n);
    }
    Settings.setTheme(prev);
    return bad.length ? 'unresolved: ' + bad.join(', ') : true;
  });
  t('every accent resolves its own ramp', () => {
    const prev = Settings.data.accent;
    const bad = [];
    for (const a of ACCENTS) {
      Settings.data.accent = a; Settings.apply();
      for (const n of ['--accent','--accent-hi','--accent-ink','--accent-soft','--accent-line','--boost','--cut']) {
        if (!token(n)) bad.push(a + ' ' + n);
      }
    }
    Settings.data.accent = prev; Settings.apply();
    return bad.length ? 'unresolved: ' + bad.join(', ') : true;
  });
  t('alpha() converts a hex token to rgba', () => {
    Settings.setTheme('graphite');
    const a = alpha('--boost', 0.5);
    return /^rgba\\(\\d+, \\d+, \\d+, 0\\.5\\)$/.test(a) || 'got ' + a;
  });
  t('the graph repaints across every theme and accent', () => {
    // Establish the view's own preconditions rather than inheriting them.
    // clientWidth is 0 whenever the view is display:none, and which test ran
    // before is not a contract — reading layout from an inherited state made
    // this fail intermittently for a reason that had nothing to do with the
    // themes it is checking.
    App.showView('eq');
    const prevT = Settings.data.theme, prevA = Settings.data.accent;
    const c = document.getElementById('eq-canvas');
    if (!c.clientWidth) return 'canvas has no layout - the view is hidden';
    let painted = 0;
    for (const th of THEME_ORDER) {
      for (const a of ACCENTS) {
        Settings.data.theme = th; Settings.data.accent = a; Settings.apply();
        Graph.draw();
        const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 40) if (d[i] || d[i+1] || d[i+2]) lit++;
        if (lit > 50) painted++;
      }
    }
    Settings.data.theme = prevT; Settings.data.accent = prevA; Settings.apply();
    Graph.draw();
    return painted === THEME_ORDER.length * ACCENTS.length
      || 'only ' + painted + '/' + (THEME_ORDER.length * ACCENTS.length) + ' combinations painted';
  });
  t('the dB range selector changes the plot scale', () => {
    const before = Graph.opts.dbMax;
    Graph.setOption('dbMax', 6);
    const okA = Graph.opts.dbMax === 6 && Graph.toY(6) < Graph.padT + 2;
    Graph.setOption('dbMax', 20);
    const okB = Graph.opts.dbMax === 20 && Graph.toY(20) < Graph.padT + 2;
    Graph.setOption('dbMax', before);
    return (okA && okB) || 'clamp broken';
  });

  /* ── 9. views + palette + keyboard ── */
  t('every view routes and shows', () => {
    const bad = [];
    for (const v of VIEWS) {
      App.showView(v);
      if (!document.getElementById('view-' + v).classList.contains('is-active')) bad.push(v + ' did not activate');
      if (App.view !== v) bad.push(v + ' not recorded');
    }
    App.showView('eq');
    return bad.length ? bad.join('; ') : true;
  });
  t('palette filters and runs', () => {
    App.palette.open();
    const total = App.palette.filtered.length;
    App.palette.render('firmware');
    const narrowed = App.palette.filtered.length;
    const allFirmware = App.palette.filtered.every(i => (i.label + ' ' + (i.group || '')).toLowerCase().includes('firmware'));
    App.palette.render('');
    App.palette.select(0);
    const first = App.palette.filtered[0];
    App.palette.close();
    return (total > 30 && narrowed < total && narrowed > 0 && allFirmware && App.palette.filtered.length === total)
      || 'total=' + total + ' narrowed=' + narrowed;
  });
  t('R and W are ignored while disconnected', () => {
    const before = Log.buffer.length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    return Log.buffer.length === before || 'a key fired work while disconnected';
  });

  /* ── 10. register explorer rendering ── */
  t('register table renders, filters and diffs', () => {
    Registers.rows = [];
    for (let a = 0; a < 256; a++) Registers.rows.push([a, (a * 0x01010101) >>> 0]);
    Registers.prev = null; Registers.filter = ''; Registers.showDiff = false;
    Registers.render();
    const all = document.querySelectorAll('#reg-dump .log-line').length;
    Registers.filter = 'a_adc';
    Registers.render();
    const filtered = document.querySelectorAll('#reg-dump .log-line').length;
    const probeVal = (Registers.rows[0x42][1] >>> 0).toString(16).padStart(8, '0');
    Registers.filter = probeVal;
    Registers.render();
    const byValue = document.querySelectorAll('#reg-dump .log-line').length;
    Registers.prev = Registers.rows.map(([a, v]) => [a, v ^ 0xFF]);
    Registers.showDiff = true;
    Registers.render();
    const stat = document.getElementById('reg-stats').textContent;
    Registers.filter = ''; Registers.prev = null; Registers.showDiff = false; Registers.render();
    return (all === 64 && filtered < all && byValue > 0 && stat.includes('changed'))
      || 'all=' + all + ' filtered=' + filtered + ' byValue=' + byValue + ' stat=' + stat;
  });
  t('unreadable registers render as errors, not zeros', () => {
    Registers.rows = [[0, null], [1, 0]];
    Registers.render();
    const txt = document.getElementById('reg-dump').textContent;
    Registers.rows = null;
    return (txt.includes('ERR') && txt.includes('00000000')) || 'got: ' + txt;
  });

  /* ── 11. queue behaviour ── */
  const AQ = [];
  const ta = async (n, fn) => AQ.push([n, await fn()]);
  await ta('queue collapses same-key work and resolves everyone', async () => {
    const q = new CommandQueue(0);
    let ran = 0;
    const p1 = q.add(async () => { ran++; return 'a'; }, 'k');
    const p2 = q.add(async () => { ran++; return 'b'; }, 'k');
    const p3 = q.add(async () => { ran++; return 'c'; }, 'k');
    const vals = await Promise.all([p1, p2, p3]);
    return (ran <= 2 && ran >= 1 && vals[1] === 'c' && vals[2] === 'c')
      || 'ran=' + ran + ' vals=' + JSON.stringify(vals);
  });
  await ta('queue runs distinct keys in order', async () => {
    const q = new CommandQueue(0);
    const order = [];
    await Promise.all(['a', 'b', 'c'].map(k => q.add(async () => { order.push(k); })));
    return order.join('') === 'abc' || order.join('');
  });
  await ta('a throwing task rejects only itself', async () => {
    const q = new CommandQueue(0);
    const badP = q.add(async () => { throw new Error('boom'); });
    const goodP = q.add(async () => 'fine');
    let rejected = false;
    await badP.catch(() => { rejected = true; });
    return (rejected && (await goodP) === 'fine') || 'rejection leaked';
  });
  await ta('clearing the queue rejects the pending work', async () => {
    const q = new CommandQueue(50);
    q.add(async () => sleep(150));        // occupies the worker
    const p = q.add(async () => 'never'); // still queued
    await sleep(10);
    q.clear('gone');
    let msg = '';
    await p.catch(e => { msg = e.message; });
    return msg === 'gone' || 'got ' + JSON.stringify(msg);
  });
  t('the queue gap is configurable', () => {
    const q = new CommandQueue(100);
    q.setGap(0); const a = q.gap;
    q.setGap(250); const b = q.gap;
    q.setGap(100);
    return (a === 0 && b === 250) || a + '/' + b;
  });

  /* ── 12. Sidebar geometry and chrome ──
     The rail is a full-height structural column, not a content-sized strip:
     it must reach the bottom of the viewport, carry the theme control in its
     footer rather than as a 7th nav item, and never animate "all". */
  t('the sidebar fills the viewport height', () => {
    const r = document.querySelector('.rail');
    const f = document.querySelector('.rail-foot');
    if (!r || !f) return 'rail or rail-foot missing';
    const rb = r.getBoundingClientRect(), fb = f.getBoundingClientRect();
    const fills = Math.abs(rb.bottom - innerHeight) < 2;
    const footPinned = Math.abs(innerHeight - fb.bottom) <= 10;
    const footOutside = !document.querySelector('.rail-nav').contains(f);
    return (fills && footPinned && footOutside)
      || JSON.stringify({ fills, footPinned, footOutside, bottom: rb.bottom, innerHeight });
  });
  t('the sticky rail offset tracks the real top-bar height', () => {
    const declared = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'));
    const actual = document.querySelector('.topbar').getBoundingClientRect().height;
    // The top bar wraps to two rows on narrow viewports, so a hardcoded
    // offset would drift; the ResizeObserver must keep them in step.
    return Math.abs(declared - actual) < 1.5 || JSON.stringify({ declared, actual });
  });
  t('the active nav item is marked by shape, not just colour', () => {
    // A bright accent is illegible as small text on a light panel, so the
    // selected state is carried by the marker bar and the tint as well.
    // The view is pinned first for the same reason as the graph test: exactly
    // one item must be active, and inheriting that from an earlier test made
    // this intermittent.
    App.showView('eq');
    const sel = [...document.querySelectorAll('.rail-btn.is-active')];
    if (sel.length !== 1) return sel.length + ' active items';
    const a = sel[0];
    const probe = document.createElement('span');
    probe.style.color = 'var(--text)';
    document.body.appendChild(probe);
    const text = getComputedStyle(probe).color;
    probe.remove();
    const label = getComputedStyle(a).color;
    const mark = getComputedStyle(a, '::before').backgroundColor;
    return (label === text && mark !== 'rgba(0, 0, 0, 0)')
      || 'label ' + label + ' vs ' + text + ', marker ' + mark;
  });
  t('the rail animates transform and opacity, never "all"', () => {
    const bad = [];
    for (const [sel, pseudo] of [['.rail', null], ['.rail-btn', null], ['.rail-btn', '::before']]) {
      const el = document.querySelector(sel);
      if (!el) { bad.push(sel + ' missing'); continue; }
      const cs = getComputedStyle(el, pseudo);
      // transition-property initialises to "all"; only a non-zero duration
      // makes that a real "animate everything" transition.
      const dur = cs.transitionDuration.split(',').map(s => parseFloat(s) || 0);
      const props = cs.transitionProperty.split(',').map(s => s.trim());
      if (props.some((p, i) => p === 'all' && (dur[i] ?? dur[0]) > 0)) {
        bad.push(sel + (pseudo || '') + ': ' + cs.transition);
      }
    }
    return bad.length === 0 || bad.join('; ');
  });

  /* ── 13. CDC bootloader framing (js/cdc.js) ───────────────────────────
     These are the pure parts of the serial transport: no hardware needed to
     prove them, and getting any of them wrong bricks the write, so they are
     pinned against the reversed protocol rather than against themselves. */
  t('the CDC CRC table is the canonical reflected CRC-32 table', () => {
    // The RE matched the vendor table at DAT_0120e020 byte-exactly; table[1]
    // is the value that proves poly 0xEDB88320 reflected.
    return CDC_CRC_TABLE[1] === 0x77073096 || '0x' + CDC_CRC_TABLE[1].toString(16);
  });
  t('the CDC CRC is seeded 0 with no final XOR, not the stock crc32', () => {
    const nine = new TextEncoder().encode('123456789');
    const got = cdcCrc32(nine);
    if (got !== 0x2DFD2D88) return 'golden 0x2DFD2D88, got 0x' + got.toString(16);
    if (cdcCrc32(new Uint8Array(0)) !== 0) return 'empty input must CRC to 0';
    // The stock check value is 0xCBF43926; if this ever matches, the init and
    // xorout have been "corrected" into a variant the device will reject.
    if (got === 0xCBF43926) return 'this is the stock crc32 — wrong variant';
    return true;
  });
  t('the data-packet header packs length, bank and 24-bit address', () => {
    const bytes = h => [...h].map(x => x.toString(16).padStart(2, '0')).join(' ');
    if (bytes(cdcHeader(1024, 0, 7)) !== '69 00 e4 00 00 00') return '1024/top3=7: ' + bytes(cdcHeader(1024, 0, 7));
    if (bytes(cdcHeader(1024, 0, 1)) !== '69 00 24 00 00 00') return 'bank 1: ' + bytes(cdcHeader(1024, 0, 1));
    if (bytes(cdcHeader(16, 0x123456, 7)) !== '69 10 e0 56 34 12') return 'addr: ' + bytes(cdcHeader(16, 0x123456, 7));
    return true;
  });
  t('the final-packet header falls out of the general encoder', () => {
    // The RE reports the final packet as a hard-coded "69 10 E0". It is not a
    // special case: 0x10 is L & 0xFF with L = 16 and 0xE0 is 0b111 << 5. If a
    // future change special-cases it, this is the assertion that notices.
    const h = cdcHeader(16, 0, 7);
    return (h[0] === 0x69 && h[1] === 0x10 && h[2] === 0xE0) || [...h].join(' ');
  });
  t('the header rejects lengths and addresses that overflow their fields', () => {
    let threw = 0;
    for (const [l, a] of [[0x2000, 0], [-1, 0], [0x1FFF, 0x1000000], [1024, 0xFFFFFF + 1]]) {
      try { cdcHeader(l, a, 7); } catch (e) { if (e instanceof RangeError) threw++; }
    }
    return threw === 4 || threw + '/4 rejected';
  });
  t('the header masks top3 to the three bits it owns', () => {
    // H[2] bits 5..7 are the bank; bits 0..4 are the top length bits. A top3
    // of 9 must not corrupt the length field.
    const h = cdcHeader(16, 0, 9);
    return (h[2] === 0x20 && h[1] === 0x10) || 'H[1]=' + h[1] + ' H[2]=' + h[2];
  });
  t('the packet CRC covers header and payload, not the payload alone', () => {
    const payload = new Uint8Array(64).map((_, i) => i);
    const pkt = cdcPacket(payload, 0x800, 7);
    if (pkt.length !== 6 + payload.length + 4) return 'length ' + pkt.length;
    const body = pkt.subarray(0, 6 + payload.length);
    const want = cdcCrc32(body);
    const got = new DataView(pkt.buffer).getUint32(body.length, true);
    if (got !== want) return 'trailer 0x' + got.toString(16) + ' != 0x' + want.toString(16);
    if (want === cdcCrc32(payload)) return 'CRC ignores the header — wrong';
    return true;
  });
  t('the image plan holds back the 16-byte head and writes it last', () => {
    const img = new Uint8Array(0x800).map((_, i) => i & 0xFF);
    const plan = [...cdcImagePackets(img)];
    const d = plan.map(p => ({ b: p.block, addr: p.addr, len: p.payload.length, top3: p.top3, fin: !!p.final }));
    const want = [
      { b: 0, addr: 0x10, len: 1008, top3: 1, fin: false },   // block 0 starts past the head
      { b: 1, addr: 0x400, len: 1024, top3: 7, fin: false },
      { b: 2, addr: 0x000, len: 16, top3: 7, fin: true },      // the head, written last
    ];
    if (JSON.stringify(d) !== JSON.stringify(want)) return JSON.stringify(d);
    // The held-back head must be exactly image[0..16], and nothing else may
    // carry those 16 bytes a second time.
    const last = plan[plan.length - 1];
    if (last.payload[0] !== 0 || last.payload[15] !== 15) return 'final payload is not image[0..16]';
    return true;
  });
  t('the bank id is stamped only on region-boundary packets', () => {
    // 33 blocks so the 0x20 (32-block) boundary is actually crossed.
    const img = new Uint8Array(0x400 * 33);
    const plan = [...cdcImagePackets(img, { bankId: 1 })];
    const marked = plan.filter(p => p.top3 === 1).map(p => p.block);
    return JSON.stringify(marked) === '[0,32]'
      || 'bank-marked blocks: ' + JSON.stringify(marked);
  });
  t('the CDC erase block matches the WebHID configure packet', () => {
    // Same 10 bytes as BOOT.configure()'s defaults: chipType 0x10, base 0x6000,
    // sector 0x0E, timing 0x15. If one transport is retuned, both must move.
    const e = CDC_TOKENS.ERASE;
    const cfg = [0x2D, 0x29, 0x00, 0x10, 0x0E, 0x15, 0x00, 0x60, 0x00, 0xBC];
    if (e.length !== 10 || e.some((b, i) => b !== cfg[i])) return 'erase ' + e.map(b => b.toString(16)).join(' ');
    return (e[7] << 8 | e[6]) === 0x6000 || 'flash base ' + ((e[7] << 8) | e[6]).toString(16);
  });
  t('the CDC and WebHID KTM tokens are the same token, framed differently', () => {
    // Over HID the token is a little-endian u32 in a feature report; over CDC
    // it is the raw lead byte plus "KTM". Same handshake, two framings.
    const ktm = CDC_TOKENS.KTM;
    if (ktm[0] !== 0x1E) return 'lead 0x' + ktm[0].toString(16);
    if (String.fromCharCode(...ktm.slice(1)) !== 'KTM') return 'body ' + String.fromCharCode(...ktm.slice(1));
    const word = ((ktm[0] << 24) | (ktm[1] << 16) | (ktm[2] << 8) | ktm[3]) >>> 0;
    return word === 0x1E4B544D || '0x' + word.toString(16);
  });
  t('the bootloader transport selector switches the whole panel', () => {
    const segs = [...document.querySelectorAll('.seg-group [data-transport]')];
    if (segs.length !== 2) return segs.length + ' transports';
    App.setBootTransport('cdc');
    const cdc = segs[1].getAttribute('aria-checked') === 'true'
      && segs[0].getAttribute('aria-checked') === 'false'
      && !$('boot-cdc-opts').hidden
      && App.bootMode() === 'cdc' && App.bootLink() === CDC;
    App.setBootTransport('hid');
    const hid = segs[0].getAttribute('aria-checked') === 'true'
      && segs[1].getAttribute('aria-checked') === 'false'
      && $('boot-cdc-opts').hidden
      && App.bootMode() === 'hid' && App.bootLink() === BOOT;
    return (cdc && hid) || ('cdc=' + cdc + ' hid=' + hid);
  });

  /* ── 17. firmware differ ──
     The differ's value is entirely in its verdict, so the tests are written
     against the claims it makes, not just the arithmetic. A tool that says
     "2 bytes differ" without saying what that means has not answered the
     question the user asked. */
  t('identical images are reported as identical', () => {
    const a = new Uint8Array(0x4000); for (let i = 0; i < a.length; i++) a[i] = i & 0xFF;
    const d = fwDiff(a, a.slice());
    return (d.identical && d.verdict === 'byte-identical' && d.runs === 0)
      || 'verdict=' + d.verdict + ' runs=' + d.runs;
  });
  t('a differing byte length is itself a finding', () => {
    const a = new Uint8Array(0x100);
    const d = fwDiff(a, new Uint8Array(0x80));
    if (d.identical) return 'a truncated image was called identical';
    if (d.sizeA !== 0x100 || d.sizeB !== 0x80) return 'sizes not reported';
    return true;
  });
  t('a re-badged build reads as strings, not new firmware', () => {
    // The case this was built for: two images sharing a build date and git
    // hash that differ only in the product string. A naive differ reports
    // "bytes differ" and leaves the reader to panic; the verdict has to say
    // the code is the same.
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    const put = (buf, off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
    put(a, 0x1000, 'DSP S');
    put(b, 0x1000, 'FISSION');
    const d = fwDiff(a, b);
    if (d.codeBytes !== 0) return 'claimed ' + d.codeBytes + ' code bytes changed';
    if (!/strings/.test(d.verdict)) return 'verdict was ' + d.verdict;
    return true;
  });
  const fillTable = (buf, off, mutate) => {
    for (let i = 0; i < 5; i++) {
      buf.set(FwBin.encode(mutate({ freq: 1000 + i * 500, gain: 0, q: 0.707, filterType: 0 }, i)), off + i * 8);
    }
  };
  t('a re-tuned EQ reads as a different sound', () => {
    // Same code, different band parameters. This is the case that must NOT be
    // filed under "just a label" — the unit will sound different. Decided by
    // decoding, the only way the answer means anything.
    //
    // Both sides carry a *complete, valid* table. Writing one real band into an
    // otherwise zero buffer leaves four slots decoding as freq 0 / Q 0, which
    // the plausibility check rightly rejects — so a partly-populated buffer
    // would make this test pass or fail for the wrong reason.
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    const dac = 0x3100;
    const tables = [{ off: dac, n: 5, decode: (buf, off) => FwBin.decode(buf, off) }];
    fillTable(a, dac, x => x);
    fillTable(b, dac, (x, i) => (i === 0 ? { ...x, gain: 3.2, q: 1.4 } : x));
    const d = fwDiff(a, b, { eqTables: tables });
    if (d.eqSkipped?.length) return 'a valid table was rejected as implausible: ' + JSON.stringify(d.eqSkipped);
    if (!d.eqChanged.length) return 'the EQ change was not detected';
    if (!d.eqChanged[0].audible) return 'a +3.2 dB band was judged inert';
    if (/different code/.test(d.verdict)) return 'an EQ change was called a code change';
    if (!/different EQ tune/.test(d.verdict)) return 'verdict was ' + d.verdict;
    return true;
  });
  t('a region that does not decode as bands yields no EQ claim at all', () => {
    // locateRun matches candidates by pattern and will hit non-EQ bytes. The
    // first version of the differ reported five phantom "changed bands" with
    // values like "30 Hz, type 65472" — inventing a difference the user could
    // not act on, which is worse than reporting nothing. A table that does not
    // decode as bands must be skipped and said to be skipped.
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    const fake = 0x3200;
    fillTable(a, fake, x => x);
    // B carries a well-formed-looking run that is not bands: the entries decode
    // but to values no filter can hold.
    fillTable(b, fake, () => ({ freq: 2, gain: 0, q: 99, filterType: 65000 }));
    const d = fwDiff(a, b, { eqTables: [{ off: fake, n: 5, name: 'ADC', decode: (buf, off) => FwBin.decode(buf, off) }] });
    if (d.eqChanged.length) {
      return 'invented ' + d.eqChanged.length + ' band difference(s) from a region that is not an EQ table';
    }
    if (!d.eqSkipped || !d.eqSkipped.length) return 'the skipped table was not reported';
    if (d.eqSkipped[0].table !== 'ADC') return 'wrong table reported as skipped';
    return true;
  });
  t('a filter-shape change at 0 dB is reported as inert, not as a retune', () => {
    // This is the real 2024-vs-2025 Tanchjim case: every gain is 0 dB and the
    // curves are identical, but band 4's filter type differs. A tool that says
    // "different EQ tune" here is overclaiming about what you hear, and the
    // user is left chasing a sound difference that does not exist.
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    const dac = 0x3100;
    const tables = [{ off: dac, n: 5, decode: (buf, off) => FwBin.decode(buf, off) }];
    fillTable(a, dac, x => x);
    fillTable(b, dac, (x, i) => (i === 4 ? { ...x, filterType: 1 } : x));
    const d = fwDiff(a, b, { eqTables: tables });
    if (!d.eqChanged.length) return 'the shape change went unreported';
    if (d.eqChanged.some(c => c.audible)) return 'a 0 dB shape change was called audible';
    if (/different EQ tune/.test(d.verdict)) return 'verdict overclaimed an audible retune: ' + d.verdict;
    if (!/no audible change/.test(d.verdict)) return 'verdict did not say why it is inert: ' + d.verdict;
    return true;
  });
  t('a genuine code change is not softened into a label edit', () => {
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    b[0x3400] ^= 0xFF; b[0x3401] ^= 0x0F;      // two bytes inside code
    const d = fwDiff(a, b, { dacOff: 0x3100 });
    if (d.codeBytes < 2) return 'code difference not seen: ' + d.codeBytes;
    if (!/different code/.test(d.verdict)) return 'verdict was ' + d.verdict;
    return true;
  });
  t('a differing run is coalesced, not counted per byte', () => {
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    for (let i = 0; i < 40; i++) b[0x1000 + i] ^= 0xFF;   // one 40-byte edit
    const d = fwDiff(a, b);
    if (d.runs !== 1) return '40 contiguous bytes counted as ' + d.runs + ' runs';
    if (d.bytes !== 40) return 'byte total ' + d.bytes;
    return true;
  });
  t('separated edits stay separate runs', () => {
    const a = new Uint8Array(0x4000);
    const b = a.slice();
    b[0x1000] ^= 0xFF; b[0x1010] ^= 0xFF; b[0x1020] ^= 0xFF;
    const d = fwDiff(a, b);
    if (d.runs !== 3) return d.runs + ' runs for 3 separated edits';
    return true;
  });
  t('the differ never reads past the end of either image', () => {
    // A 12-byte image is smaller than a single region; a differ that trusted
    // the region table over the buffer would throw here.
    const d = fwDiff(new Uint8Array(12), new Uint8Array(20), { dacOff: 0 });
    return (d && d.runs >= 1) || 'no result';
  });

  /* ── 18. the differ against the real firmware corpus ──
     The unit tests prove the arithmetic on synthetic buffers. This proves the
     verdicts are true of actual hardware images, fetched over the same static
     server the app is served from — so the bytes under test are the vendor's
     rather than a fixture written to match the implementation. */
  await ta('the differ tells real vendor builds apart correctly', async () => {
    const realImage = async name => {
      const r = await fetch('/firmware/' + name);
      if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    };
    try {
      const [dspS, fission, jackOff, jackOn, rational] = await Promise.all([
        realImage('TANCHJIM_DSP_S_KT0211L_20240815_v1.0.2.bin'),
        realImage('KT0211L_FISSION_v1.0.2_250610.bin'),
        realImage('KT02F20_SDK_20250206_disable_jack.bin'),
        realImage('KT02F20_SDK_20250206_jack_GPIO_03.bin'),
        realImage('KT0211L_fission_rational_hifi_edition_v1.0.1_20250610.bin'),
      ]);

      // The claim this tool was built to settle: the 2024 Tanchjim cut and the
      // 2025 Fission cut ship the same code under different branding. Asserted
      // rather than trusted, because it is a claim about vendor images.
      const tables = [
        { off: FwBin.dacOff, n: 5, decode: (buf, off) => FwBin.decode(buf, off), name: 'DAC' },
        { off: FwBin.adcOff, n: 5, decode: (buf, off) => FwBin.decode(buf, off), name: 'ADC' },
      ];
      const pair = fwDiff(dspS, fission, { eqTables: tables });
      if (pair.codeBytes !== 0) {
        return 'DSP S vs FISSION report ' + pair.codeBytes + ' changed code bytes, expected 0';
      }
      if (pair.identical) return 'DSP S and FISSION came out byte-identical, which contradicts the branding';
      // Their band 4 filter type differs (0 vs 1) while every gain is 0 dB, so
      // the tool must call that inert rather than claim a different tune. The
      // curve on both is flat, and saying otherwise would send someone hunting
      // for a sound difference that is not there.
      if (pair.eqChanged.some(c => c.audible)) {
        return 'a 0 dB filter-shape change was reported as audible';
      }

      // The two jack variants (disable_jack vs jack_GPIO_03) are the same SDK
      // with a different detect pin, so "different code" is the right verdict.
      // They differ by ~12.5 KB of 61.6 KB, which is far more than one pin and
      // is not explained here; an earlier version of this test asserted they
      // shared code, and a later one assumed the delta was tiny. Both
      // assumptions were wrong and the corpus corrected them, so this asserts
      // only what is established: they are distinct, and the differ says so.
      const jv = fwDiff(jackOff, jackOn);
      if (jv.identical) return 'the two jack variants came out identical';
      if (!/different code/.test(jv.verdict)) return 'jack variant verdict was ' + jv.verdict;

      // A genuinely different product must NOT be softened into a relabel.
      const real = fwDiff(rational, jackOff);
      if (real.codeBytes === 0) {
        return 'a KT0211L product and a KT02F20 SDK image report identical code';
      }
      if (!/different code/.test(real.verdict)) return 'verdict was ' + real.verdict;
      if (real.bytes < dspS.length * 0.1) {
        return 'only ' + real.bytes + ' of ' + dspS.length + ' bytes differ between two different parts';
      }
      return true;
    } catch (err) {
      return 'corpus fetch failed: ' + err.message;
    }
  });

  /* ── 19. runtime id survival ──
     The static id check in syntax.cjs only proves an id exists in the
     delivered HTML. It cannot see an id that a render *destroys* — a
     container written with textContent or innerHTML takes its child elements
     with it, so a later reference to one of those children throws. That
     happened once here, and only the running app could show it. This drives
     every view's render and then asks the question the static check cannot. */
  await ta('every id JS references still exists after each view renders', async () => {
    // Collect the ids the app asks for, from the served source, so this
    // covers the real call sites rather than a hand-copied list.
    const src = await (await fetch('/js/app.js')).text()
      + await (await fetch('/js/tools.js')).text()
      + await (await fetch('/js/graph.js')).text();
    const ids = [...new Set([...src.matchAll(/\$\(['"]([\w-]+)['"]\)/g)].map(m => m[1]))];

    const views = ['eq', 'chain', 'device', 'regs', 'fw', 'log'];
    const lost = new Set();
    // Settle on a timer, not requestAnimationFrame: a tab driven over CDP can
    // report itself hidden, which suspends rAF entirely, so waiting on a frame
    // here hangs the suite instead of progressing.
    const settle = () => new Promise(r => setTimeout(r, 60));
    for (const v of views) {
      App.showView(v);
      await settle();
      // Also exercise the render path that rewrites text wholesale — it is the
      // one that can take a child element with it. (Only named renderers the
      // app really exposes are called here; guessing at others would just
      // manufacture failures.)
      if (v === 'fw') { App.renderFirmware(); App.renderFirmwareCompare(); }
      for (const id of ids) {
        if (!document.getElementById(id)) lost.add(v + ': #' + id);
      }
    }
    App.showView('eq');
    if (lost.size) {
      return [...lost].slice(0, 8).join(', ') + (lost.size > 8 ? ' (+' + (lost.size - 8) + ' more)' : '');
    }
    return true;
  });

  /* ── 16. chip identification (js/chips.js) ──
     Identification and capability are separate questions. These tests pin the
     first without ever letting it imply the second. */
  t('the catalogue is populated and sorted longest-name-first', () => {
    const n = Object.keys(CHIP_CATALOG).length;
    if (n < 100) return 'only ' + n + ' chips in the catalogue';
    for (let i = 1; i < CHIP_NAMES_BY_LENGTH.length; i++) {
      if (CHIP_NAMES_BY_LENGTH[i - 1].length < CHIP_NAMES_BY_LENGTH[i].length) {
        return 'not sorted longest-first at index ' + i;
      }
    }
    return true;
  });
  t('a longer chip name wins over its own prefix', () => {
    // 'KT02F2' is a prefix of 'KT02F21' — matching the short one first would
    // name the wrong part, which is the classic substring-matching bug.
    const short = chipFromProduct('KT02F2 SOMETHING');
    const exact = chipFromProduct('KT02F21');
    if (exact.name !== 'KT02F21') return 'KT02F21 matched as ' + exact.name;
    if (short && short.name === 'KT02F21') return 'a bare KT02F2 prefix claimed to be KT02F21';
    return true;
  });
  t('the USB-audio class is exactly the parts this app drives', () => {
    if (!CHIP_USB_CLASS.length) return 'no USB-class parts';
    for (const c of CHIP_USB_CLASS) {
      if (!CHIP_CATALOG[c]) return c + ' is listed as USB class but absent from the catalogue';
      if (!CHIP_CATALOG[c].cls.includes('USB audio')) return c + ' is USB class but classified ' + CHIP_CATALOG[c].cls;
    }
    // and nothing in the catalogue may claim USB class without being listed
    for (const [name, e] of Object.entries(CHIP_CATALOG)) {
      if (e.cls.includes('USB audio') && !CHIP_USB_CLASS.includes(name)) return name + ' omitted from CHIP_USB_CLASS';
    }
    return true;
  });
  t('every catalogued chip is named exactly once', () => {
    const listed = CHIP_NAMES_BY_LENGTH;
    if (listed.length !== Object.keys(CHIP_CATALOG).length) {
      return listed.length + ' names for ' + Object.keys(CHIP_CATALOG).length + ' entries';
    }
    if (new Set(listed).size !== listed.length) return 'duplicate names in CHIP_NAMES_BY_LENGTH';
    return true;
  });
  t('a known USB part resolves to a real profile', () => {
    // FiiO ships the JA11 under 2972:0102, not KTMicro's 31B2:0111. Before the
    // alias table existed this real device fell through to the catch-all guess.
    const p = resolveProfile('FiiO JA11', 0x2972, 0x0102);
    if (p === DEFAULT_PROFILE) return 'a FiiO JA11 fell through to the default profile';
    if (p.name !== 'KT02H20') return 'JA11 resolved to ' + p.name;
    if (!p.bandCount) return 'JA11 profile has no bands';
    return true;
  });
  t('a chip ID outranks the product string', () => {
    // 31B2:0111 is shared by KT0211L, KT02H20 and KT02F20, so only the chip ID
    // can tell them apart. Identity must consult it before the name.
    const byName = resolveProfile('Tanchjim DSP S', 0x31B2, 0x0111);
    if (byName.name !== 'KT0211L') return 'product string gave ' + byName.name;
    const byId = resolveProfile('Tanchjim DSP S', 0x31B2, 0x0111, 'KT02H20B');
    if (byId.name !== 'KT02H20') return 'chip ID was ignored, got ' + byId.name;
    return true;
  });
  t('all three chips sharing 31B2:0111 are reachable by chip ID', () => {
    const expect = { '0211LC02': 'KT0211L', 'KT02H20B': 'KT02H20', '02F20B': 'KT02F20' };
    for (const [id, want] of Object.entries(expect)) {
      const got = resolveProfile('UNDISTINGUISHED NAME', 0x31B2, 0x0111, id);
      if (got.name !== want) return 'chip ID ' + id + ' gave ' + got.name + ', expected ' + want;
    }
    return true;
  });
  t('an ambiguous VID:PID does not invent a chip identity', () => {
    // With no name and no chip ID, 31B2:0111 can only narrow the platform.
    const a = fromVidPid(0x31B2, 0x0111);
    if (a.chip !== null) return 'an ambiguous VID:PID claimed chip ' + a.chip;
    if (a.platform !== 'helios') return 'platform ' + a.platform;
    const b = fromVidPid(0x31B2, 0x1132);
    if (b.chip !== 'KT0231H') return '31B2:1132 gave ' + b.chip;
    return true;
  });
  t('known chip IDs are recognised and unknown ones are not', () => {
    if (chipFromId('KT02H20B')?.name !== 'KT02H20') return 'exact chip ID missed';
    if (chipFromId('TURN2CDC')?.name !== 'KT0210') return 'TURN2CDC missed';
    if (chipFromId('NOTACHIP') !== null) return 'invented a chip from nonsense';
    if (chipFromId('') !== null) return 'an empty chip ID produced a match';
    return true;
  });
  t('a non-USB catalogue part is refused rather than guessed', () => {
    // KT0712 is a USB-to-I2S bridge in the catalogue, not a USB-audio dongle.
    const p = resolveProfile('KT0712 AUDIO', 0x1234, 0x5678);
    if (!p.incompatible) return 'a non-USB part was given a register map';
    // bandCount 0 is the mechanism that disables every control; if it were
    // falsy-overridden the app would offer sliders for registers that do not
    // exist on this part.
    if (p.bandCount !== 0) return 'incompatible profile reports ' + p.bandCount + ' bands';
    return true;
  });
  t('profileBands gives an unreachable part zero bands', () => {
    // The real regression: a "bandCount || ... || 5" fallback treats a
    // deliberate 0 as absent, so the part would get five bands and five live
    // write controls.
    const save = hid.profile;
    try {
      const p = resolveProfile('KT0612', null, null);
      hid.profile = p;
      const made = profileBands();
      if (made.length !== 0) return 'profileBands produced ' + made.length + ' bands';
      if (hid.profile.supportsAdcBank) return 'an unreachable part claims an ADC bank';
      return true;
    } finally { hid.profile = save; }
  });
  t('identify() reports identity without overstating capability', () => {
    const known = identify('FiiO JA11', 0x2972, 0x0102);
    if (known.chip !== 'KT02H20') return 'JA11 identified as ' + known.chip;
    if (!known.exact) return 'JA11 should be an exact profile match';
    const named = identify('KT0235H SOMETHING', 0x0000, 0x0000);
    if (named.chip !== 'KT0235H') return 'KT0235H identified as ' + named.chip;
    // Named in the catalogue but with no verified layout: it must be reported
    // as the guess it is, not dressed up as a profiled part.
    if (!named.profileIsDefault) return 'KT0235H was given a real profile it has not got';
    if (!named.chip) return 'KT0235H was not named';
    const unknown = identify('TOTALLY UNRELATED GADGET', 0, 0);
    if (unknown.chip !== null) return 'invented a chip: ' + unknown.chip;
    if (unknown.evidence !== null) return 'claimed evidence for an unknown device';
    return true;
  });
  t('identify() names the evidence it used', () => {
    // Showing why the tool believes something matters more than the belief.
    if (!/chip ID/.test(identify('X', 0, 0, 'KT02H20B').evidence ?? '')) return 'chip-ID evidence not reported';
    if (!/product string/.test(identify('KT0235H X', 0, 0).evidence ?? '')) return 'product-string evidence not reported';
    if (!/platform only/.test(identify('', 0x31B2, 0x0111).evidence ?? '')) return 'VID:PID reported as more than a platform hint';
    return true;
  });
  t('a non-USB part does not fall through to the Helios default', () => {
    // This is the regression that matters: an unreachable part handed a Helios
    // layout would let a user write to addresses that mean nothing on it.
    const p = resolveProfile('KT0612', null, null);
    if (p === DEFAULT_PROFILE) return 'KT0612 fell through to the Helios default';
    if (p.bandCount !== 0) return 'KT0612 got ' + p.bandCount + ' bands';
    return true;
  });

  /* ── 15. headroom / clipping analysis ──
     The guard is only worth having if it never under-reports: a peak it
     misses is a peak the user is told is safe. These tests therefore compare
     against an independent brute-force scan rather than against the same code
     path they are checking. */
  t('a flat EQ has no peak', () => {
    const p = peakBoost([]);
    return (p.db === 0 && p.hz === 0) || 'db=' + p.db + ' hz=' + p.hz;
  });
  t('a single peaking band peaks at its own gain', () => {
    const b = [{ freq: 1000, gain: 6, q: 1, filterType: 0 }];
    const p = peakBoost(b);
    const atCentre = curveAt(1000, b);
    // the reported value must be the response AT the reported frequency,
    // otherwise the frequency and the number describe different points
    if (Math.abs(curveAt(p.hz, b) - p.db) > 1e-6) return 'db/hz disagree: ' + p.db + ' @ ' + p.hz;
    if (Math.abs(p.db - atCentre) > 0.01) return 'peak ' + p.db.toFixed(3) + ' vs centre ' + atCentre;
    if (Math.abs(p.hz - 1000) > 1) return 'peak at ' + p.hz.toFixed(1) + ' Hz, not 1000';
    return true;
  });
  t('a narrow high-Q peak is not missed between samples', () => {
    // 0.1-octave-wide band: a 1/48-octave grid samples either side of the tip
    // and would read low, which is the exact failure that would make the guard
    // dangerous. Brute force at 400 samples/octave is the reference.
    const b = [{ freq: 1000, gain: 12, q: 10, filterType: 0 }];
    const p = peakBoost(b);
    let ref = -Infinity, refHz = 0;
    for (let f = 20; f <= 20000; f *= Math.pow(2, 1 / 400)) {
      const v = curveAt(f, b);
      if (v > ref) { ref = v; refHz = f; }
    }
    if (p.db < ref - 0.05) return 'under-reports: ' + p.db.toFixed(3) + ' < reference ' + ref.toFixed(3);
    if (Math.abs(p.hz - refHz) / refHz > 0.01) return 'peak freq ' + p.hz.toFixed(1) + ' vs ' + refHz.toFixed(1);
    return true;
  });
  t('overlapping bands sum at the peak', () => {
    const b = [
      { freq: 1000, gain: 3, q: 1, filterType: 0 },
      { freq: 1000, gain: 3, q: 1, filterType: 0 },
    ];
    const p = peakBoost(b);
    return (Math.abs(p.db - 6) < 0.01) || 'peak ' + p.db.toFixed(3) + ', expected 6';
  });
  t('a low shelf peaks at full gain down at DC', () => {
    const b = [{ freq: 200, gain: 4, q: 0.7, filterType: 1 }];
    const p = peakBoost(b);
    return (Math.abs(p.db - 4) < 0.05 && p.hz < 200) || 'db=' + p.db.toFixed(2) + ' hz=' + p.hz.toFixed(0);
  });
  t('a cut-only curve suggests no trim', () => {
    const b = [{ freq: 1000, gain: -6, q: 1, filterType: 0 }];
    const t2 = suggestedTrim(b);
    return (t2 === 0) || 'trim=' + t2;
  });
  t('the suggested trim brings the peak under 0 dBFS with margin', () => {
    const b = [
      { freq: 100, gain: 6, q: 0.7, filterType: 1 },
      { freq: 1000, gain: 12, q: 10, filterType: 0 },
      { freq: 8000, gain: 4, q: 0.7, filterType: 2 },
    ];
    const trim = suggestedTrim(b);
    if (trim >= 0) return 'a clipping curve produced a non-negative trim: ' + trim;
    const after = peakBoost(b).db + trim;
    // After taking the guard's own advice the peak must be under 0 dBFS, or
    // the user would clip anyway.
    if (after > 0.001) return 'after trim the peak is still ' + after.toFixed(3) + ' dB';
    // It should land exactly on the designed margin and no further: the margin
    // is there to cover host volume and DAC filtering, and quietly trimming
    // past it would cost the user level they did not ask to lose.
    if (after < -(HEADROOM_DEFAULT.marginDb + 0.01)) {
      return 'over-trimmed to ' + after.toFixed(3) + ' dB, past the ' + HEADROOM_DEFAULT.marginDb + ' dB margin';
    }
    return true;
  });
  t('the headroom chip reflects the curve', () => {
    const chip = $('eq-headroom');
    if (!chip) return 'no #eq-headroom';
    /* state.bands is a getter over state.banks[state.bank], so assigning to it
       is a silent no-op — these tests have to write through the bank. */
    const bank = state.bank;
    const save = JSON.parse(JSON.stringify(state.banks[bank]));
    const saveFlags = state.flags;
    try {
      state.flags = {};
      state.banks[bank] = [
        { freq: 1000, gain: 0, q: 1, filterType: 0, index: 0 },
        { freq: 1000, gain: 9, q: 1, filterType: 0, index: 1 },
      ];
      App.updateHeadroom();
      const over = chip.dataset.state;
      const trimDisabled = $('btn-eq-trim').disabled;
      state.banks[bank] = [
        { freq: 1000, gain: 0, q: 1, filterType: 0, index: 0 },
        { freq: 1000, gain: -3, q: 1, filterType: 0, index: 1 },
      ];
      App.updateHeadroom();
      const under = chip.dataset.state;
      const trimEnabled = !$('btn-eq-trim').disabled;
      if (over !== 'over') return 'a +9 dB peak reported as ' + over;
      if (trimDisabled) return 'trim stayed disabled while clipping';
      if (under !== 'ok' && under !== 'warn') return 'a -3 dB peak reported as ' + under;
      // with no clipping risk there is nothing to trim, so the action must go
      // away — an always-enabled "fix" teaches the user to ignore it
      if (trimEnabled) return 'trim stayed enabled with no clipping risk';
      return true;
    } finally {
      state.banks[bank] = save; state.flags = saveFlags; App.updateHeadroom();
    }
  });
  t('a muted band stops counting toward the peak', () => {
    const bank = state.bank;
    const save = JSON.parse(JSON.stringify(state.banks[bank]));
    const saveFlags = state.flags;
    try {
      state.banks[bank] = [
        { freq: 1000, gain: 0, q: 1, filterType: 0, index: 0 },
        { freq: 1000, gain: 10, q: 1, filterType: 0, index: 1 },
      ];
      state.flags = { 0: { muted: false }, 1: { muted: false } };
      App.updateHeadroom();
      if ($('eq-headroom').dataset.state !== 'over') return 'unmuted boost not reported';
      // Muting it must clear the warning: a muted band is not written, so it
      // adds nothing to the signal and the headroom it consumed is not real.
      state.flags = { 0: { muted: false }, 1: { muted: true } };
      App.updateHeadroom();
      if ($('eq-headroom').dataset.state === 'over') return 'muted band still counted toward the peak';
      return true;
    } finally {
      state.banks[bank] = save; state.flags = saveFlags; App.updateHeadroom();
    }
  });

  /* ── 14. BOOT packet construction ── */
  t('BOOT meta block matches the documented header layout', () => {
    const m = BOOT.makeMeta('KT0231H', 61632);
    const dv = new DataView(m.buffer);
    const all = String.fromCharCode(...Array.from(m).map(b => (b >= 32 && b < 127 ? b : 32)));
    return (all.startsWith('KT0231H') && all.includes('Size') && dv.getUint32(0x0C, true) === 61632
      && all.includes('ENTY') && dv.getUint32(0x64, true) === 0x8B000 && dv.getUint32(0x68, true) === 0x8B000)
      || 'meta: ' + JSON.stringify({ head: all.slice(0, 24), size: dv.getUint32(0x0C, true), enty: dv.getUint32(0x64, true) });
  });
  t('BOOT signature carries a real CRC-32', () => {
    const data = new TextEncoder().encode('KTMicro');
    const sig = BOOT.makeSig('X', data);
    const got = new DataView(sig.buffer).getUint32(16, true);
    // Independent reference: bit-at-a-time, built from a fresh accumulator
    let c = 0xFFFFFFFF;
    for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const want = (c ^ 0xFFFFFFFF) >>> 0;
    return want === got || 'crc ' + want.toString(16) + ' vs ' + got.toString(16);
  });

  /* ── 20. write-trust badge ───────────────────────────────────────────── */
  t('every profile declares a confidence tier', () => {
    const missing = Object.entries(PROFILES)
      .filter(([, p]) => !CONFIDENCE[p.confidence])
      .map(([k]) => k);
    if (missing.length) return 'no valid tier: ' + missing.join(', ');
    if (!CONFIDENCE[DEFAULT_PROFILE.confidence]) return 'the default profile has no tier';
    if (DEFAULT_PROFILE.confidence !== 'guess') {
      return 'the untargeted default claims ' + DEFAULT_PROFILE.confidence + ' rather than guess';
    }
    return true;
  });
  t('only hardware-dumped parts claim verified', () => {
    // Roster state and profile confidence are two records of the same fact.
    // If a part is only "expected" but its profile says "verified", the badge is
    // making a stronger claim than the evidence supports - the one failure mode
    // that actually matters here.
    const claimed = Object.values(PROFILES).filter(p => p.confidence === 'verified').map(p => p.name);
    const notVerified = ROSTER.filter(r => r.state !== 'verified').map(r => r.name);
    const overreach = claimed.filter(n => notVerified.includes(n));
    if (overreach.length) return 'claims verified without a dump: ' + overreach.join(', ');
    if (!claimed.length) return 'nothing is verified, which cannot be right';
    return true;
  });
  t('the trust badge follows the selected profile', () => {
    const box = $('write-trust');
    if (!box) return 'the badge element is missing';
    const seen = new Set();
    for (const name of ['KT0231H', 'KT02F20', 'KT02H22']) {
      const p = PROFILES[name];
      if (!p) return name + ' has no profile';
      App.setConfidenceBadge(p);
      if (box.dataset.tier !== p.confidence) {
        return name + ' showed tier ' + box.dataset.tier + ', expected ' + p.confidence;
      }
      if (!/verified|inferred|guess/.test(box.textContent)) return name + ' badge reads ' + box.textContent;
      seen.add(box.dataset.tier);
    }
    // The generic fallback must never be presented as trustworthy.
    App.setConfidenceBadge(DEFAULT_PROFILE);
    if (box.dataset.tier !== 'guess') return 'the fallback profile was not labelled a guess';
    // A refusal has no map to trust, and must not borrow a tier.
    App.setConfidenceBadge({ incompatible: true, chip: 'KT0612' });
    if (box.dataset.tier !== 'none') return 'an unreachable part was given a trust tier';
    if (!/unreachable/.test(box.textContent)) return 'an unreachable part did not say so';
    if (seen.size < 2) return 'the profiles produced no distinct tiers, so the badge is not discriminating';
    App.setConfidenceBadge(hid.profile || DEFAULT_PROFILE);
    return true;
  });
  t('an incompatible part cannot borrow a layout', () => {
    const p = INCOMPATIBLE_PROFILE({ name: 'KT0612', cls: 'mnwx_98', products: 1 });
    if (p.bandCount !== 0) return 'bandCount is ' + p.bandCount + ', expected 0';
    if (!p.incompatible) return 'the refusal is not flagged';
    if (p.reg && p.reg.EQ_DAC !== undefined) return 'a refused part still carries a DAC base';
    return true;
  });

  /* ── 13. identity encoding ── */
  t('USB string packing is LE32 and length-bounded', () => {
    const regs = Identity.packAsciiRegs('ABCDEFGH', 8);
    return (regs.length === 2 && regs[0] === 0x44434241 && regs[1] === 0x48474645)
      || regs.map(r => r.toString(16)).join(',');
  });
  t('short strings zero-pad rather than spill', () => {
    const regs = Identity.packAsciiRegs('AB', 7);
    return (regs.length === 2 && regs[0] === 0x00004241 && regs[1] === 0) || regs.map(r => r.toString(16)).join(',');
  });
  t('the A-register heuristic only accepts sane band values', () => {
    const okCase  = Identity.looksLikeBand((1000 << 16) | 60 >>> 0);
    const badFreq = Identity.looksLikeBand((5 << 16) | 0 >>> 0);
    const badGain = Identity.looksLikeBand((1000 << 16) | 9000 >>> 0);
    return (okCase && !badFreq && !badGain) || 'heuristic wrong';
  });

  /* ── 14. DRC encoding ── */
  t('the 256+dB threshold encoding round-trips at 1 dB granularity', () => {
    for (let db = -96; db <= -1; db++) {
      if (thrDb(thrByte(db)) !== db) return db + ' dB came back as ' + thrDb(thrByte(db));
    }
    return true;
  });
  t('the DRC sliders are 1 dB steps, matching the byte', () => {
    const steps = ['ng-th', 'ng-gv', 'lim-th'].map(id => document.getElementById(id).step);
    return steps.every(s => s === '1') || 'steps: ' + steps.join(',');
  });
  t('thresholds saturate rather than wrap', () => {
    return (thrByte(0) === 255 && thrByte(5) === 255 && thrByte(-300) === 0)
      || [thrByte(0), thrByte(5), thrByte(-300)].join('/');
  });

  /* Collect the async queue here, after every test has registered and
     immediately before the tally. It used to sit mid-file, which silently
     discarded every ta() registered below that line — an async test written
     further down was never asserted and never counted, so the total stayed
     green. The tally is the only safe place: nothing can register after it. */
  AQ.forEach(([n, v]) => (v === true ? ok(n) : bad(n, v)));

  const pass = R.filter(r => r.pass).length;
  return JSON.stringify({ pass, total: R.length, fails: R.filter(r => !r.pass) }, null, 1);
})()`;

(async () => {
  /* The suite body above is a single template literal, so a stray backtick in
     any test message silently terminates it and the file stops parsing — which
     has happened three times, each time surfacing as a syntax error pointing at
     an unrelated line. This check runs on the Node side, before anything is
     sent to the browser, and names the problem directly. The character is
     written as a code point because naming it literally would be the bug. */
  {
    const tick = String.fromCharCode(96);
    let n = 0;
    for (const ch of TEST) if (ch === tick) n++;
    if (n !== 0) {
      console.log(`TEST body holds ${n} backticks; it must hold none.`);
      console.log('A backtick inside a test message or comment closes the template literal.');
      process.exit(1);
    }
  }
  const list = await (await fetch(`${HOST}/json/list`)).json();
  const t = list.find(x => x.type === 'page' && x.url.includes('8731')) || list.find(x => x.type === 'page');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const send = rpc(ws);
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8731/' });
  await new Promise(r => setTimeout(r, 2200));
  const r = await send('Runtime.evaluate', {
    expression: TEST, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    console.log('THREW:', r.exceptionDetails.text, r.exceptionDetails.exception?.description);
    ws.close();
    process.exit(1);
  } else {
    const out = JSON.parse(r.result.value);
    console.log(`\n${out.pass}/${out.total} assertions passed`);
    if (out.fails.length) {
      console.log('\nFAILURES:');
      out.fails.forEach(f => console.log(`  ✕ ${f.n}\n      ${f.d}`));
    } else console.log('all green');
    /* The exit code is what run-tests.ps1 reads. Without it this script only
       ever *reported* failures while still exiting 0, so the suite printed
       "all suites passed" on a red run — a false green that hides exactly the
       regressions this suite exists to catch. */
    ws.close();
    process.exit(out.fails.length ? 1 : 0);
  }
})();
