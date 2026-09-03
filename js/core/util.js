// Deterministic RNG, statistics and small helpers shared by engine + UI.

/** mulberry32 — small, fast, seedable. Same seed => identical simulation run. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (n) => Math.floor(next() * n);
  next.bool = (p) => next() < p;
  /** Box-Muller, cached second variate. */
  let spare = null;
  next.normal = (mu = 0, sd = 1) => {
    if (spare !== null) { const v = spare; spare = null; return mu + sd * v; }
    let u = 0, v = 0, s = 0;
    do { u = next() * 2 - 1; v = next() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return mu + sd * u * f;
  };
  next.exp = (mean) => -Math.log(1 - next()) * mean;
  /** Service times in real systems are right-skewed; lognormal is the standard fit. */
  next.lognormal = (median, sigma = 0.45) => median * Math.exp(next.normal(0, sigma));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Fixed-size ring buffer of numbers — used for every metric time series. */
export class Ring {
  constructor(capacity) { this.cap = capacity; this.buf = new Float64Array(capacity); this.n = 0; this.head = 0; }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  clear() { this.n = 0; this.head = 0; }
  get length() { return this.n; }
  at(i) { // i = 0 is oldest
    const start = (this.head - this.n + this.cap) % this.cap;
    return this.buf[(start + i) % this.cap];
  }
  last() { return this.n ? this.buf[(this.head - 1 + this.cap) % this.cap] : 0; }
  toArray() { const out = new Float64Array(this.n); for (let i = 0; i < this.n; i++) out[i] = this.at(i); return out; }
  max() { let m = -Infinity; for (let i = 0; i < this.n; i++) m = Math.max(m, this.at(i)); return this.n ? m : 0; }
  mean() { let s = 0; for (let i = 0; i < this.n; i++) s += this.at(i); return this.n ? s / this.n : 0; }
}

/** Percentile from an unsorted Float64Array (mutates a copy). p in [0,1]. */
export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const a = Float64Array.from(values);
  a.sort();
  const idx = clamp(Math.floor(p * (a.length - 1)), 0, a.length - 1);
  return a[idx];
}

export function percentiles(values, ps) {
  if (!values || values.length === 0) return ps.map(() => 0);
  const a = Float64Array.from(values);
  a.sort();
  return ps.map((p) => a[clamp(Math.floor(p * (a.length - 1)), 0, a.length - 1)]);
}

// ---------------------------------------------------------------- formatting

export function fmtNum(v) {
  if (!isFinite(v)) return '∞';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k';
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs === 0) return '0';
  return v.toFixed(3);
}

export function fmtMs(v) {
  if (!isFinite(v)) return '∞';
  if (v >= 60000) return (v / 60000).toFixed(1) + 'min';
  if (v >= 1000) return (v / 1000).toFixed(2) + 's';
  if (v >= 10) return v.toFixed(0) + 'ms';
  if (v >= 1) return v.toFixed(1) + 'ms';
  return (v * 1000).toFixed(0) + 'µs';
}

export function fmtMoney(v) {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  return '$' + v.toFixed(0);
}

export function fmtPct(v, digits = 1) { return (v * 100).toFixed(digits) + '%'; }

export function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return b.toFixed(b >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

// ---------------------------------------------------------------- dom helpers

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uid(prefix = 'n') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
