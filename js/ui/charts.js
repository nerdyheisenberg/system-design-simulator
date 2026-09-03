// Tiny canvas charts — no dependencies, redrawn every animation frame.

import { fmtNum } from '../core/util.js';

export function drawChart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  if (canvas.width !== Math.floor(r.width * dpr) || canvas.height !== Math.floor(r.height * dpr)) {
    canvas.width = Math.floor(r.width * dpr);
    canvas.height = Math.floor(r.height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  const padL = 46, padR = 6, padT = 8, padB = 16;
  ctx.clearRect(0, 0, W, H);

  let max = opts.min ?? 0;
  let n = 0;
  for (const s of series) {
    n = Math.max(n, s.ring.length);
    for (let i = 0; i < s.ring.length; i++) max = Math.max(max, s.ring.at(i));
  }
  if (!isFinite(max) || max <= 0) max = 1;
  max *= 1.12;

  const log = opts.log && max > 200;
  const yOf = (v) => {
    const t = log ? Math.log10(1 + Math.max(0, v)) / Math.log10(1 + max) : v / max;
    return padT + (H - padT - padB) * (1 - Math.min(1, Math.max(0, t)));
  };

  // grid + labels
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = '#5c6b82';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  const ticks = log ? [0, max * 0.01, max * 0.1, max] : [0, max * 0.25, max * 0.5, max * 0.75, max];
  for (const t of ticks) {
    const y = yOf(t);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText((opts.fmt || fmtNum)(t), padL - 6, y);
  }

  const cap = Math.max(2, n);
  const xOf = (i) => padL + (W - padL - padR) * (i / (cap - 1));

  for (const s of series) {
    if (s.ring.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.6;
    ctx.beginPath();
    const off = cap - s.ring.length;
    for (let i = 0; i < s.ring.length; i++) {
      const x = xOf(i + off), y = yOf(s.ring.at(i));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(xOf(cap - 1), H - padB); ctx.lineTo(xOf(off), H - padB); ctx.closePath();
      ctx.fillStyle = s.color + '1e'; ctx.fill();
    }
  }

  // legend
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  let lx = padL + 4;
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, padT + 1, 7, 3);
    ctx.fillStyle = '#8fa3bd';
    ctx.font = '9.5px ui-monospace, monospace';
    const txt = `${s.label} ${(opts.fmt || fmtNum)(s.ring.last())}`;
    ctx.fillText(txt, lx + 11, padT - 2);
    lx += ctx.measureText(txt).width + 24;
  }
}

/** Horizontal bar list, used for the cost breakdown. */
export function drawBars(canvas, items, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  if (r.width < 2) return;
  canvas.width = Math.floor(r.width * dpr);
  canvas.height = Math.floor(r.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const max = Math.max(1, ...items.map((i) => i.value));
  const rowH = 20;
  ctx.font = '10px ui-monospace, monospace';
  items.slice(0, Math.floor(r.height / rowH)).forEach((it, i) => {
    const y = i * rowH + 3;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(120, y, r.width - 190, 13);
    ctx.fillStyle = it.color || '#38bdf8';
    ctx.fillRect(120, y, (r.width - 190) * (it.value / max), 13);
    ctx.fillStyle = '#c6d3e4'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(it.label.slice(0, 20), 4, y + 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#8fa3bd';
    ctx.fillText((opts.fmt || fmtNum)(it.value), r.width - 4, y + 2);
  });
}
