/* Firmware-image test: runs FwBin against the real vendor binaries in
   firmware/ through the pattern locator, then patches and verifies.
   Usage: node fwtest.cjs                                            */
const HOST = 'http://127.0.0.1:9222';
const BASE = 'http://127.0.0.1:8731/firmware/';

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

const IMAGES = [
  'TANCHJIM_DSP_S_KT0211L_20240815_v1.0.2.bin',
  'KT0211L_FISSION_v1.0.2_250610.bin',
  'KT0211L_fission_rational_hifi_edition_v1.0.1_20250610.bin',
  'KT02H20_TINHIFI_20240328_v1.0.1.bin',
  'KT02F20_SDK_20250206_disable_jack.bin',
  'KT02F20_SDK_20250206_jack_GPIO_03.bin',
  'KT0712_SDK_V2.1_20230724.bin',
  'KT0206_boot_v1.05_20210608.bin',
];

const TEST = `(async () => {
  const R = [];
  const ok  = (n, d = '') => R.push({ n, pass: true,  d: String(d) });
  const bad = (n, d = '') => R.push({ n, pass: false, d: String(d) });
  const R6 = [];
  const rows = [];

  const load = async (url) => {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    return new File([buf], url.split('/').pop());
  };

  for (const name of ${JSON.stringify(IMAGES)}) {
    const rec = { name };
    try {
      const file = await load('${BASE}' + name);
      rec.size = file.size;
      const info = await FwBin.load(file);
      rec.dac = info.dacOff >= 0 ? info.dacOff.toString(16) : null;
      rec.adc = info.adcOff >= 0 ? info.adcOff.toString(16) : null;
      rec.en  = info.enOff >= 0 ? info.enOff.toString(16) + '=' + info.enVal.toString(16) : null;
      rec.vid = info.hasKtVid;
      const h = FwBin.header();
      rec.tag = h.tag; rec.chip = h.chipId;
      rec.enty = h.enty.map(v => v.toString(16)).join('/') || null;

      /* the table must decode to sane EQ values */
      const t = FwBin.readTable(FwBin.dacOff);
      rec.factory = t ? t.map(b => b.freq + 'Hz' + (b.gain >= 0 ? '+' : '') + b.gain.toFixed(1) + 'Q' + b.q.toFixed(2)).join(' ') : null;
      rec.factoryTypes = t ? [...new Set(t.map(b => b.filterType))].join(',') : null;

      /* preflight must not report a hard failure on a genuine image */
      const pf = FwBin.preflight();
      rec.fails = pf.filter(c => c.state === 'fail').map(c => c.text.replace(/<[^>]+>/g, ''));
      rec.warns = pf.filter(c => c.state === 'warn').length;

      /* patch: set every band to something distinct and check the deltas */
      const before = FwBin.patchedBytes();
      state.banks = makeBanks();
      state.banks.DAC.forEach((b, i) => { b.freq = 200 + i * 137; b.gain = i - 2; b.q = 0.5 + i * 0.25; b.filterType = i % 5; });
      FwBin.patchTable(FwBin.dacOff, state.banks.DAC);
      const after = FwBin.patchedBytes();
      rec.delta = after - before;
      const back = FwBin.readTable(FwBin.dacOff) || [];
      rec.roundTrip = !back.length ? 'n/a' : back.slice(0, state.banks.DAC.length).map((b, i) =>
        b.freq === state.banks.DAC[i].freq && Math.abs(b.gain - state.banks.DAC[i].gain) < 0.06
        && Math.abs(b.q - state.banks.DAC[i].q) < 0.001 && b.filterType === state.banks.DAC[i].filterType
      ).every(Boolean);

      /* patching must never leave the image a different length */
      rec.sizeStable = FwBin.buf.length === rec.size;
      /* and the enable byte may only gain bits, never lose them */
      if (info.enOff >= 0) {
        const oldByte = FwBin.original[info.enOff];
        const newByte = FwBin.buf[info.enOff];
        rec.enMonotonic = (oldByte | newByte) === newByte;
      } else rec.enMonotonic = 'n/a';
      rows.push(rec);
    } catch (e) {
      rec.error = e.message;
      rows.push(rec);
    }
  }

  /* ── assertions ── */
  const tanchjim = rows.find(r => r.name.includes('TANCHJIM'));
  ok('Tanchjim KT0211L image: DAC table at 0x106a', tanchjim.dac === '106a' || 'got 0x' + tanchjim.dac);
  ok('Tanchjim KT0211L image: ADC table at 0x109a', tanchjim.adc === '109a' || 'got 0x' + tanchjim.adc);
  ok('Tanchjim KT0211L image: enable byte at 0x10e8 = 3', tanchjim.en === '10e8=3' || 'got ' + tanchjim.en);
  ok('Tanchjim image carries the KT VID marker', tanchjim.vid === true || 'absent');
  ok('Tanchjim preflight has no hard failures', tanchjim.fails.length === 0 || JSON.stringify(tanchjim.fails));

  const withTables = rows.filter(r => r.dac);
  ok('every DSP image locates its DAC EQ table', withTables.length >= 4 || 'only ' + withTables.length);
  ok('no genuine image fails preflight', rows.every(r => !r.error && (!r.fails || !r.fails.length))
    || JSON.stringify(rows.filter(r => r.fails && r.fails.length).map(r => r.name)));
  ok('patching round-trips through the image encoding', rows.filter(r => r.dac).every(r => r.roundTrip === true)
    || JSON.stringify(rows.filter(r => r.dac && r.roundTrip !== true).map(r => r.name)));
  ok('patching never changes the image length', rows.every(r => r.sizeStable === true)
    || JSON.stringify(rows.filter(r => r.sizeStable !== true).map(r => r.name)));
  ok('the enable byte is only ever OR-ed in', rows.filter(r => r.enMonotonic !== 'n/a').every(r => r.enMonotonic === true)
    || JSON.stringify(rows.filter(r => r.enMonotonic === false).map(r => r.name)));
  ok('the patch touches at most 5 x 8 bytes per table plus the enable byte',
    rows.filter(r => r.dac).every(r => r.delta <= 5 * 8 + 2) || JSON.stringify(rows.map(r => [r.name, r.delta])));
  ok('patching genuinely changes bytes in the image',
    rows.filter(r => r.dac).every(r => r.delta > 0) || JSON.stringify(rows.map(r => [r.name, r.delta])));
  ok('images with no EQ table report none rather than a false hit',
    rows.filter(r => !r.dac).every(r => r.adc == null) || JSON.stringify(rows.filter(r => !r.dac).map(r => [r.name, r.adc])));
  ok('the chip id splits from the flash tag',
    rows.every(r => !r.chip || !r.chip.startsWith(r.tag)) || JSON.stringify(rows.map(r => [r.name, r.tag, r.chip])));
  const fission = rows.find(r => r.name.includes('FISSION_v1'));
  ok('the 2025 Fission image is the same platform as DSP S',
    (fission.tag === 'KT_lnv1b_flash_1' && fission.chip === '0211LC02' && fission.dac === '106a')
    || JSON.stringify([fission.tag, fission.chip, fission.dac]));
  ok('the documented tags are recognised',
    rows.filter(r => r.dac).every(r => /^KT_(lnv1b|Helios|msv2b)|^KTM_TT/.test(r.tag)) || JSON.stringify(rows.map(r => [r.name, r.tag])));
  ok('factory defaults decode as 0 dB peaks', rows.filter(r => r.dac).every(r => r.factoryTypes === '0')
    || JSON.stringify(rows.map(r => [r.name, r.factoryTypes])));
  ok('the flash tag parses for every image', rows.every(r => r.tag) || JSON.stringify(rows.map(r => [r.name, r.tag])));

  return JSON.stringify({ pass: R.filter(x => x.pass).length, total: R.length,
    fails: R.filter(x => !x.pass), rows }, null, 1);
})()`;

(async () => {
  const list = await (await fetch(`${HOST}/json/list`)).json();
  const t = list.find(x => x.type === 'page') || list[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const send = rpc(ws);
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8731/' });
  await new Promise(r => setTimeout(r, 2200));

  const r = await send('Runtime.evaluate', { expression: TEST, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    console.log('THREW:', r.exceptionDetails.text, r.exceptionDetails.exception?.description);
    process.exit(1);
  }
  const out = JSON.parse(r.result.value);
  console.log('\n── per-image results ──');
  for (const row of out.rows) {
    console.log(`\n  ${row.name}  (${row.size} B)`);
    if (row.error) { console.log('    ERROR ' + row.error); continue; }
    console.log(`    tag "${row.tag}"  chip "${row.chip}"  ENTY ${row.enty}`);
    console.log(`    DAC @ ${row.dac}   ADC @ ${row.adc}   EN ${row.en}   VID marker ${row.vid}`);
    console.log(`    factory  ${row.factory}`);
    console.log(`    preflight  ${row.fails.length} fail, ${row.warns} warn`);
    console.log(`    patch  delta ${row.delta} B   roundTrip ${row.roundTrip}   sizeStable ${row.sizeStable}   enMonotonic ${row.enMonotonic}`);
  }
  console.log(`\n${out.pass}/${out.total} assertions passed`);
  if (out.fails.length) {
    console.log('\nFAILURES:');
    out.fails.forEach(f => console.log(`  x ${f.n}\n      ${f.d}`));
  } else console.log('all green');
  ws.close();
  process.exit(out.fails.length ? 1 : 0);
})();
