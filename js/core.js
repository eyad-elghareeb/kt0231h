/* ═══════════════════════════════════════════════════════════════════════
   KTLAB · js/core.js — foundation.
   Loaded first. Owns: DOM shorthand, formatting, theme engine, settings
   persistence, the session log, toasts and the status bar.

   Nothing in here knows about USB. Nothing after here re-implements any
   of it. Colours are only ever obtained through token(), never literals.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/* ── DOM ─────────────────────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* ── formatting ──────────────────────────────────────────────────────── */
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = a => Array.from(a).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const hex = (n, w = 4) => '0x' + Number(n).toString(16).toUpperCase().padStart(w, '0');
const h16 = n => Number(n).toString(16).toUpperCase().padStart(4, '0');
const sgn = (n, d = 1) => (n > 0 ? '+' : '') + n.toFixed(d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $00 = v => String(v).padStart(2, '0');

function debounce(fn, ms) {
  let t;
  const wrapped = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...a) => { clearTimeout(t); fn(...a); };
  return wrapped;
}
function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs = null;
  return (...a) => {
    lastArgs = a;
    const now = performance.now();
    const wait = ms - (now - last);
    if (wait <= 0) { last = now; fn(...a); }
    else if (!timer) timer = setTimeout(() => { timer = null; last = performance.now(); fn(...lastArgs); }, wait);
  };
}

function fmtFreq(f) {
  if (f >= 1000) return (f / 1000).toFixed(f % 1000 === 0 ? 0 : 2) + 'k';
  return String(f);
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}${$00(d.getMonth() + 1)}${$00(d.getDate())}-${$00(d.getHours())}${$00(d.getMinutes())}${$00(d.getSeconds())}`;
}

/* ── theme tokens ────────────────────────────────────────────────────── */
let _tokenCache = null;
function token(name) {
  if (!_tokenCache) _tokenCache = getComputedStyle(document.documentElement);
  return _tokenCache.getPropertyValue(name).trim();
}
/** Force a token re-read (call after any theme/accent change). */
function invalidateTokens() { _tokenCache = null; }
/** Read an alpha-adjusted colour for canvas work, without hardcoding rgba. */
function alpha(name, a) {
  const c = token(name);
  if (!c) return 'transparent';
  if (c.startsWith('#')) {
    const h = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1);
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  if (c.startsWith('rgb(')) return c.replace(/^rgb\(/, 'rgba(').replace(/\)$/, `, ${a})`);
  return c;
}

/* ── settings ────────────────────────────────────────────────────────── */
const SETTINGS_KEY = 'ktlab-settings-v1';
const THEME_ORDER = ['graphite', 'oled', 'light', 'contrast'];
const ACCENTS = ['mint', 'azure', 'amber', 'violet', 'rose'];

const Settings = {
  data: {
    theme: 'graphite',
    accent: 'mint',
    queueGap: 100,
    logVerbose: false,
    autoSend: false,
    confirmFlash: true,
    reduceMotion: false,
  },
  load() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* corrupt — fall back */ }
    if (stored && typeof stored === 'object') {
      for (const k of Object.keys(this.data)) {
        if (stored[k] !== undefined && typeof stored[k] === typeof this.data[k]) this.data[k] = stored[k];
      }
    }
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches && !localStorage.getItem(SETTINGS_KEY)) {
      this.data.theme = 'light';
    }
    return this.data;
  },
  save() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
    this.apply();
  },
  apply() {
    const d = this.data;
    const root = document.documentElement;
    root.dataset.theme = d.theme;
    root.dataset.accent = d.accent;
    root.dataset.motion = d.reduceMotion ? 'reduced' : 'full';
    invalidateTokens();
    document.dispatchEvent(new CustomEvent('themechange', { detail: d }));
  },
  setTheme(name) { this.data.theme = THEME_ORDER.includes(name) ? name : 'graphite'; this.save(); },
  cycleTheme() {
    const i = THEME_ORDER.indexOf(this.data.theme);
    this.setTheme(THEME_ORDER[(i + 1) % THEME_ORDER.length]);
    return this.data.theme;
  },
  reset() {
    this.data = { theme: 'graphite', accent: 'mint', queueGap: 100, logVerbose: false, autoSend: false, confirmFlash: true, reduceMotion: false };
    this.save();
  },
};

/* ── status bar ──────────────────────────────────────────────────────── */
function setStatus(msg, state = 'idle', hint = '') {
  const bar = $('status-bar');
  if (bar) bar.dataset.state = state;
  const t = $('status-text');
  if (t) t.textContent = msg;
  const h = $('status-hint');
  if (h) h.textContent = hint;
}
function setStatusMeta(txt) { const m = $('status-meta'); if (m) m.textContent = txt; }

/* ── session log ─────────────────────────────────────────────────────── */
const Log = {
  buffer: [],        // { ts, kind, msg }
  kinds: new Set(['tx', 'rx', 'err', 'warn', 'ok', 'inf']),
  search: '',
  follow: true,
  MAX: 600,

  add(msg, kind = 'inf') {
    const entry = { ts: new Date(), kind, msg: String(msg) };
    this.buffer.push(entry);
    if (this.buffer.length > this.MAX) this.buffer.shift();
    if (kind === 'dbg' && !Settings.data.logVerbose) return;
    if (!this.kinds.has(kind)) return;
    this.paint();
    const badge = $('rail-log-badge');
    if (badge) {
      const errs = this.buffer.filter(e => e.kind === 'err').length;
      badge.textContent = errs ? `${errs}!` : String(this.buffer.length);
      badge.hidden = false;
    }
  },
  matches(e) {
    if (!this.kinds.has(e.kind)) return false;
    if (this.search && !e.msg.toLowerCase().includes(this.search)) return false;
    return true;
  },
  paint() {
    const box = $('log');
    if (!box) return;
    const rows = this.buffer.filter(e => this.matches(e));
    if (!rows.length) {
      box.innerHTML = `<div class="log-empty">${this.buffer.length ? 'nothing matches the current filter' : 'no output yet'}</div>`;
      return;
    }
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
    const frag = document.createDocumentFragment();
    for (const e of rows) {
      const d = el('div', 'log-line ' + e.kind);
      const t = e.ts.toLocaleTimeString('en-GB', { hour12: false });
      d.innerHTML = `<span class="log-ts">${t}</span>${esc(e.msg)}`;
      frag.appendChild(d);
    }
    box.replaceChildren(frag);
    if (this.follow && atBottom) box.scrollTop = box.scrollHeight;
  },
  clear() { this.buffer.length = 0; this.paint(); const b = $('rail-log-badge'); if (b) b.hidden = true; },
  text() {
    return this.buffer.map(e => `[${e.ts.toISOString()}] ${e.kind.toUpperCase().padEnd(4)} ${e.msg}`).join('\n');
  },
};

const log     = (m, k = 'inf') => Log.add(m, k);
const logTx   = d => Log.add('TX → ' + fmt(d), 'tx');
const logRx   = d => { if (d?.length) Log.add('RX ← ' + fmt(d), 'rx'); };
function dbg(m) { if (Settings.data.logVerbose) Log.add('[DBG] ' + m, 'dbg'); }

/* ── toasts ──────────────────────────────────────────────────────────── */
function toast(msg, type = 'info', durationMs = 3200, action = null) {
  const root = $('toast-root');
  if (!root) return;
  const node = el('div', 'toast toast-' + type);
  node.appendChild(el('span', null, msg));
  if (action) {
    const b = el('button', 'toast-act', action.label);
    b.addEventListener('click', () => { action.run(); dismiss(); });
    node.appendChild(b);
  }
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    node.classList.remove('in');
    setTimeout(() => node.remove(), 220);
  };
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  if (durationMs > 0) setTimeout(dismiss, durationMs);
  return dismiss;
}

/* ── downloads ───────────────────────────────────────────────────────── */
function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function downloadText(name, text, mime = 'text/plain') {
  downloadBlob(name, new Blob([text], { type: mime }));
}

/* ── modal helpers ───────────────────────────────────────────────────── */
let lastFocus = null;
function openOverlay(id) {
  lastFocus = document.activeElement;
  const o = $(id);
  if (!o) return;
  o.hidden = false;
  const focusable = o.querySelector('input, button, select, textarea');
  focusable?.focus();
}
function closeOverlay(id) {
  const o = $(id);
  if (!o) return;
  o.hidden = true;
  if (lastFocus?.isConnected) lastFocus.focus();
  lastFocus = null;
}
function anyOverlayOpen() {
  return $$('.overlay').some(o => !o.hidden);
}

/* ── boot ────────────────────────────────────────────────────────────── */
Settings.load();
Settings.apply();
