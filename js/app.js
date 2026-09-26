/* ═══════════════════════════════════════════════════════════════════════
   KTLAB · js/app.js — the interface.
   Loaded last. Owns: the view router, band cards, snapshots, presets, the
   command palette, keyboard handling, settings, the connect flow, and all
   DOM wiring. Reads state and services from the three files above it and
   adds no protocol knowledge of its own.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const VIEWS = ['eq', 'chain', 'device', 'regs', 'fw', 'log'];
const SNAP_KEY = 'ktlab-snapshots-v1';
const VIEW_KEY = 'ktlab-view';

const hid = new HIDController();

const App = {
  view: 'eq',
  _autoSendTimers: {},
  _snapLoaded: -1,

  /* ══════════ VIEW ROUTER ══════════ */
  showView(name) {
    if (!VIEWS.includes(name)) name = 'eq';
    this.view = name;
    VIEWS.forEach(v => $('view-' + v)?.classList.toggle('is-active', v === name));
    $$('.rail-btn[data-view]').forEach(b => {
      const on = b.dataset.view === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $('stage').scrollTop = 0;
    try { localStorage.setItem(VIEW_KEY, name); } catch { /* private mode */ }
    if (name === 'log') Log.paint();
    if (name === 'eq') Graph.request();
  },

  updateQueueBadge(n) {
    const b = $('queue-badge');
    if (!b) return;
    b.textContent = n > 0 ? `${n} queued` : '';
    b.hidden = n <= 0;
  },

  /* ══════════ BAND CARDS ══════════ */
  buildBands() {
    const host = $('eq-bands');
    if (!host || !state.bands) return;
    const p = hid.profile;
    host.replaceChildren();

    state.bands.forEach((band, i) => {
      const f = bandFlag(i);
      const card = el('div', 'band');
      card.id = 'band-' + i;

      const tools = el('div', 'band-tools');
      const mkTool = (act, glyph, title) => {
        const b = el('button', 'band-tool', glyph);
        b.dataset.act = act;
        b.dataset.band = i;
        b.title = title;
        b.type = 'button';
        return b;
      };
      tools.append(
        mkTool('mute', 'M', 'Mute — drop this band from the curve and from writes'),
        mkTool('solo', 'S', 'Solo — dim the other bands on the graph'),
        mkTool('reset', '↺', 'Reset this band to the profile default'),
        mkTool('left', '‹', 'Swap with the band to its left'),
        mkTool('right', '›', 'Swap with the band to its right'),
      );

      const fader = el('div', 'fader');
      const slider = el('input');
      slider.type = 'range';
      slider.className = 'vslider';
      slider.id = 'bs-' + i;
      slider.min = p.gainRange.min;
      slider.max = p.gainRange.max;
      slider.step = '0.5';
      slider.value = band.gain;
      slider.setAttribute('aria-label', `band ${i + 1} gain in dB`);
      slider.addEventListener('input', () => {
        band.gain = parseFloat(slider.value);
        this.refreshBand(i);
        Graph.request();
        this.queueBandWrite(i);
      });
      fader.appendChild(slider);

      const gain = el('div', 'band-gain');
      gain.id = 'bgv-' + i;

      const fields = el('div', 'band-fields');
      const mkField = (label, node) => {
        const wrap = el('div');
        wrap.appendChild(el('label', null, label));
        wrap.appendChild(node);
        fields.appendChild(wrap);
        return node;
      };
      const fIn = el('input', 'input band-freq-in');
      fIn.id = 'bf-' + i;
      fIn.type = 'number';
      fIn.min = F_MIN; fIn.max = F_MAX; fIn.step = '1';
      fIn.value = band.freq;
      fIn.addEventListener('change', () => {
        band.freq = clamp(parseInt(fIn.value, 10) || 1000, F_MIN, F_MAX);
        this.refreshBand(i);
        this.markDirty(i);
        Graph.request();
        this.queueBandWrite(i);
      });

      const qIn = el('input', 'input');
      qIn.id = 'bq-' + i;
      qIn.type = 'number';
      qIn.min = p.qRange.min; qIn.max = p.qRange.max; qIn.step = '0.05';
      qIn.value = band.q.toFixed(2);
      qIn.addEventListener('change', () => {
        band.q = clamp(parseFloat(qIn.value) || 1, p.qRange.min, p.qRange.max);
        this.refreshBand(i);
        this.markDirty(i);
        Graph.request();
        this.queueBandWrite(i);
      });

      const typeIn = el('select', 'input');
      typeIn.id = 'bft-' + i;
      typeIn.title = 'Filter shape — 0 Peak, 1 low pass, 2 high pass, 3 low shelf, 4 high shelf';
      FILTER_TYPES.forEach(t => {
        const o = el('option', null, t.label);
        o.value = t.value;
        typeIn.appendChild(o);
      });
      typeIn.value = band.filterType;
      typeIn.addEventListener('change', () => {
        band.filterType = parseInt(typeIn.value, 10) || 0;
        this.markDirty(i);
        Graph.request();
        this.queueBandWrite(i);
      });

      mkField('Hz', fIn);
      mkField('Q', qIn);
      mkField('shape', typeIn);

      const actions = el('div', 'band-actions');
      const send = el('button', 'btn btn-secondary btn-sm', 'Send');
      send.title = `Write band ${i + 1} to ${hex(eqBase() + i * hid.reg('EQ_STRIDE'))} and +1`;
      send.addEventListener('click', () => sendBand(i, true));
      actions.appendChild(send);

      const top = el('div', 'band-top');
      top.appendChild(el('span', 'band-num', String(i + 1)));
      top.appendChild(tools);
      card.append(top, fader, gain, fields, actions);
      host.appendChild(card);
    });

    this.refreshBandTools();
    this.refreshAllBands();
  },

  markDirty(i) {
    $(`band-${i}`)?.classList.add('is-dirty');
    $(`band-${i}`)?.querySelector('.band-num')?.classList.add('is-dirty');
  },
  markClean(i) {
    $(`band-${i}`)?.classList.remove('is-dirty');
  },

  /** Push one band value into its card without disturbing the fader. */
  refreshBand(i) {
    const b = state.bands?.[i];
    if (!b) return;
    const card = $(`band-${i}`);
    if (!card) return;
    const f = bandFlag(i);
    const hue = f.muted ? 'transparent' : b.gain > 0.05 ? 'var(--boost)' : b.gain < -0.05 ? 'var(--cut)' : 'var(--text-3)';
    card.style.setProperty('--band-hue', hue);
    card.classList.toggle('is-muted', f.muted);
    card.classList.toggle('is-focus', this._focusBand === i);
    const s = $('bs-' + i);
    if (s && document.activeElement !== s) s.value = b.gain;
    const g = $('bgv-' + i);
    if (g) g.textContent = sgn(b.gain) + ' dB';
    const fq = $('bf-' + i);
    if (fq && document.activeElement !== fq) fq.value = b.freq;
    const q = $('bq-' + i);
    if (q && document.activeElement !== q) q.value = b.q.toFixed(2);
    const t = $('bft-' + i);
    if (t) t.value = b.filterType;
  },

  refreshAllBands() { state.bands?.forEach((_, i) => this.refreshBand(i)); },

  refreshBandTools() {
    $$('#eq-bands .band-tool').forEach(btn => {
      const i = +btn.dataset.band;
      const f = bandFlag(i);
      const n = state.bands.length;
      btn.classList.toggle('is-on',
        (btn.dataset.act === 'mute' && f.muted) ||
        (btn.dataset.act === 'solo' && f.solo));
      btn.classList.toggle('is-off',
        (btn.dataset.act === 'mute' && f.muted) ||
        (btn.dataset.act === 'solo' && f.solo));
      if (btn.dataset.act === 'left')  btn.disabled = i === 0;
      if (btn.dataset.act === 'right') btn.disabled = i === n - 1;
    });
    this._focusBand = -1;
  },

  /* ══════════ BAND ACTIONS ══════════ */
  onBandTool(e) {
    const btn = e.target.closest('.band-tool');
    if (!btn) return;
    const i = +btn.dataset.band;
    const b = state.bands[i];
    if (!b) return;
    const f = bandFlag(i);

    switch (btn.dataset.act) {
      case 'mute':
        f.muted = !f.muted;
        log(`Band ${i + 1} ${f.muted ? 'muted' : 'unmuted'} locally — it is ${f.muted ? 'excluded' : 'back in'} the curve and the write set.`, 'warn');
        break;
      case 'solo':
        const anyOther = state.bands.some((_, j) => j !== i && bandFlag(j).solo);
        state.bands.forEach((_, j) => { bandFlag(j).solo = anyOther ? false : j === i; });
        break;
      case 'reset':
        History.push('band reset');
        b.gain = 0;
        b.freq = hid.profile.defaultFreqs[i] ?? 1000;
        b.q = hid.profile.defaultQ ?? 1;
        b.filterType = 0;
        break;
      case 'left':
      case 'right': {
        const j = btn.dataset.act === 'left' ? i - 1 : i + 1;
        if (j < 0 || j >= state.bands.length) return;
        History.push('band swap');
        const tmp = { ...state.bands[i] };
        state.bands[i] = { ...state.bands[j], index: i };
        state.bands[j] = { ...tmp, index: j };
        state.banks[state.bank] = state.bands;
        this.buildBands();
        toast(`Swapped bands ${i + 1} and ${j + 1} — Write all to push the order to the device.`, 'info', 4200);
        break;
      }
    }
    this.refreshAllBands();
    this.refreshBandTools();
    this.markDirty(i);
    Graph.request();
  },

  queueBandWrite(i) {
    if (!Settings.data.autoSend || !hid.connected) return;
    clearTimeout(this._autoSendTimers[i]);
    this._autoSendTimers[i] = setTimeout(() => sendBand(i, false), 220);
  },

  /* ══════════ BANK + EQ TOGGLES ══════════ */
  updateBankToggle() {
    const wrap = $('bank-toggle');
    if (wrap) wrap.hidden = !hasAdcBank();
    $('btn-bank-dac')?.classList.toggle('is-on', state.bank === 'DAC');
    $('btn-bank-adc')?.classList.toggle('is-on', state.bank === 'ADC');
    const t = $('eq-section-title');
    if (t) t.textContent = `Parametric EQ — ${state.bank} bank`;
  },

  updateEqToggles() {
    const on = !!state.eqEnabled[state.bank];
    $('btn-eq-on')?.classList.toggle('is-on', on);
    $('btn-eq-off')?.classList.toggle('is-on', !on);
  },

  updateHistoryButtons() {
    $('btn-undo').disabled = !History.canUndo();
    $('btn-redo').disabled = !History.canRedo();
  },

  /* ══════════ GAINS ══════════ */
  refreshGainUI() {
    const set = (id, val) => { const n = $(id); if (n && document.activeElement !== n) n.value = val; };
    set('global-gain', state.globalGain);
    set('dig-dac-r', state.globalGainR);
    set('dig-adc', state.digADC);
    $('global-gain-val').textContent = sgn(state.globalGain) + ' dB';
    $('dig-dac-r-val').textContent = sgn(state.globalGainR) + ' dB';
    $('dig-adc-val').textContent = sgn(state.digADC) + ' dB';
    const pa = $('pga-adc'); if (pa) pa.value = state.pgaADC;
    const pd = $('pga-dac'); if (pd) pd.value = state.pgaDAC;
  },

  syncLabels(which) {
    if (which === 'ng' || !which) {
      $('ng-th-val').textContent = `${$('ng-th').value} dB`;
      $('ng-gv-val').textContent = `${$('ng-gv').value} dB`;
    }
    if (which === 'lim' || !which) $('lim-th-val').textContent = `${$('lim-th').value} dB`;
  },

  async writeDigDac(db) {
    const addr = hid.reg('DIG_DAC');
    const raw = await readRegister(addr);
    const l = encodeDigGain(db);
    const r = encodeDigGain(db === state.globalGain ? state.globalGainR : state.globalGainR);
    await writeRegister(addr, ((raw & 0xFF000000) | (r << 8) | l) >>> 0);
  },

  /* ══════════ SNAPSHOTS ══════════ */
  loadSnaps() {
    try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch { return []; }
  },
  saveSnaps(list) {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(list)); } catch { /* private mode */ }
  },

  renderSnaps() {
    const host = $('snap-list');
    if (!host) return;
    const snaps = this.loadSnaps();
    host.replaceChildren();
    const labels = ['A', 'B', 'C', 'D'];
    for (let i = 0; i < 4; i++) {
      const s = snaps[i];
      const chip = el('button', 'snap' + (s ? ' is-filled' : '') + (this._snapLoaded === i ? ' is-loaded' : ''));
      chip.type = 'button';
      chip.appendChild(el('span', 'snap-key', labels[i]));
      if (s) {
        const cv = el('canvas');
        cv.width = 108; cv.height = 30;
        cv.style.width = '108px'; cv.style.height = '30px';
        chip.appendChild(cv);
        const meta = el('span', 'snap-meta', `${Object.keys(s.banks).join('+')} · ${new Date(s.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        chip.appendChild(meta);
        chip.title = `${s.profile || '?'} — click to restore, shift-click to overwrite`;
        requestAnimationFrame(() => drawSparkline(cv, s.banks.DAC || [], this._snapLoaded === i));
      } else {
        chip.appendChild(el('span', 'snap-name', 'empty'));
        chip.appendChild(el('span', 'snap-meta', 'shift-click a slot to store'));
      }
      chip.addEventListener('click', e => {
        if (e.shiftKey || !s) { this.captureSnap(i); return; }
        this.restoreSnap(i);
      });
      chip.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!s) return;
        const list = this.loadSnaps(); list[i] = null; this.saveSnaps(list);
        this.renderSnaps();
      });
      host.appendChild(chip);
    }
  },

  captureSnap(i) {
    const list = this.loadSnaps();
    list[i] = snapshotState();
    this.saveSnaps(list);
    this._snapLoaded = i;
    this.renderSnaps();
    log(`Snapshot ${'ABCD'[i]} captured.`, 'ok');
    toast(`Captured into slot ${'ABCD'[i]}.`, 'ok', 2000);
  },

  restoreSnap(i) {
    const s = this.loadSnaps()[i];
    if (!s) return;
    const entry = Presets.normalise(s);
    if (!entry) { toast(`Slot ${'ABCD'[i]} is not a valid state.`, 'warn'); return; }
    applyState(entry, { label: 'snapshot restore' });
    this._snapLoaded = i;
    this.renderSnaps();
    this.markAllDirty();
    Graph.request();
    toast(`Restored slot ${'ABCD'[i]} locally. Write all to push it to the device.`, 'info', 4200);
    log(`Snapshot ${'ABCD'[i]} restored.`);
  },

  markAllDirty() {
    state.bands?.forEach((_, i) => this.markDirty(i));
  },

  /* ══════════ PRESETS ══════════ */
  renderPresets(filter = '') {
    const host = $('preset-list');
    if (!host) return;
    const all = Presets.load();
    const f = (filter || '').trim().toLowerCase();
    const names = Object.keys(all).filter(n => !f || n.toLowerCase().includes(f));
    host.replaceChildren();
    if (!names.length) {
      host.appendChild(el('p', 'empty', Object.keys(all).length
        ? 'No preset matches that filter.'
        : 'Nothing stored yet. Set the EQ how you like it, name it, and press Save.'));
      return;
    }
    for (const name of names) {
      const entry = all[name];
      const chip = el('div', 'preset');
      const main = el('button', 'preset-main');
      main.type = 'button';
      main.title = 'Load this preset into the editor';
      main.appendChild(el('span', 'preset-name', name));
      main.appendChild(el('span', 'preset-date',
        `${entry.banks?.DAC?.length ?? 0} bands · ${new Date(entry.savedAt || Date.now()).toLocaleDateString()}`));
      main.addEventListener('click', () => {
        applyState(entry, { label: 'preset load' });
        this.markAllDirty();
        Graph.request();
        toast(`Loaded "${name}" — Write all to push it to the device.`, 'info', 4200);
        log(`Preset "${name}" loaded.`);
      });
      const x = el('button', 'preset-x', '✕');
      x.type = 'button';
      x.title = 'Delete this preset';
      x.addEventListener('click', () => {
        if (!confirm(`Delete the preset "${name}"?`)) return;
        Presets.remove(name);
        this.renderPresets($('preset-search').value);
      });
      chip.append(main, x);
      host.appendChild(chip);
    }
  },

  /* ══════════ AUTOEQ REPORT ══════════ */
  renderAutoEQ(res) {
    const box = $('autoeq-report');
    if (!box) return;
    if (!res) { box.innerHTML = '<p class="empty">No AutoEQ target loaded.</p>'; return; }
    const err = AutoEQ.error(res.target);
    const lines = [
      `<b>${esc(res.name)}</b> — ${res.mapped.length} band${res.mapped.length === 1 ? '' : 's'} of ${res.room} available`,
    ];
    if (res.dropped.length) {
      lines.push(`<span style="color:var(--warn)">${res.dropped.length} weaker filter(s) dropped to fit the hardware: `
        + res.dropped.map(f => `${fmtFreq(f.freq)} Hz ${sgn(f.gain)}`).join(', ') + '</span>');
    }
    if (err) {
      lines.push(`fit error — RMS <b>${err.rms.toFixed(2)} dB</b>, worst <b>${err.peak.toFixed(2)} dB</b>`);
    }
    lines.push('');
    lines.push(res.mapped.map((f, i) =>
      `${String(i + 1).padStart(2)}  ${String(f.freq).padStart(6)} Hz  ${sgn(f.gain).padStart(6)} dB  Q${f.q.toFixed(2).padStart(5)}  ${FILTER_TYPES.find(t => t.value === f.filterType)?.label ?? ''}`
    ).join('\n'));
    box.innerHTML = lines.join('\n');
    $('btn-graph-target').disabled = false;
    setStatus(`AutoEQ "${res.name}" mapped ${res.mapped.length} bands.`, 'ok', 'dashed line on the graph is the target');
  },

  /* ══════════ CONNECT FLOW ══════════ */
  onProfileResolved(p) {
    const id = identify(hid.productName, hid.vendorId, hid.productId, hid.chipId);
    // Every route into a profile lands here - connect, probe, manual override -
    // so the trust badge is set from this one place rather than from whichever
    // render happened to run. An unreachable part has no register map to trust
    // at all, so it is labelled as such instead of borrowing a tier.
    App.setConfidenceBadge(p);
    const pill = $('device-name');
    if (pill) {
      pill.textContent = `${p.name} · ${hid.productName || 'connected'}`;
      // An unreachable part gets a distinct pill: the user needs to see at a
      // glance that the tool connected and then correctly declined to act.
      pill.className = 'pill ' + (p.incompatible ? 'pill-warn' : 'pill-live');
      pill.title = p.notes || '';
    }

    if (p.incompatible) {
      setStatus(`${p.chip} is not a USB-audio part — no register map, nothing written.`, 'error');
      setStatusMeta(`${p.chip} · ${p.cls ?? 'unknown class'} · unreachable over HID`);
      const note = $('profile-note');
      if (note) note.innerHTML = `<b>${esc(p.chip)}</b> — ${esc(p.notes || '')}`;
      $('sel-profile').value = '';
      log(`Identified ${p.chip} from the vendor catalogue, but it is a ${p.cls} part, not USB audio. The EQ is disabled rather than guessing a register layout.`, 'warn');
      this.updateChipPanel(id, p);
      return;
    }

    setStatusMeta(`${p.name} · ${p.bandCount} bands · DAC ${hex(hid.reg('EQ_DAC'))} · ACK ${hex(p.writeAck)}`);
    const note = $('profile-note');
    if (note) note.innerHTML = `<b>${esc(p.name)}</b> — ${esc(p.notes || '')}`;
    $('sel-profile').value = Object.keys(PROFILES).find(k => PROFILES[k] === p) || '';
    this.updateChipPanel(id, p);
  },

  /* Identification is a separate question from capability, so it gets its own
     reporting. Naming the part is useful even when the layout is unknown — the
     difference between "KT0235H, USB audio, 2 catalogue products, not yet
     profiled" and "unknown device" is the difference between a next step and
     a dead end. */
  updateChipPanel(id, p) {
    const box = $('chip-ident');
    if (!box) return;
    /* Fall back to the profile's own chip. onProfileResolved is also reached
       without a live descriptor — a manual override, or a refusal derived
       from a product name — and reading identity only from hid.productName
       would then report "no catalogue match" for the very part the caller
       just named. */
    const chip = id.chip ?? p.chip ?? null;
    const entry = chip ? CHIP_CATALOG[chip] : null;
    const cls = id.cls ?? entry?.cls ?? null;
    const products = id.products || entry?.products || 0;
    if (!chip) { box.innerHTML = '<span class="muted">No catalogue match for this product string.</span>'; return; }
    const state = p.incompatible ? 'unreachable'
      : id.profileIsDefault && p === hid.profile ? 'named, not profiled'
      : 'profiled';
    const rows = [
      `<b>${esc(chip)}</b>`,
      cls ? esc(cls) + (CHIP_USB_CLASS.includes(chip) ? '' : ' — outside this app\'s transport') : 'class unknown',
      products ? products + ' catalogue product' + (products === 1 ? '' : 's') : null,
      'status: ' + state,
      // Show the deciding evidence. A user who is told "KT02H20" deserves to
      // know whether that came from the device itself or from a string match.
      id.evidence ? 'matched on ' + esc(id.evidence) : null,
    ].filter(Boolean);
    box.innerHTML = rows.join('<br>');
  },

  /* How much to trust the register layout currently selected.
   *
   * This is a safety signal, not decoration. Writing a band to the wrong
   * offset does not produce an error — it reconfigures whatever register
   * actually lives there, which on a DAC means silence, noise, or a ruined
   * stored profile. So the tier sits next to the write controls rather than
   * only on the Device tab, where a user about to write may never look. */
  setConfidenceBadge(p) {
    const box = $('write-trust');
    if (!box) return;
    /* An unreachable part has no register map, so "verified" would be a lie and
       "guess" would understate that nothing will be written at all. Say so. */
    if (p?.incompatible) {
      box.dataset.tier = 'none';
      box.innerHTML = '<span class="trust-dot" aria-hidden="true"></span>'
        + '<b>unreachable</b> — not a USB-audio part, nothing is written';
      box.title = `Profile: none · ${p.chip ?? p.name} is outside this transport`;
      return;
    }
    const tier = CONFIDENCE[p?.confidence] ? p.confidence : 'guess';
    const t = CONFIDENCE[tier];
    box.dataset.tier = tier;
    box.innerHTML = `<span class="trust-dot" aria-hidden="true"></span>`
      + `<b>${esc(t.label)}</b> — ${esc(t.blurb)}`;
    box.title = `Profile: ${p?.name ?? 'none'} · confidence: ${tier}`;
  },

  async connect() {
    if (!navigator.hid) { setStatus('WebHID is unavailable — use Chrome or Edge on desktop.', 'error'); return; }
    setStatus('Waiting for the device picker…', 'working');
    try {
      const name = await hid.connect(() => this.onLost());
      log(`Connected: ${name}`, 'ok');
      await this.readAllState(true);
    } catch (err) {
      if (err?.name === 'NotFoundError') { setStatus('Picker dismissed — nothing connected.', 'idle'); return; }
      setStatus('Connect failed: ' + err.message, 'error');
      log('Connect failed: ' + err.message, 'err');
    }
  },

  async readAllState(first = false) {
    setStatus('Reading the device…', 'working', 'the first read sweeps both EQ banks');
    try {
      state.banks = makeBanks();
      rebuildFlags();
      this.setControlsEnabled(true);

      const p = hid.profile;
      try {
        const ver = await readString(p.versionAddr, p.versionCount);
        log(`Firmware version: "${ver}"`);
        $('profile-note').innerHTML = `<b>${esc(p.name)}</b> — reported "${esc(ver)}". ${esc(p.notes || '')}`;
      } catch (err) {
        throw new Error('The device did not answer a register read — wrong device, or the report ID is not 0x4B?');
      }

      await fetchAllBanks();

      // Keep what the hardware holds right now so the graph can show it as
      // a ghost while you audition something else.
      Graph.setGhost(state.banks[state.bank].map(b => ({ ...b })));
      log('Ghost curve captured from the device.');

      try { await fetchGains(); }
      catch (err) { log('Gain read failed — those addresses are unverified on this chip: ' + err.message, 'warn'); }

      await DRC.read();
      await Identity.refresh().catch(err => dbg('identity: ' + err.message));

      this.buildBands();
      this.refreshGainUI();
      this.updateBankToggle();
      this.updateEqToggles();
      this.syncLabels();
      Graph.setBands(state.banks.DAC);
      this.updateBootUI();

      const banks = Object.keys(state.banks).join(' + ');
      log(`State loaded — ${banks}, ${state.banks.DAC.length} bands each.`, 'ok');
      setStatus(first ? 'Connected and ready.' : 'Read complete.', 'ok',
        `Shift-drag a handle to move one axis only · Ctrl+K for commands`);
      if (first) toast('Connected. Try dragging a handle on the graph.', 'ok', 3200);
    } catch (err) {
      setStatus('Read failed: ' + err.message, 'error');
      log('Read failed: ' + err.message, 'err');
      this.setControlsEnabled(false);
    }
  },

  async readAll() {
    if (!hid.connected) return;
    setStatus('Reading all banks…', 'working');
    try {
      await fetchAllBanks();
      try { await fetchGains(); } catch (err) { log('Gain read failed: ' + err.message, 'warn'); }
      await DRC.read();
      Graph.setGhost(state.bands[state.bank].map(b => ({ ...b })));
      this.refreshAllBands();
      this.refreshGainUI();
      this.updateEqToggles();
      this.syncLabels();
      Graph.setBands(state.bands[state.bank]);
      this.markAllDirty();
      setStatus('Read complete.', 'ok');
      log('Read complete (all banks).', 'ok');
    } catch (err) {
      setStatus('Read error: ' + err.message, 'error');
      log('Read error: ' + err.message, 'err');
    }
  },

  async writeAll() {
    if (!hid.connected) return;
    const before = snapshotState();
    setStatus(`Writing the ${state.bank} bank…`, 'working');
    const dirtyOnly = state.bands.some((_, i) => $(`band-${i}`)?.classList.contains('is-dirty'));
    const list = dirtyOnly
      ? state.bands.filter((b, i) => $(`band-${i}`)?.classList.contains('is-dirty') && !bandFlag(i).muted)
      : state.bands.filter(b => !bandFlag(b.index).muted);
    let wrote = 0;
    try {
      for (const b of list) {
        const { aReg, bReg } = encodeBand(b.freq, b.gain, b.q, b.filterType);
        const addrA = eqBase() + b.index * hid.reg('EQ_STRIDE');
        await writeRegister(addrA, aReg);
        await writeRegister(addrA + 1, bReg);
        this.markClean(b.index);
        wrote += 2;
      }
      log(`Wrote ${wrote} registers (${list.length} band${list.length === 1 ? '' : 's'}) to the ${state.bank} bank.`, 'ok');
      setStatus('Write complete.', 'ok', `${wrote} registers acknowledged`);
      Graph.setGhost(state.banks[state.bank].map(x => ({ ...x })));
      toast(`Wrote ${list.length} band${list.length === 1 ? '' : 's'}.`, 'ok', 4000, {
        label: 'Undo',
        run: async () => {
          applyState(Presets.normalise(before) || before, { label: 'undo write' });
          this.markAllDirty();
          await this.writeAll();
        },
      });
    } catch (err) {
      setStatus('Write error: ' + err.message, 'error');
      log('Write error: ' + err.message, 'err');
      toast('Write failed — see the log.', 'error', 6000);
    }
  },

  async onLost() {
    $('device-name').textContent = 'No device';
    $('device-name').className = 'pill pill-idle';
    $('btn-connect').disabled = false;
    $('btn-disconnect').disabled = true;
    setStatusMeta('');
    this.setControlsEnabled(false);
    this.updateEqToggles();
    setStatus('Device disconnected — pulled out of USB.', 'error');
    log('Device disconnected.', 'err');
    Graph.setGhost(null);
  },

  async disconnect() {
    await hid.disconnect();
    await this.onLost();
    setStatus('Disconnected.', 'idle');
    log('Disconnected by the operator.');
  },

  /* ══════════ CONTROL ENABLEMENT ══════════
     One place decides what is live. Driven by the connection, plus the
     per-profile capabilities — SAVE and the ADC bank are hidden, not
     merely greyed out, so a chip never advertises an unverified command. */
  setControlsEnabled(on) {
    const ids = [
      'btn-eq-on', 'btn-eq-off', 'global-gain', 'dig-dac-r', 'dig-adc',
      'btn-read-all', 'btn-write-all', 'btn-reset-eq', 'btn-save-preset',
      'btn-bank-dac', 'btn-bank-adc', 'btn-mempeek', 'btn-id-read',
      'btn-id-refresh', 'btn-id-write-str', 'btn-id-write-vpid',
      'btn-ng-apply', 'btn-ng-read', 'btn-lim-apply', 'btn-lim-read',
      'btn-reg-dump', 'btn-ext-dump', 'btn-apply-profile', 'btn-gain-reset',
    ];
    for (const id of ids) { const n = $(id); if (n) n.disabled = !on; }
    $$('#eq-bands .vslider, #eq-bands .input, #eq-bands .btn').forEach(n => { n.disabled = !on; });
    const save = $('btn-save-flash');
    if (save) save.hidden = !(on && hid.profile?.supportsSave);
    this.updateBankToggle();
  },

  /* ══════════ BOOT UI ══════════ */
  /* The active bootloader link. Two transports reach the same vendor
     bootloader — WebHID feature reports (BOOT) and CDC serial (CDC) — and
     they are not interchangeable: different framing, different CRC, a real
     one-shot state machine. Each is its own implementation; this only picks
     which one the panel drives. Every safety guard lives above this split,
     so choosing the other transport cannot bypass one. */
  bootMode() { return $('boot-tr-cdc').classList.contains('is-on') ? 'cdc' : 'hid'; },
  bootLink() { return this.bootMode() === 'cdc' ? CDC : BOOT; },

  setBootTransport(mode) {
    for (const b of document.querySelectorAll('.seg-group [data-transport]')) {
      const on = b.dataset.transport === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    }
    const cdc = mode === 'cdc';
    $('boot-cdc-opts').hidden = !cdc;
    $('boot-tr-tag').textContent = cdc ? '8888:CDC0 · 0x69 frames' : '31B2:0101 / 0001 / 0002';
    $('boot-hint').innerHTML = cdc
      ? 'Put the dongle in boot mode <b>first</b> — it then re-enumerates as a USB CDC port, so connect only after it has rebooted. The handshake is <code>KTM → VER → KEY → CHP → ERASE → PWO → KSTA</code>, then 1 KB <code>0x69</code> packets carrying a 6-byte header, the payload and a CRC-32, each acknowledged with <code>0xA5</code>. The first 16 bytes of the image are written <b>last</b>. Typing <code>FLASH</code> arms the write.'
      : 'Put the dongle into bootloader mode, connect, and write a patched image <b>you dumped from that same unit</b>. Never flash a foreign BIN. The handshake is <code>KTM → VER → KEY → CHP → CFG → PWO → KSTA</code>, then 512-byte <code>0x69</code> blocks. Typing <code>FLASH</code> arms the write.';
    $('boot-info').textContent = 'Bootloader not connected.';
    this.updateBootUI();
  },

  updateBootUI() {
    const c = $('btn-boot-connect'), d = $('btn-boot-disconnect'),
          f = $('btn-boot-flash'), i = $('btn-boot-info');
    if (!c) return;
    const link = this.bootLink();
    c.disabled = link.connected;
    d.disabled = !link.connected;
    i.disabled = !link.connected;
    f.disabled = !link.connected || !FwBin.buf || FwBin.dacOff < 0;
  },

  /* ══════════ HEADROOM GUARD ══════════
     Boosting a band raises the level of everything the band covers. Summed
     across bands the response can push a full-scale input past the DAC's
     limit, and clipping sounds like harsh distortion rather than "louder" —
     a fault the listener can hear but cannot locate. The vendor's own config
     tool documents the same hazard and the same fix (a preamp sized to the
     largest boost), so surfacing it here is the difference between a tool
     that can ruin a listening session and one that warns first.

     Muted bands are excluded because they are excluded from the hardware
     write, so a muted band adds nothing to the signal. Solo is not: it is a
     display aid and does not change what reaches the DAC. */
  updateHeadroom() {
    const el = $('eq-headroom');
    if (!el) return;
    const live = state.bands.filter((b, i) => b.gain && b.freq && !bandFlag(i).muted);
    const peak = peakBoost(live);
    const db = peak.db;

    // "over" is a real clipping risk; "warn" is boost that eats the headroom
    // the rest of the signal chain needs. Both are worth saying, but only one
    // is a fault, and conflating them would train the user to ignore the chip.
    const state_ = db > 0 ? 'over' : db > -3 ? 'warn' : 'ok';
    el.dataset.state = state_;
    $('eq-headroom-val').textContent = (db >= 0 ? '+' : '−') + Math.abs(db).toFixed(1) + ' dB';
    $('eq-headroom-note').textContent =
      state_ === 'over' ? 'may clip'
      : state_ === 'warn' ? 'low headroom'
      : peak.hz ? 'peak ' + (peak.hz >= 1000 ? (peak.hz / 1000).toFixed(2) + ' kHz' : Math.round(peak.hz) + ' Hz')
      : 'flat';

    const trim = $('btn-eq-trim');
    trim.disabled = db <= 0;
    trim.title = db > 0
      ? 'Trim the global gain to ' + suggestedTrim(live).toFixed(1) + ' dB so the peak sits under 0 dBFS'
      : 'The EQ has headroom to spare.';
  },

  /* ══════════ COMMAND PALETTE ══════════ */
  palette: {
    open() {
      openOverlay('palette-root');
      $('palette-input').value = '';
      this.render('');
    },
    close() { closeOverlay('palette-root'); },
    items: [],
    sel: 0,
    render(q) {
      const list = $('palette-list');
      const needle = q.trim().toLowerCase();
      const all = this.items.filter(i =>
        !needle || i.label.toLowerCase().includes(needle) ||
        (i.group || '').toLowerCase().includes(needle) ||
        (i.keys || '').toLowerCase().includes(needle));
      this.filtered = all.slice(0, 40);
      this.sel = 0;
      list.replaceChildren();
      if (!this.filtered.length) {
        list.appendChild(el('p', 'empty', 'Nothing matches that.'));
        return;
      }
      let group = null;
      this.filtered.forEach((item, i) => {
        if (item.group !== group) {
          group = item.group;
          list.appendChild(el('div', 'pal-group', group));
        }
        const b = el('button', 'pal-item' + (i === 0 ? ' is-sel' : ''));
        b.type = 'button';
        b.appendChild(el('span', null, item.label));
        if (item.hint) {
          const h = el('span', 'pal-hint');
          item.hint.forEach(k => h.appendChild(el('kbd', null, k)));
          b.appendChild(h);
        }
        b.addEventListener('click', () => { this.close(); item.run(); });
        b.addEventListener('mousemove', () => this.select(i));
        list.appendChild(b);
      });
    },
    select(i) {
      this.sel = clamp(i, 0, (this.filtered?.length || 1) - 1);
      $$('#palette-list .pal-item').forEach((n, k) => n.classList.toggle('is-sel', k === this.sel));
      $$('#palette-list .pal-item')[this.sel]?.scrollIntoView({ block: 'nearest' });
    },
    move(delta) { this.select(this.sel + delta); },
    runSelected() {
      const item = this.filtered?.[this.sel];
      if (item) { this.close(); item.run(); }
    },
  },

  buildCommands() {
    const band = i => ({
      label: `Reset band ${i + 1}`,
      group: 'Bands', run: () => { App.buildBands(); App.refreshAllBands(); },
    });
    this.palette.items = [
      { group: 'Go to', label: 'Parametric EQ',       hint: ['1'], run: () => this.showView('eq') },
      { group: 'Go to', label: 'Gain & dynamics',      hint: ['2'], run: () => this.showView('chain') },
      { group: 'Go to', label: 'Device identity',      hint: ['3'], run: () => this.showView('device') },
      { group: 'Go to', label: 'Register explorer',    hint: ['4'], run: () => this.showView('regs') },
      { group: 'Go to', label: 'Firmware & bootloader',hint: ['5'], run: () => this.showView('fw') },
      { group: 'Go to', label: 'Session log',          hint: ['6'], run: () => this.showView('log') },

      { group: 'Device', label: 'Connect USB', run: () => this.connect() },
      { group: 'Device', label: 'Disconnect', run: () => this.disconnect() },
      { group: 'Device', label: 'Read every band', hint: ['R'], run: () => this.readAll() },
      { group: 'Device', label: 'Write every band', hint: ['W'], run: () => this.writeAll() },
      { group: 'Device', label: 'Save DSP state to flash', run: () => this.saveFlash() },
      { group: 'Device', label: 'Read identity & probe the chip', run: () => this.runGuard(() => Identity.refresh()) },
      { group: 'Device', label: 'Sweep registers 0x00–0xFF', run: () => this.runGuard(() => Registers.dump()) },

      { group: 'EQ', label: 'Toggle EQ enable', run: () => this.toggleEq() },
      { group: 'EQ', label: 'Reset every band to 0 dB', run: () => this.resetEq() },
      { group: 'EQ', label: 'Mute every band', run: () => this.muteAll(true) },
      { group: 'EQ', label: 'Unmute every band', run: () => this.muteAll(false) },
      { group: 'EQ', label: 'Clear solo', run: () => { state.bands.forEach((_, j) => { bandFlag(j).solo = false; }); this.refreshAllBands(); Graph.request(); } },
      { group: 'EQ', label: 'Capture the device curve as a ghost', run: () => { Graph.setGhost(state.bands.map(b => ({ ...b }))); toast('Ghost curve updated.', 'info', 2000); } },
      { group: 'EQ', label: 'Clear the ghost curve', run: () => Graph.setGhost(null) },
      { group: 'EQ', label: 'Undo', hint: ['Ctrl', 'Z'], run: () => this.undo() },
      { group: 'EQ', label: 'Redo', hint: ['Ctrl', '⇧', 'Z'], run: () => this.redo() },

      { group: 'Presets', label: 'Store the current state as a preset', hint: ['Ctrl', 'S'], run: () => this.savePreset() },
      { group: 'Presets', label: 'Import a preset or AutoEQ file', run: () => $('file-import').click() },
      { group: 'Presets', label: 'Import an AutoEQ target', run: () => $('file-autoeq').click() },
      { group: 'Presets', label: 'Export every preset', run: () => { Presets.exportJSON(); log('Presets exported.'); } },
      { group: 'Presets', label: 'Clear the AutoEQ target', run: () => AutoEQ.clearTarget() },

      { group: 'Snapshots', label: 'Capture into snapshot slot A', run: () => this.captureSnap(0) },
      { group: 'Snapshots', label: 'Capture into snapshot slot B', run: () => this.captureSnap(1) },
      { group: 'Snapshots', label: 'Capture into snapshot slot C', run: () => this.captureSnap(2) },
      { group: 'Snapshots', label: 'Capture into snapshot slot D', run: () => this.captureSnap(3) },
      { group: 'Snapshots', label: 'Clear all snapshots', run: () => { App.saveSnaps([]); App.renderSnaps(); } },

      { group: 'Appearance', label: `Theme — switch to ${nextThemeLabel()}`, run: () => this.cycleTheme() },
      ...ACCENTS.map(a => ({ group: 'Appearance', label: `Accent — ${a}`, run: () => { Settings.data.accent = a; Settings.save(); this.syncSettingsUI(); } })),
      { group: 'Appearance', label: 'Toggle reduced motion', run: () => { Settings.data.reduceMotion = !Settings.data.reduceMotion; Settings.save(); this.syncSettingsUI(); } },
      { group: 'Appearance', label: 'Toggle verbose HID logging', run: () => { Settings.data.logVerbose = !Settings.data.logVerbose; Settings.save(); this.syncSettingsUI(); log('Log verbosity: ' + (Settings.data.logVerbose ? 'verbose' : 'normal')); } },
      { group: 'Appearance', label: 'Open settings', run: () => openOverlay('settings-root') },
      { group: 'Appearance', label: 'Keyboard shortcuts & notes', hint: ['?'], run: () => openOverlay('help-root') },
      { group: 'Appearance', label: 'Open the USB log', run: () => this.showView('log') },
      { group: 'Appearance', label: 'Clear the log', hint: ['Esc'], run: () => Log.clear() },
    ].filter(Boolean);
  },

  async runGuard(fn) {
    if (!hid.connected) { toast('Connect a device first.', 'warn'); return; }
    try { await fn(); } catch (err) { log(err.message, 'err'); toast(err.message, 'error', 5000); }
  },

  undo() {
    const label = History.undo();
    if (!label) { toast('Nothing left to undo.', 'warn'); return; }
    this.markAllDirty();
    Graph.request();
    toast(`Undid ${label}.`, 'info', 2400);
  },
  redo() {
    const label = History.redo();
    if (!label) { toast('Nothing to redo.', 'warn'); return; }
    this.markAllDirty();
    Graph.request();
    toast(`Redid ${label}.`, 'info', 2400);
  },

  async toggleEq() {
    if (!hid.connected) return;
    const addr = eqEnableAddr();
    try {
      const val = await readRegister(addr);
      const want = !state.eqEnabled[state.bank];
      // Preserve any bits whose meaning is not known (KT0211L reads 3 here).
      await writeRegister(addr, want ? (val | 1) : (val & ~1));
      state.eqEnabled[state.bank] = want;
      this.updateEqToggles();
      setStatus(`${state.bank} EQ ${want ? 'enabled' : 'bypassed'}.`, 'ok', `register ${hex(addr)}`);
      log(`${state.bank} EQ ${want ? 'on' : 'off'} (${hex(addr)} was 0x${val.toString(16)})`, 'ok');
    } catch (err) { log('EQ toggle failed: ' + err.message, 'err'); }
  },

  resetEq() {
    History.push('EQ reset');
    for (const bank of Object.keys(state.banks)) {
      state.banks[bank] = profileBands();
    }
    rebuildFlags();
    this.buildBands();
    this.markAllDirty();
    Graph.request();
    log('Every band reset to 0 dB at the profile default frequencies.', 'warn');
    setStatus('EQ reset locally — Write all to apply.', 'working');
  },

  muteAll(on) {
    History.push(on ? 'mute all' : 'unmute all');
    state.bands.forEach((_, i) => { bandFlag(i).muted = on; bandFlag(i).solo = false; });
    this.refreshAllBands();
    this.refreshBandTools();
    Graph.request();
    log(on ? 'All bands muted locally — writes will be skipped.' : 'All bands unmuted.', 'warn');
  },

  savePreset() {
    const name = ($('preset-name').value || '').trim();
    if (!name) { toast('Give the preset a name first.', 'warn'); $('preset-name').focus(); return; }
    History.push('preset save');
    if (!Presets.add(name)) { toast('Could not write to localStorage.', 'error'); return; }
    $('preset-name').value = '';
    this.renderPresets($('preset-search').value);
    log(`Preset "${name}" stored.`, 'ok');
    toast(`Preset "${name}" saved.`, 'ok');
  },

  async saveFlash() {
    if (!hid.connected || !hid.profile.supportsSave) return;
    if (!confirm(
      'Commit the current DSP state (EQ plus gains) to the chip\'s flash?\n\n' +
      'This is the vendor SAVE command (0x53). The unit will most likely REBOOT.\n' +
      'After it comes back, reconnect and Read to confirm the settings stuck.'
    )) return;
    try {
      const st = await saveToFlash();
      setStatus(`Saved to flash (status ${hex(st, 2)}).`, 'ok', 'wait for the reboot, reconnect, then read');
      log('SAVE accepted.', 'ok');
      toast('Saved. Reconnect after the reboot and read back to verify.', 'ok', 6000);
    } catch (err) {
      log('Save-to-flash failed: ' + err.message, 'err');
      toast('Save failed: ' + err.message, 'error', 5000);
    }
  },

  cycleTheme() {
    const t = Settings.cycleTheme();
    this.syncSettingsUI();
    log('Theme: ' + t);
  },

  syncSettingsUI() {
    const d = Settings.data;
    $('sel-theme').value = d.theme;
    $('sel-queue-gap').value = String(d.queueGap);
    $('sel-log-level').value = d.logVerbose ? 'dbg' : 'inf';
    $('chk-autosend').checked = d.autoSend;
    $('chk-confirm-flash').checked = d.confirmFlash;
    $('chk-reduce-motion').checked = d.reduceMotion;
    $('btn-autosend').setAttribute('aria-pressed', String(d.autoSend));
    $('rail-theme-name').textContent = d.theme;
    $$('#accent-picker .accent-dot').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.accent === d.accent)));
  },

  /* ══════════ LOG FILTERS ══════════ */
  buildLogFilters() {
    const host = $('log-filters');
    if (!host) return;
    const kinds = [['tx', 'tx'], ['rx', 'rx'], ['inf', 'info'], ['ok', 'ok'], ['warn', 'warn'], ['err', 'err'], ['dbg', 'dbg']];
    host.replaceChildren();
    for (const [key, label] of kinds) {
      const b = el('button', 'seg is-on', label);
      b.type = 'button';
      b.addEventListener('click', () => {
        const on = Log.kinds.has(key);
        if (on && Log.kinds.size === 1) return;
        if (on) Log.kinds.delete(key); else Log.kinds.add(key);
        b.classList.toggle('is-on', !on);
        Log.paint();
      });
      host.appendChild(b);
    }
  },
};

/* ══════════ BAND SEND ══════════ */
async function sendBand(i, manual) {
  if (!hid.connected) return;
  const b = state.bands[i];
  if (!b) return;
  if (manual) History.push('band edit');
  if (bandFlag(i).muted) {
    if (manual) toast(`Band ${i + 1} is muted — unmute it to write it.`, 'warn');
    return;
  }
  const { aReg, bReg } = encodeBand(b.freq, b.gain, b.q, b.filterType);
  const addrA = eqBase() + i * hid.reg('EQ_STRIDE');
  try {
    await writeRegister(addrA, aReg);
    await writeRegister(addrA + 1, bReg);
    App.markClean(i);
    Graph.setGhost(state.bands.map(x => ({ ...x })));
  } catch (err) {
    if (err.message === 'Queue cleared' || err.message === 'Device disconnected') return;
    log(`Band ${i + 1} write failed: ${err.message}`, 'err');
    if (manual) toast('Band write failed — see the log.', 'error', 5000);
  }
}

/* ══════════ KEYBOARD ══════════ */
function setupKeyboard() {
  document.addEventListener('keydown', async e => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    if (e.key === 'Escape') {
      if (anyOverlayOpen()) { $$('.overlay').forEach(o => { o.hidden = true; }); return; }
      if (typing) { document.activeElement.blur(); return; }
      if (App.view === 'log') Log.clear();
      return;
    }

    // Palette: Ctrl/⌘+K anywhere, and "/" outside text fields.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault(); App.palette.open(); return;
    }
    if (e.key === '/' && !typing) { e.preventDefault(); App.palette.open(); return; }
    if (App.palette.items.length && !$('palette-root').hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); App.palette.move(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); App.palette.move(-1); return; }
      if (e.key === 'Enter')     { e.preventDefault(); App.palette.runSelected(); return; }
    }

    if (typing) return;

    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 's': e.preventDefault(); App.savePreset(); break;
        case 'z': e.preventDefault(); e.shiftKey ? App.redo() : App.undo(); break;
        case 'y': e.preventDefault(); App.redo(); break;
      }
      return;
    }

    switch (e.key) {
      case '?': e.preventDefault(); openOverlay('help-root'); break;
      case 'r': case 'R': if (hid.connected) App.readAll(); break;
      case 'w': case 'W': if (hid.connected) App.writeAll(); break;
      case 'e': case 'E': if (hid.connected) App.toggleEq(); break;
      default: {
        const n = parseInt(e.key, 10);
        if (n >= 1 && n <= VIEWS.length) App.showView(VIEWS[n - 1]);
      }
    }
  });
}

/* ══════════ FILE DROP ══════════ */
function setupDropZone() {
  const zone = $('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++; zone.hidden = false;
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.hidden = true; } });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    depth = 0; zone.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (file) await ingestFile(file);
  });
}

async function ingestFile(file) {
  const name = file.name.toLowerCase();
  log(`Dropped: ${file.name} (${fmtBytes(file.size)})`);
  try {
    if (name.endsWith('.bin')) { await FwBin.load(file); App.renderFirmware(); toast(`Image loaded: ${file.name}`, 'ok'); return; }
    if (name.endsWith('.json')) { await handleJSONFile(file); return; }
    toast(`Do not know what to do with "${file.name}".`, 'warn');
  } catch (err) {
    log('File handling failed: ' + err.message, 'err');
    toast(err.message, 'error', 5000);
  }
}

async function handleJSONFile(file) {
  const text = await file.text();
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* handled below */ }
  if (obj && Array.isArray(obj.filters) && obj.filters.length) {
    const n = AutoEQ.ingest(obj, file.name);
    App.buildBands();
    App.markAllDirty();
    Graph.request();
    toast(`AutoEQ "${file.name}" — ${n} band(s) mapped. Write all to apply.`, 'ok', 5000);
    return;
  }
  const res = await Presets.importJSON(new File([text], file.name, { type: 'application/json' }));
  if (res.kind === 'autoeq') {
    App.buildBands(); App.markAllDirty(); Graph.request();
    toast(`AutoEQ "${file.name}" — ${res.count} band(s) mapped.`, 'ok', 5000);
  } else {
    App.renderPresets($('preset-search').value);
    toast(res.skipped
      ? `${res.count} preset(s) imported, ${res.skipped} skipped as unusable.`
      : `${res.count} preset(s) imported.`, 'ok', 4200);
  }
}

/* ══════════ FIRMWARE RENDERING ══════════ */
function renderFirmwareTables() {
  const host = $('fw-tables');
  if (!host || !FwBin.buf) return;
  host.replaceChildren();
  const table = (title, off, bands) => {
    const rows = FwBin.readTable(off);
    if (!rows) return;
    const box = el('div', 'fw-table');
    box.appendChild(el('h4', null, title));
    const tbl = el('table');
    rows.forEach((r, i) => {
      const live = bands?.[i];
      const differs = live && (live.freq !== r.freq || Math.abs(live.gain - r.gain) > 0.05 || Math.abs(live.q - r.q) > 0.01 || live.filterType !== r.filterType);
      const tr = el('tr');
      if (differs) tr.className = 'diff';
      const t = FILTER_TYPES.find(x => x.value === r.filterType)?.label ?? r.filterType;
      tr.innerHTML =
        `<td>${i + 1}</td><td>${r.freq} Hz</td><td class="${differs ? 'diff' : ''}">${sgn(r.gain)} dB</td>` +
        `<td>Q${r.q.toFixed(2)}</td><td>${esc(t)}</td>`;
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    host.appendChild(box);
  };
  table(`DAC EQ @ ${hex(FwBin.dacOff)}`, FwBin.dacOff, state.banks?.DAC);
  if (FwBin.adcOff >= 0) table(`ADC EQ @ ${hex(FwBin.adcOff)}`, FwBin.adcOff, state.banks?.ADC);
  host.hidden = false;
}

App.renderFirmware = function () {
  const info = FwBin.buf ? FwBin.info() : null;
  const h = FwBin.buf ? FwBin.header() : null;
  $('fw-info').textContent = info
    ? `${info.name} — ${fmtBytes(info.size)}\n`
      + `flash tag      ${h?.tag || '(not found)'}${h?.chipId ? `   chip id ${h.chipId}` : ''}\n`
      + `size field     ${h?.sizeField != null ? h.sizeField : '(not found)'}`
      + `${h?.sizeField != null && h.sizeField !== info.size ? `   (file is ${info.size} — meta describes the target image)` : ''}\n`
      + `DAC EQ table   ${info.dacOff >= 0 ? hex(info.dacOff) : 'NOT FOUND'}\n`
      + `ADC EQ table   ${info.adcOff >= 0 ? hex(info.adcOff) : 'not found'}\n`
      + `bank enable    ${info.enOff >= 0 ? `${hex(info.enOff)} = 0x${info.enVal.toString(16)}` : 'not found'}\n`
      + `KT VID marker  ${info.hasKtVid ? '0x31B2 present' : 'ABSENT — not a KT image?'}\n`
      + `bytes changed  ${info.patched}`
    : 'No image loaded.';

  const pf = $('fw-preflight');
  if (info) {
    const checks = FwBin.preflight();
    pf.innerHTML = checks.map(c =>
      `<div class="pf pf-${c.state}"><span class="pf-mark">${c.state === 'pass' ? '✓' : c.state === 'warn' ? '!' : '✕'}</span><span class="pf-text">${c.text}</span></div>`
    ).join('');
    pf.hidden = false;
  } else pf.hidden = true;

  $('btn-fw-patch').disabled = !info || info.dacOff < 0;
  $('btn-fw-export').disabled = !info;
  renderFirmwareTables();
  this.updateBootUI();
  this.renderFirmwareCompare();
};

/* The second image for the differ. Kept out of FwBin on purpose: FwBin is the
   image you patch and flash, and letting a comparison target overwrite it
   would silently retarget the destructive path. */
const FwCompare = { buf: null, name: '' };

App.enableCompare = function () {
  $('btn-fw-cmp-load').disabled = !FwBin.buf;
  this.renderFirmwareCompare();
};

App.renderFirmwareCompare = function () {
  const box = $('fw-cmp');
  const hasB = !!FwCompare.buf;
  $('btn-fw-cmp-load').disabled = !FwBin.buf;
  $('btn-fw-cmp-clear').disabled = !hasB;
  if (!FwBin.buf) { box.textContent = 'Load a first image to use as the reference.'; return; }
  if (!hasB) { box.textContent = `Reference: ${FwBin.name}. Load a second image to compare.`; return; }

  const d = fwDiff(FwBin.buf, FwCompare.buf, {
    eqTables: [
      { off: FwBin.dacOff, n: 5, decode: (buf, off) => FwBin.decode(buf, off), name: 'DAC' },
      { off: FwBin.adcOff, n: 5, decode: (buf, off) => FwBin.decode(buf, off), name: 'ADC' },
    ],
  });
  if (!d) { box.textContent = 'Could not compare those images.'; return; }

  const rows = [
    `A  ${FwBin.name}  ${fmtBytes(d.sizeA)}`,
    `B  ${FwCompare.name}  ${fmtBytes(d.sizeB)}`,
    '',
    d.identical
      ? 'The two images are byte-identical.'
      : `${d.runs} differing run${d.runs === 1 ? '' : 's'}, ${d.bytes} bytes  →  ${d.verdict}`,
  ];
  if (!d.identical) {
    if (d.eqSkipped?.length) {
      for (const s of d.eqSkipped) {
        rows.push(`  ${s.table} table at ${hex(s.off)} skipped — ${s.bad} of ${s.of} entries do not decode as bands,`);
        rows.push(`      so that offset is not an EQ table and no conclusion was drawn from it.`);
      }
    }
    if (d.eqChanged.length) {
      const audible = d.eqChanged.filter(c => c.audible).length;
      rows.push(audible
        ? `  EQ — ${audible} band(s) decode differently and CAN move the response:`
        : `  EQ — ${d.eqChanged.length} band(s) differ, but only in filter shape at 0 dB gain, so the curve is identical:`);
      for (const c of d.eqChanged) {
        const f = x => `${x.freq} Hz ${x.gain >= 0 ? '+' : ''}${x.gain} dB Q${x.q} type ${x.filterType}`;
        rows.push(`      ${c.table} band ${c.band}:  ${f(c.a)}  →  ${f(c.b)}${c.audible ? '' : '   (inert at 0 dB)'}`);
      }
    }
    if (d.codeBytes) rows.push(`  code        ${d.codeBytes} byte(s)`);
    if (d.buildBytes) rows.push(`  build info  ${d.buildBytes} byte(s)`);
    rows.push('');
    for (const g of d.byRegion) rows.push(`  ${g.label}: ${g.bytes} byte(s) in ${g.runs.length} run(s)`);
    if (d.detail.length) {
      rows.push('');
      for (const r of d.detail.slice(0, 12)) {
        rows.push(`  ${hex(r.from)}..${hex(r.to)}  ${r.len} B  ${r.region}`);
        if (r.a !== r.b) rows.push(`      A ${r.a}\n      B ${r.b}`);
      }
      if (d.detail.length > 12) rows.push(`  … ${d.detail.length - 12} more run(s)`);
    }
  }
  box.textContent = rows.join('\n');
  log(`Compared ${FwBin.name} with ${FwCompare.name}: ${d.identical ? 'identical' : d.runs + ' runs / ' + d.bytes + ' bytes — ' + d.verdict}`,
      d.identical ? 'ok' : d.eqChanged.some(c => c.audible) || d.codeBytes ? 'warn' : 'ok');
};


/* ══════════ ROSTER RENDER ══════════ */
function renderRoster() {
  const host = $('chip-roster');
  if (!host) return;
  host.replaceChildren();
  const labels = { verified: 'verified', expected: 'expected', doc: 'documented' };
  for (const r of ROSTER) {
    const row = el('div', 'roster-row' + (PROFILES[r.name] ? ' is-profiled' : ''));
    row.appendChild(el('span', 'roster-name', r.name));
    row.appendChild(el('span', 'roster-note', r.note));
    const st = el('span', 'roster-state state-' + r.state, labels[r.state]);
    row.appendChild(st);
    row.title = PROFILES[r.name] ? PROFILES[r.name].notes : 'No run-mode map in this app (ARCHITECTURE.md §4).';
    host.appendChild(row);
  }
}

/* ══════════ NEXT THEME LABEL (for the palette) ══════════ */
function nextThemeLabel() {
  const i = THEME_ORDER.indexOf(Settings.data.theme);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}

/* ══════════ INIT ══════════ */
function init() {
  $('pga-adc').innerHTML = PGA_ADC_GAINS.map((l, i) => `<option value="${i}">${l}</option>`).join('');
  $('pga-dac').innerHTML = PGA_DAC_GAINS.map((l, i) => `<option value="${i}">${l}</option>`).join('');
  $('sel-profile').innerHTML =
    Object.keys(PROFILES).map(k => `<option value="${k}">${k} - ${PROFILES[k].name}</option>`).join('');

  /* Catalogue coverage, which is static — the user should be able to see what
     the tool knows about before plugging anything in. */
  const total = Object.keys(CHIP_CATALOG).length;
  $('chip-total').textContent = total;
  $('chip-count').textContent = total + ' parts';
  $('chip-classes').innerHTML = CHIP_CLASS_TOTALS
    .map(([cls, n]) => `<span class="chip-class${cls.includes('USB audio') ? ' is-usb' : ''}">${esc(cls)} · ${n}</span>`)
    .join('');

  // offline-capable state before any device exists
  state.banks = makeBanks();
  rebuildFlags();

  Graph.init('eq-canvas');
  Graph.onBandChange((i, final) => {
    if (i != null) { App.refreshBand(i); App.markDirty(i); }
    Graph.request();
    if (final) History.push('band drag');
  });
  /* One subscription covers every path that can change the summed response:
     drags, mutes, preset loads, AutoEQ, undo/redo, band resets. */
  Graph.onRequest(() => App.updateHeadroom());
  App.buildBands();
  Graph.setBands(state.bands);
  App.renderPresets();
  App.renderSnaps();
  App.buildLogFilters();
  App.buildCommands();
  App.syncSettingsUI();
  App.updateHistoryButtons();
  renderRoster();
  App.renderFirmware();
  App.renderAutoEQ(null);
  setupKeyboard();
  setupDropZone();

  // restore the last view
  let last = 'eq';
  try { last = localStorage.getItem(VIEW_KEY) || 'eq'; } catch { /* private mode */ }
  App.showView(VIEWS.includes(last) ? last : 'eq');

  /* ── top bar ── */
  $('btn-connect').addEventListener('click', () => App.connect());
  $('btn-disconnect').addEventListener('click', () => App.disconnect());
  $('btn-palette').addEventListener('click', () => App.palette.open());
  $('btn-settings').addEventListener('click', () => openOverlay('settings-root'));
  $('btn-help').addEventListener('click', () => openOverlay('help-root'));
  $('rail-theme').addEventListener('click', () => App.cycleTheme());
  $$('.rail-btn[data-view]').forEach(b => b.addEventListener('click', () => App.showView(b.dataset.view)));
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeOverlay(b.dataset.close)));
  $$('.overlay').forEach(o => o.addEventListener('mousedown', e => { if (e.target === o) o.hidden = true; }));

  /* ── palette ── */
  $('palette-input').addEventListener('input', e => App.palette.render(e.target.value));
  $('palette-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); App.palette.move(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); App.palette.move(-1); }
    if (e.key === 'Enter')     { e.preventDefault(); App.palette.runSelected(); }
  });

  /* ── graph toolbar ── */
  $('sel-graph-db').addEventListener('change', e => Graph.setOption('dbMax', +e.target.value));
  $('chk-graph-fill').addEventListener('change', e => Graph.setOption('fill', e.target.checked));
  $('chk-graph-focus').addEventListener('change', e => {
    if (e.target.checked && !anySolo()) {
      state.bands.forEach((_, i) => { bandFlag(i).solo = i === 0; });
      App.refreshBandTools();
      toast('Focus mode on — solo a band with S, or clear it from the palette.', 'info', 4000);
    } else {
      state.bands.forEach((_, i) => { bandFlag(i).solo = false; });
      App.refreshBandTools();
    }
    Graph.request();
  });
  $('btn-graph-target').addEventListener('click', () => AutoEQ.clearTarget());

  /* ── EQ panel ── */
  $('eq-bands').addEventListener('click', e => App.onBandTool(e));
  $('btn-eq-on').addEventListener('click', () => { if (state.eqEnabled[state.bank] !== true) App.toggleEq(); });
  $('btn-eq-off').addEventListener('click', () => { if (state.eqEnabled[state.bank] !== false) App.toggleEq(); });
  $('btn-bank-dac').addEventListener('click', () => switchBank('DAC'));
  $('btn-bank-adc').addEventListener('click', () => switchBank('ADC'));
  $('btn-read-all').addEventListener('click', () => App.readAll());
  $('btn-write-all').addEventListener('click', () => App.writeAll());
  $('btn-save-flash').addEventListener('click', () => App.saveFlash());
  $('btn-reset-eq').addEventListener('click', () => App.resetEq());
  $('btn-eq-trim').addEventListener('click', async () => {
    const live = state.bands.filter((b, i) => b.gain && b.freq && !bandFlag(i).muted);
    const trim = suggestedTrim(live);
    if (trim >= 0) return;
    /* Applying the same trim to both channels keeps the image centred. Doing
       it live means the user hears the difference between clipping and not
       clipping immediately, which is the only way the number means anything. */
    const before = { globalGain: state.globalGain, globalGainR: state.globalGainR };
    try {
      await App.writeDigDac(trim);
      state.globalGain = state.globalGainR = trim;
      $('global-gain-val').textContent = sgn(trim) + ' dB';
      $('dig-dac-r-val').textContent = sgn(trim) + ' dB';
      $('global-gain').value = trim;
      $('dig-dac-r').value = trim;
      History.push('headroom trim');
      log(`Headroom trim: global gain ${sgn(before.globalGain)} → ${sgn(trim)} dB (peak was ${sgn(peakBoost(live).db)} dB).`, 'ok');
      toast(`Trimmed to ${sgn(trim)} dB.`, 'ok', 4000, {
        label: 'Undo',
        run: async () => {
          await App.writeDigDac(before.globalGain);
          state.globalGain = before.globalGain; state.globalGainR = before.globalGainR;
          $('global-gain-val').textContent = sgn(before.globalGain) + ' dB';
          $('dig-dac-r-val').textContent = sgn(before.globalGainR) + ' dB';
          $('global-gain').value = before.globalGain;
          $('dig-dac-r').value = before.globalGainR;
        },
      });
    } catch (err) {
      setStatus('Trim failed: ' + err.message, 'error');
      log('Headroom trim failed: ' + err.message, 'err');
    }
  });
  $('btn-undo').addEventListener('click', () => App.undo());
  $('btn-redo').addEventListener('click', () => App.redo());
  $('btn-autosend').addEventListener('click', () => {
    Settings.data.autoSend = !Settings.data.autoSend;
    Settings.save();
    App.syncSettingsUI();
    log('Auto-send ' + (Settings.data.autoSend ? 'on — drags now write to the device.' : 'off — drags stay local until you press Write all.'), 'warn');
  });
  $('btn-snap-capture').addEventListener('click', () => App.captureSnap(App.loadSnaps().findIndex(s => !s) === -1 ? 0 : App.loadSnaps().findIndex(s => !s)));
  $('btn-snap-clear').addEventListener('click', () => {
    if (!App.loadSnaps().some(Boolean)) return;
    if (!confirm('Clear all four snapshot slots?')) return;
    App.saveSnaps([]); App._snapLoaded = -1; App.renderSnaps();
  });

  /* ── presets ── */
  $('btn-save-preset').addEventListener('click', () => App.savePreset());
  $('preset-search').addEventListener('input', e => App.renderPresets(e.target.value));
  $('preset-name').addEventListener('keydown', e => { if (e.key === 'Enter') App.savePreset(); });
  $('btn-export').addEventListener('click', () => { Presets.exportJSON(); log('Presets exported.'); });
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) await ingestFile(f);
  });
  $('btn-autoeq').addEventListener('click', () => $('file-autoeq').click());
  $('file-autoeq').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) await ingestFile(f);
  });

  /* ── chain ── */
  $('global-gain').addEventListener('input', e => { $('global-gain-val').textContent = sgn(parseFloat(e.target.value)) + ' dB'; });
  $('dig-dac-r').addEventListener('input', e => { $('dig-dac-r-val').textContent = sgn(parseFloat(e.target.value)) + ' dB'; });
  $('dig-adc').addEventListener('input', e => { $('dig-adc-val').textContent = sgn(parseFloat(e.target.value)) + ' dB'; });
  $('global-gain').addEventListener('change', async e => {
    if (!hid.connected) return;
    const v = parseFloat(e.target.value);
    try { await App.writeDigDac(v); state.globalGain = v; $('global-gain-val').textContent = sgn(v) + ' dB'; setStatus(`DAC left ${sgn(v)} dB.`, 'ok'); }
    catch (err) { log('DAC gain write failed: ' + err.message, 'err'); }
  });
  $('dig-dac-r').addEventListener('change', async e => {
    if (!hid.connected) return;
    const v = parseFloat(e.target.value);
    try { await App.writeDigDac(state.globalGain); state.globalGainR = v; setStatus(`DAC right ${sgn(v)} dB.`, 'ok'); }
    catch (err) { log('DAC right write failed: ' + err.message, 'err'); }
  });
  $('dig-adc').addEventListener('change', async e => {
    if (!hid.connected) return;
    const v = parseFloat(e.target.value);
    const addr = hid.reg('DIG_ADC');
    try {
      const raw = await readRegister(addr);
      await writeRegister(addr, (raw & 0xFFFFFF00) | encodeDigGain(v));
      state.digADC = v;
      $('dig-adc-val').textContent = sgn(v) + ' dB';
      setStatus(`ADC gain ${sgn(v)} dB.`, 'ok');
    } catch (err) { log('ADC gain write failed: ' + err.message, 'err'); }
  });
  $('pga-adc').addEventListener('change', async e => {
    if (!hid.connected) return;
    try { await writeRegister(hid.reg('PGA_ADC'), +e.target.value & 0xFF); state.pgaADC = +e.target.value; setStatus(`A_ADC ${PGA_ADC_GAINS[state.pgaADC]}.`, 'ok'); }
    catch (err) { log('A_ADC write failed: ' + err.message, 'err'); }
  });
  $('pga-dac').addEventListener('change', async e => {
    if (!hid.connected) return;
    try { await writeRegister(hid.reg('PGA_DAC'), +e.target.value & 0xFF); state.pgaDAC = +e.target.value; setStatus(`A_DAC ${PGA_DAC_GAINS[state.pgaDAC]}.`, 'ok'); }
    catch (err) { log('A_DAC write failed: ' + err.message, 'err'); }
  });
  $('btn-gain-reset').addEventListener('click', () => {
    ['global-gain', 'dig-dac-r', 'dig-adc'].forEach(id => { const n = $(id); if (n) n.value = 0; });
    state.globalGain = state.globalGainR = state.digADC = 0;
    state.pgaADC = 0;
    $('pga-dac').value = 1;   // index 1 is -16.5 dB, not mute
    state.pgaDAC = 1;
    App.refreshGainUI();
    log('All gains zeroed locally — the device is untouched until you apply them.');
  });

  /* ── DRC ── */
  ['ng-en', 'lim-en', 'lim-soft'].forEach(id =>
    $(id).addEventListener('click', () => $(id).classList.toggle('is-on')));
  [['ng-th', 'ng-th-val'], ['ng-gv', 'ng-gv-val'], ['lim-th', 'lim-th-val']].forEach(([s, o]) =>
    $(s).addEventListener('input', e => { $(o).textContent = `${e.target.value} dB`; }));
  $('btn-ng-apply').addEventListener('click', () => App.runGuard(() => DRC.writeGate()));
  $('btn-lim-apply').addEventListener('click', () => App.runGuard(() => DRC.writeLimiter()));
  $('btn-ng-read').addEventListener('click', () => App.runGuard(() => DRC.read()));
  $('btn-lim-read').addEventListener('click', () => App.runGuard(() => DRC.read()));

  /* ── device ── */
  $('btn-id-read').addEventListener('click', () => App.runGuard(() => Identity.refresh()));
  $('btn-id-refresh').addEventListener('click', () => App.runGuard(() => Identity.refresh()));
  $('btn-id-write-str').addEventListener('click', () => App.runGuard(() => Identity.writeStrings()));
  $('btn-id-write-vpid').addEventListener('click', () => App.runGuard(() => Identity.writeVidPid()));
  $('btn-apply-profile').addEventListener('click', () => {
    const name = $('sel-profile').value;
    const p = PROFILES[name];
    if (!p) return;
    History.push('profile switch');
    hid.profile = p;
    state.banks = makeBanks();
    rebuildFlags();
    App.buildBands();
    App.onProfileResolved(p);
    App.setControlsEnabled(hid.connected);
    Graph.setBands(state.banks[state.bank]);
    App.markAllDirty();
    log(`Profile override → ${p.name} (${p.bandCount} bands, DAC base ${hex(hid.reg('EQ_DAC'))}, ACK ${hex(p.writeAck)}). Read the device to confirm the map is right.`, 'warn');
    toast(`Profile set to ${p.name}. Read the device to load its state.`, 'ok', 5000);
  });
  $('btn-mempeek').addEventListener('click', async () => {
    if (!hid.connected) return;
    const raw = ($('mem-addr').value || '').trim().replace(/^0x/i, '');
    const base = parseInt(raw, 16);
    if (!Number.isFinite(base)) { toast('That is not a hex address.', 'warn'); return; }
    try {
      const words = [];
      for (let i = 0; i < 16; i++) words.push((await memRead32((base + i * 4) >>> 0)).toString(16).padStart(8, '0'));
      $('mem-out').textContent = `${hex(base)}\n` + words.map((w, i) =>
        `${(base + i * 4).toString(16).padStart(8, '0')}  ${w}`).join('\n');
      log(`Peeked 16 words from ${hex(base)} (read-only).`, 'inf');
    } catch (err) { log('Peek failed: ' + err.message, 'err'); }
  });
  $('btn-copy-roster').addEventListener('click', () => {
    downloadText('ktmicro-roster.json', JSON.stringify({ source: 'KT_BOOT_TOOL 1.0.58 strings', roster: ROSTER }, null, 2), 'application/json');
    log('Roster exported as JSON.');
  });

  /* ── registers ── */
  $('btn-reg-dump').addEventListener('click', () => App.runGuard(() => Registers.dump()));
  $('btn-reg-export-json').addEventListener('click', () => Registers.export('json'));
  $('btn-reg-export-csv').addEventListener('click', () => Registers.export('csv'));
  $('reg-search').addEventListener('input', e => { Registers.filter = e.target.value.trim().toLowerCase(); Registers.render(); });
  $('chk-reg-diff').addEventListener('click', e => {
    Registers.showDiff = !Registers.showDiff;
    e.currentTarget.setAttribute('aria-pressed', String(Registers.showDiff));
    Registers.render();
  });
  $('btn-ext-dump').addEventListener('click', () => App.runGuard(() =>
    ExtSpace.dumpWords(parseInt(($('ext-addr').value || '').replace(/^0x/i, ''), 16), parseInt($('ext-count').value, 10))));
  $('btn-ext-export').addEventListener('click', () => ExtSpace.export());

  /* ── firmware ── */
  $('btn-fw-load').addEventListener('click', () => $('file-fw').click());
  $('file-fw').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { await FwBin.load(f); App.renderFirmware(); App.enableCompare(); }
    catch (err) { log('Image load failed: ' + err.message, 'err'); toast(err.message, 'error', 5000); }
  });

  /* Compare against a second image. The first image stays the reference: it is
     the one loaded for patching, so "does my patch change anything audible"
     and "is this build the same one" are the same comparison. */
  $('btn-fw-cmp-load').addEventListener('click', () => $('file-fw2').click());
  $('file-fw2').addEventListener('change', async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      FwCompare.name = f.name;
      FwCompare.buf = buf;
      log(`Compare image loaded: ${f.name} (${buf.length} B).`, 'ok');
      App.renderFirmwareCompare();
    } catch (err) {
      log('Compare load failed: ' + err.message, 'err');
      toast(err.message, 'error', 5000);
    }
  });
  $('btn-fw-cmp-clear').addEventListener('click', () => {
    FwCompare.buf = null; FwCompare.name = '';
    App.renderFirmwareCompare();
  });

  $('btn-fw-patch').addEventListener('click', () => {
    if (!FwBin.buf || FwBin.dacOff < 0) { toast('Load a firmware image first.', 'warn'); return; }
    const en = FwBin.patchEnable();
    FwBin.patchTable(FwBin.dacOff, state.banks.DAC);
    if (FwBin.adcOff >= 0 && state.banks.ADC) FwBin.patchTable(FwBin.adcOff, state.banks.ADC);
    log(`Patched ${FwBin.name}: DAC@${hex(FwBin.dacOff)}`
      + (FwBin.adcOff >= 0 ? `, ADC@${hex(FwBin.adcOff)}` : '')
      + (en ? `, enable ${hex(FwBin.enOff)} 0x${en[0].toString(16)}→0x${en[1].toString(16)}` : '')
      + `, ${FwBin.patchedBytes()} bytes changed.`, 'ok');
    App.renderFirmware();
    toast('Image patched — export it, then flash from the panel below.', 'ok', 5000);
  });
  $('btn-fw-export').addEventListener('click', () => {
    if (!FwBin.buf) return;
    downloadBlob(FwBin.name.replace(/\.bin$/i, '') + '_patched.bin', FwBin.exportBlob());
    log('Patched image exported.', 'ok');
  });
  for (const b of document.querySelectorAll('.seg-group [data-transport]')) {
    b.addEventListener('click', () => App.setBootTransport(b.dataset.transport));
  }
  $('btn-boot-connect').addEventListener('click', async () => {
    const cdc = App.bootMode() === 'cdc';
    try {
      const n = cdc
        ? await CDC.connect(parseInt($('boot-baud').value, 10) || 921600)
        : await BOOT.connect();
      log(`Bootloader connected over ${cdc ? 'CDC serial' : 'WebHID'}: ${n}`, 'ok');
      setStatus('Bootloader connected.', 'working', 'load a patched image before writing');
    } catch (err) {
      log('Boot connect failed: ' + err.message, 'err');
      toast(err.message, 'error', 5000);
    }
    App.updateBootUI();
  });
  $('btn-boot-disconnect').addEventListener('click', async () => {
    await App.bootLink().disconnect();
    App.updateBootUI();
    log('Bootloader disconnected.');
  });
  $('btn-boot-info').addEventListener('click', async () => {
    const cdc = App.bootMode() === 'cdc';
    if (!App.bootLink().connected) return;
    try {
      if (cdc) {
        const cid = await CDC.chipId();
        const fp = await CDC.fingerprint();
        $('boot-info').textContent =
          `CDC link at ${CDC.baud} baud\nchip ${cid ?? '?'}\n` +
          (fp?.size
            ? `image fingerprint — size ${fp.size} B, crc32 ${fp.crc}\n` +
              'NB this is a fingerprint of the resident image, not a read-back: this silicon has no software dump path.'
            : 'no INF fingerprint (expected on a flag=0 image)');
        setStatus('CDC handshake OK.', 'ok');
      } else {
        if (!await BOOT.sync()) throw new Error('no sync ACK — the unit may not be in boot mode');
        const ver = await BOOT.version();
        const cid = await BOOT.chipId();
        $('boot-info').textContent = `version ${JSON.stringify(ver)} · chip ${cid ?? '?'}\nhandshake OK`;
        setStatus('Bootloader handshake OK.', 'ok');
      }
    } catch (err) {
      $('boot-info').textContent = 'handshake failed: ' + err.message;
      setStatus('Boot handshake failed: ' + err.message, 'error');
    }
  });
  $('btn-boot-abort').addEventListener('click', () => {
    App.bootLink().abort();
    toast('Aborting after the current block — do not unplug.', 'warn', 5000);
  });
  $('btn-boot-flash').addEventListener('click', async () => {
    const link = App.bootLink();
    if (!link.connected || !FwBin.buf) return;
    if (Settings.data.confirmFlash && ($('boot-confirm').value || '').trim().toUpperCase() !== 'FLASH') {
      toast('Type FLASH in the confirm box to arm the write.', 'warn');
      $('boot-confirm').focus();
      return;
    }
    const blockers = FwBin.preflight().filter(c => c.state === 'fail');
    if (blockers.length) {
      toast('Preflight failed: ' + blockers.map(b => b.text.replace(/<[^>]+>/g, '')).join(' '), 'error', 9000);
      log('Flash refused by preflight.', 'err');
      return;
    }
    const cdc = App.bootMode() === 'cdc';
    if (Settings.data.confirmFlash && !confirm(
      'Write the patched image to the bootloader now?\n\n' +
      'Only ever flash an image you dumped from THIS unit. A foreign image can brick it, and no software-only recovery exists.\n' +
      (cdc ? 'This write goes over CDC serial; the unit resets itself when it finishes.\n' : '') +
      'Do not unplug during the write.'
    )) return;
    $('boot-progress').hidden = false;
    $('boot-progress').classList.remove('is-warn');
    $('btn-boot-abort').hidden = false;
    setStatus('Flashing the bootloader…', 'working');
    try {
      const opts = cdc ? {
        base: parseInt(($('boot-base').value || '0').trim(), 16) || 0,
        bankId: Math.max(0, Math.min(7, parseInt($('boot-bank').value, 10) || 0)),
      } : undefined;
      await link.flash(FwBin.buf, (p, done, total) => {
        $('boot-bar').style.width = (p * 100).toFixed(1) + '%';
        setStatus(`Flashing — block ${done} of ${total}…`, 'working', `${(p * 100).toFixed(0)}%`);
      }, opts);
      setStatus('Flash complete — replug the device.', 'ok');
      toast('Flash sequence finished. Replug the dongle.', 'ok', 8000);
    } catch (err) {
      $('boot-progress').classList.add('is-warn');
      log('Flash failed: ' + err.message, 'err');
      setStatus('Flash failed: ' + err.message, 'error', 'do not unplug, and do not retry until you know why');
      toast('Flash failed — ' + err.message, 'error', 9000);
    }
    $('boot-confirm').value = '';
    $('btn-boot-abort').hidden = true;
    setTimeout(() => { $('boot-progress').hidden = true; $('boot-bar').style.width = '0%'; }, 2500);
    App.updateBootUI();
  });

  /* ── log ── */
  $('btn-clear-log').addEventListener('click', () => Log.clear());
  $('log-search').addEventListener('input', e => { Log.search = e.target.value.trim().toLowerCase(); Log.paint(); });
  $('chk-log-follow').addEventListener('change', e => { Log.follow = e.target.checked; });
  $('btn-log-export').addEventListener('click', () => {
    downloadText(`ktlab-log-${nowStamp()}.txt`, Log.text());
    log('Log exported.', 'inf');
  });

  /* ── settings ── */
  const accentHost = $('accent-picker');
  accentHost.replaceChildren();
  for (const a of ACCENTS) {
    const b = el('button', 'accent-dot');
    b.type = 'button';
    b.dataset.accent = a;
    b.title = a;
    b.style.background = `var(--accent)`;
    b.setAttribute('aria-label', `accent ${a}`);
    b.addEventListener('click', () => {
      Settings.data.accent = a; Settings.save(); App.syncSettingsUI();
      log('Accent: ' + a);
    });
    accentHost.appendChild(b);
  }
  // Swatch dots need their own hue, so read each accent's own token.
  requestAnimationFrame(() => {
    ACCENTS.forEach(a => {
      const b = accentHost.querySelector(`[data-accent="${a}"]`);
      if (b) b.style.background = token(`--accent`) && readAccent(a);
    });
  });

  $('sel-theme').addEventListener('change', e => { Settings.data.theme = e.target.value; Settings.save(); App.syncSettingsUI(); });
  $('sel-queue-gap').addEventListener('change', e => {
    Settings.data.queueGap = +e.target.value;
    hid.queue.setGap(Settings.data.queueGap);
    Settings.save();
    log(`Register queue gap set to ${Settings.data.queueGap} ms.`);
  });
  $('sel-log-level').addEventListener('change', e => {
    Settings.data.logVerbose = e.target.value === 'dbg';
    Settings.save();
    log('Log verbosity: ' + (Settings.data.logVerbose ? 'verbose' : 'normal') + ' — ' + Log.buffer.length + ' entries buffered.');
  });
  $('chk-autosend').addEventListener('change', e => { Settings.data.autoSend = e.target.checked; Settings.save(); App.syncSettingsUI(); });
  $('chk-confirm-flash').addEventListener('change', e => { Settings.data.confirmFlash = e.target.checked; Settings.save(); });
  $('chk-reduce-motion').addEventListener('change', e => { Settings.data.reduceMotion = e.target.checked; Settings.save(); App.syncSettingsUI(); });
  $('btn-reset-settings').addEventListener('click', () => {
    if (!confirm('Restore every setting to its default? Presets are not touched.')) return;
    Settings.reset(); App.syncSettingsUI(); hid.queue.setGap(Settings.data.queueGap);
    log('Settings reset to defaults.');
  });
  $('btn-clear-presets').addEventListener('click', () => {
    if (!confirm('Delete every stored preset? This cannot be undone.')) return;
    Presets.clearAll(); App.renderPresets($('preset-search').value);
    log('All presets deleted.', 'warn');
  });

  /* ── final state ── */
  hid.queue.setGap(Settings.data.queueGap);
  App.setControlsEnabled(false);
  App.updateHistoryButtons();
  App.updateEqToggles();
  App.updateBankToggle();
  App.syncLabels();

  if (!navigator.hid) {
    setStatus('WebHID is not supported here — use Chrome or Edge on desktop.', 'error');
    $('btn-connect').disabled = true;
    log('WebHID unavailable in this browser.', 'err');
    return;
  }
  setStatus('Ready — Connect USB to begin.', 'idle', 'or press Ctrl+K');
  log(`KTLAB ready. Shortcuts: 1-6 sections · R read · W write · E EQ toggle · Ctrl+S preset · Ctrl+Z undo · ? help`);
  dbg(`secureContext=${window.isSecureContext} protocol=${location.protocol} dpr=${window.devicePixelRatio}`);

  // Permission survives a reload, so offer a one-click reconnect.
  HIDController.granted().then(devs => {
    if (!devs.length) return;
    const d = devs[0];
    toast(`Reconnect ${d.productName || 'the previous device'}?`, 'info', 9000, {
      label: 'Reconnect',
      run: () => App.connect(),
    });
    log(`${devs.length} device(s) already permitted by this browser.`);
  });
}

/** Publish the top bar's real height so the sticky sidebar offset tracks it.
 *  The bar wraps to two rows on narrow viewports, so a hardcoded value drifts. */
function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const apply = () => {
    const h = Math.round(bar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
  };
  apply();
  if ('ResizeObserver' in window) new ResizeObserver(apply).observe(bar);
  else window.addEventListener('resize', apply);
}

/** Read an accent's own --accent token, independent of the active theme. */
function readAccent(name) {
  const probe = document.createElement('div');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  probe.setAttribute('data-accent', name);
  const v = getComputedStyle(probe).getPropertyValue('--accent').trim();
  probe.remove();
  return v;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init(); trackTopbarHeight(); });
else { init(); trackTopbarHeight(); }
