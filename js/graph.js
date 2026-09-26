/* ═══════════════════════════════════════════════════════════════════════
   KTLAB · js/graph.js — the response plot.
   Loaded third. Owns: the canvas, the drag interaction, the hover
   readout, and the optional ghost / target overlays.

   Every colour comes from token() so a theme change repaints correctly.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const F_MIN = 20, F_MAX = 20000;

const Graph = {
  canvas: null, ctx: null,
  bands: [], opts: { dbMax: 14, fill: true, focus: false },
  ghost: null, target: null,
  dpr: 1, W: 0, H: 0,
  padL: 0, padR: 0, padT: 0, padB: 0,
  hover: -1, drag: -1, mouse: null,
  _onChange: null, _ro: null, _raf: 0,

  init(id) {
    this.canvas = $(id);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this._ro = new ResizeObserver(() => this.request());
    this._ro.observe(this.canvas);
    this._bindPointer();
    document.addEventListener('themechange', () => this.request());
    // A backgrounded tab throttles requestAnimationFrame, so the first paint
    // after the tab comes forward can land against a stale layout.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.request(); });
    this.request();
  },

  onBandChange(fn) { this._onChange = fn; },
  setBands(b) { this.bands = b || []; this.request(); },
  setGhost(bands) { this.ghost = bands; this.request(); },
  setTarget(target) { this.target = target; this.request(); },
  setOption(k, v) { this.opts[k] = v; this.request(); },
  get dbMax() { return this.opts.dbMax; },

  /* ── geometry ── */
  get plotW() { return Math.max(1, this.W - this.padL - this.padR); },
  get plotH() { return Math.max(1, this.H - this.padT - this.padB); },
  toX(f) { return this.padL + (Math.log10(f / F_MIN) / Math.log10(F_MAX / F_MIN)) * this.plotW; },
  toY(db) {
    const m = this.opts.dbMax;
    return this.padT + this.plotH / 2 - (clamp(db, -m, m) / m) * (this.plotH / 2);
  },
  toFreq(x) { return F_MIN * Math.pow(F_MAX / F_MIN, (x - this.padL) / this.plotW); },
  toDB(y) { return ((this.padT + this.plotH / 2 - y) / (this.plotH / 2)) * this.opts.dbMax; },

  pointOf(band) {
    const db = this.bands.reduce((s, b) => s + bandResponse(band.freq, b), 0);
    return { x: this.toX(band.freq), y: this.toY(db) };
  },

  hitTest(mx, my) {
    const r = 13 * this.dpr;
    for (let i = this.bands.length - 1; i >= 0; i--) {
      const p = this.pointOf(this.bands[i]);
      const dx = mx * this.dpr - p.x, dy = my * this.dpr - p.y;
      if (dx * dx + dy * dy <= r * r) return i;
    }
    return -1;
  },

  /* ── pointer interaction ──────────────────────────────────────────
       drag            frequency + gain
       shift or ctrl   frequency only
       alt             gain only
       right-click     mute / unmute that band
       double-click    reset the band to the profile default          */
  _bindPointer() {
    const c = this.canvas;
    const local = e => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const { x, y } = local(e);
      const idx = this.hitTest(x, y);
      if (idx >= 0) this._toggleMute(idx);
    });

    c.addEventListener('pointerdown', e => {
      if (!this.bands.length || e.button !== 0) return;
      const { x, y } = local(e);
      const idx = this.hitTest(x, y);
      if (idx < 0) return;
      this.drag = idx;
      this.hover = idx;
      c.setPointerCapture?.(e.pointerId);
      this._apply(x, y, e);
      this.request();
      e.preventDefault();
    });

    c.addEventListener('pointermove', e => {
      if (!this.bands.length) return;
      const { x, y } = local(e);
      this.mouse = { x, y };
      if (this.drag >= 0) { this._apply(x, y, e); this.request(); return; }
      const idx = this.hitTest(x, y);
      if (idx !== this.hover) { this.hover = idx; this.request(); }
      c.style.cursor = idx >= 0 ? 'grab' : 'default';
      this.showReadout(idx, x, y);
    });

    const end = e => {
      if (this.drag >= 0) {
        this.drag = -1;
        c.style.cursor = 'default';
        this.request();
        this._onChange?.(null, true);
      }
      c.releasePointerCapture?.(e.pointerId);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.mouse = null;
      if (this.drag < 0) { this.hover = -1; this.hideReadout(); this.request(); }
    });

    c.addEventListener('dblclick', e => {
      const { x, y } = local(e);
      const idx = this.hitTest(x, y);
      if (idx >= 0) this._resetBand(idx);
    });
  },

  _apply(x, y, e) {
    const b = this.bands[this.drag];
    if (!b) return;
    const gr = hid.profile.gainRange;
    const before = { f: b.freq, g: b.gain };
    const lockFreq = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!lockFreq) b.gain = Math.round(this.toDB(y * this.dpr) * 2) / 2;
    if (!e.altKey) b.freq = Math.round(this.toFreq(x * this.dpr));
    b.gain = clamp(b.gain, gr.min, gr.max);
    b.freq = clamp(b.freq, F_MIN, F_MAX);
    if (b.freq !== before.f || b.gain !== before.g) this._onChange?.(this.drag, false);
  },

  _toggleMute(i) {
    const f = bandFlag(this.bands[i].index);
    f.muted = !f.muted;
    App.refreshBand(i);
    App.refreshBandTools();
    this.request();
    log(`Band ${i + 1} ${f.muted ? 'muted' : 'unmuted'} locally.`, 'warn');
  },
  _resetBand(i) {
    const b = this.bands[i];
    const p = hid.profile;
    b.gain = 0;
    b.freq = p.defaultFreqs[i] ?? 1000;
    b.q = p.defaultQ ?? 1;
    b.filterType = 0;
    App.refreshBand(i);
    this._onChange?.(i, true);
    this.request();
  },

  /* ── hover readout ── */
  showReadout(idx, x, y) {
    const box = $('graph-readout');
    if (!box) return;
    if (idx < 0) { box.hidden = true; return; }
    const b = this.bands[idx];
    const flags = bandFlag(b.index);
    const type = FILTER_TYPES.find(t => t.value === b.filterType)?.label ?? '—';
    const sum = this.bands.reduce((s, bb) => s + (flags.muted && bb === b ? 0 : bandResponse(b.freq, bb)), 0);
    box.innerHTML =
      `<b>band ${idx + 1}</b>  ${fmtFreq(b.freq)} Hz   ${sgn(b.gain)} dB\n` +
      `Q ${b.q.toFixed(2)}   ${type}${flags.muted ? '\nmuted — not written' : ''}\n` +
      `sum here  <b>${sgn(sum)} dB</b>`;
    box.hidden = false;
    const w = box.offsetWidth, h = box.offsetHeight;
    const cw = this.canvas.offsetWidth, ch = this.canvas.offsetHeight;
    box.style.left = clamp(x + 16, 4, cw - w - 4) + 'px';
    box.style.top = clamp(y - h - 12, 4, ch - h - 4) + 'px';
  },
  hideReadout() { const b = $('graph-readout'); if (b) b.hidden = true; },

  /* ── render ── */
  request() {
    /* Anything derived from the band set must recompute on exactly the same
       schedule as the curve, or the two disagree. Calling the subscribers here
       — once, at the single choke point every mutation already funnels
       through — is what keeps the headroom readout honest: a new mutation path
       cannot forget to update it, which is the failure mode of adding a
       `App.updateHeadroom()` call to each of the sixteen places that request a
       redraw today. */
    if (this._subs) for (const fn of this._subs) { try { fn(this.bands); } catch (e) { console.warn('graph subscriber', e); } }
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  },
  onRequest(fn) { (this._subs ||= new Set()).add(fn); return () => this._subs.delete(fn); },

  draw() {
    const c = this.canvas, ctx = this.ctx;
    if (!c || !ctx) return;
    // A hidden view has no layout, and sizing the backing store to zero
    // would wipe the last good frame and make getImageData throw.
    const cw = c.clientWidth, ch = c.clientHeight;
    if (!cw || !ch) return;
    const DPR = this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const W = this.W = cw * DPR;
    const H = this.H = ch * DPR;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this.padL = 30 * DPR; this.padR = 12 * DPR;
    this.padT = 12 * DPR; this.padB = 18 * DPR;

    ctx.clearRect(0, 0, W, H);
    const C = {
      line:  token('--line'),
      line2: token('--line-2'),
      dim:   token('--text-3'),
      text:  token('--text-2'),
      boost: token('--boost'),
      cut:   token('--cut'),
      info:  token('--info'),
      dbg:   token('--dbg'),
      ok:    token('--ok'),
      err:   token('--err'),
      accent:token('--accent'),
      bg:    token('--bg-deep'),
    };
    const mono = (px, w = '') => `${w} ${px * DPR}px var(--mono), monospace`;

    /* grid */
    const m = this.opts.dbMax;
    const step = m <= 6 ? 2 : m <= 10 ? 5 : m <= 20 ? 5 : 10;
    ctx.font = mono(9);
    ctx.textBaseline = 'middle';
    for (let db = -m + step; db < m; db += step) {
      const y = this.toY(db);
      if (y < this.padT || y > H - this.padB) continue;
      ctx.strokeStyle = C.line;
      ctx.lineWidth = DPR;
      ctx.setLineDash([3 * DPR, 3 * DPR]);
      ctx.beginPath(); ctx.moveTo(this.padL, y); ctx.lineTo(W - this.padR, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'right';
      ctx.fillText(db > 0 ? `+${db}` : `${db}`, this.padL - 5 * DPR, y);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = C.dim;
    ctx.fillText('dB', 4 * DPR, this.padT + 4 * DPR);

    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = this.toX(f);
      ctx.strokeStyle = C.line;
      ctx.lineWidth = DPR;
      ctx.setLineDash([3 * DPR, 3 * DPR]);
      ctx.beginPath(); ctx.moveTo(x, this.padT); ctx.lineTo(x, H - this.padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.dim;
      ctx.textAlign = 'center';
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x, H - this.padB + 8 * DPR);
    }

    /* 0 dB axis */
    ctx.strokeStyle = C.line2;
    ctx.lineWidth = 1 * DPR;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(this.padL, this.toY(0)); ctx.lineTo(W - this.padR, this.toY(0)); ctx.stroke();

    if (!this.bands.length) {
      ctx.fillStyle = C.dim;
      ctx.font = mono(11);
      ctx.textAlign = 'center';
      ctx.fillText('connect a device, or press Ctrl+K for commands', (this.padL + W - this.padR) / 2, H / 2);
      return;
    }

    const solo = anySolo();
    const live = this.bands.filter(b => !bandFlag(b.index).muted);

    /* response path */
    const N = Math.min(560, Math.max(240, Math.round(this.plotW / DPR * 1.6)));
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, i / N);
      pts.push({ x: this.toX(f), y: this.toY(curveAt(f, live)) });
    }

    if (this.opts.fill) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, this.toY(0));
      for (const p of pts) ctx.lineTo(p.x, p.y);
      ctx.lineTo(pts[pts.length - 1].x, this.toY(0));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, this.padT, 0, H - this.padB);
      g.addColorStop(0, alpha('--accent', .22));
      g.addColorStop(.5, alpha('--accent', .06));
      g.addColorStop(1, alpha('--accent', 0));
      ctx.fillStyle = g;
      ctx.fill();
    }

    /* ghost (what the device currently holds) */
    if (this.ghost?.length) {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const f = F_MIN * Math.pow(F_MAX / F_MIN, i / N);
        const x = this.toX(f), y = this.toY(curveAt(f, this.ghost));
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = alpha('--dbg', .7);
      ctx.lineWidth = 1.5 * DPR;
      ctx.setLineDash([5 * DPR, 4 * DPR]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* target curve (AutoEQ) */
    if (this.target?.length) {
      ctx.beginPath();
      for (let i = 0; i < this.target.length; i++) {
        const t = this.target[i];
        const x = this.toX(t.freq), y = this.toY(t.gain);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = alpha('--info', .85);
      ctx.lineWidth = 1.5 * DPR;
      ctx.setLineDash([3 * DPR, 3 * DPR]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* live response */
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 2 * DPR;
    ctx.lineJoin = 'round';
    ctx.shadowColor = alpha('--accent', .8);
    ctx.shadowBlur = 6 * DPR;
    ctx.stroke();
    ctx.shadowBlur = 0;

    /* band handles */
    this.bands.forEach((b, i) => {
      const f = bandFlag(b.index);
      const dim = (f.muted || (solo && !f.solo));
      const p = this.pointOf(b);
      const isHot = this.drag === i || this.hover === i;
      const col = f.muted ? C.dim : b.gain > 0.05 ? C.boost : b.gain < -0.05 ? C.cut : C.text;
      ctx.globalAlpha = dim ? .32 : 1;

      ctx.strokeStyle = alpha('--line-2', .8);
      ctx.lineWidth = DPR;
      ctx.setLineDash([2 * DPR, 3 * DPR]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, H - this.padB); ctx.stroke();
      ctx.setLineDash([]);

      if (Math.abs(b.gain) >= 0.5 && !f.muted) {
        ctx.fillStyle = col;
        ctx.font = mono(9, '600');
        ctx.textAlign = 'center';
        ctx.fillText(sgn(b.gain), p.x, p.y - 13 * DPR);
      }

      const r = (5 + (isHot ? 2 : 0)) * DPR;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = f.muted ? C.bg : col;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6 * DPR;
      if (f.muted) {
        ctx.setLineDash([2 * DPR, 2 * DPR]);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fill();
      }
      ctx.fillStyle = f.muted ? C.dim : token('--bg-deep');
      ctx.font = mono(8, '700');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + .5 * DPR);

      ctx.globalAlpha = 1;
      ctx.textBaseline = 'alphabetic';
    });
  },
};

/* ── sparkline, used inside snapshot chips ── */
function drawSparkline(canvas, bands, active) {
  if (!canvas || !bands?.length) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth * DPR, H = canvas.clientHeight * DPR;
  if (!W || !H) return;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  const y0 = H / 2;
  ctx.strokeStyle = alpha('--line-2', .7);
  ctx.lineWidth = DPR;
  ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.stroke();

  const N = 60;
  let peak = 1;
  for (const b of bands) peak = Math.max(peak, Math.abs(b.gain));
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, i / N);
    const db = curveAt(f, bands);
    const x = (i / N) * W;
    const y = y0 - (db / peak) * (H / 2 - 2 * DPR);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = active ? token('--accent') : alpha('--accent', .5);
  ctx.lineWidth = 1.4 * DPR;
  ctx.stroke();
}
