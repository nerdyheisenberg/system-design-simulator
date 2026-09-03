// CANVAS EDITOR
// Infinite pan/zoom canvas: node placement, edge drawing, selection, and the
// packet animation layer that shows individual sampled requests travelling
// through the topology.

import { BY_ID, CATEGORIES } from '../model/catalog.js';
import { clamp, uid, fmtNum } from '../core/util.js';

const NODE_W = 158, NODE_H = 62, PORT_R = 6;
const KIND_COLOR = {
  default: '#4a5a72', read: '#38bdf8', write: '#fb923c',
  replication: '#7c8aa0', fallback: '#a78bfa', async: '#c084fc',
};
const OUTCOME_COLOR = { ok: '#4ade80', throttled: '#fbbf24', dropped: '#f87171', timeout: '#fb923c', error: '#ef4444' };

export class CanvasEditor {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { x: 0, y: 0, k: 1 };
    this.graph = null;
    this.engine = null;
    this.selection = new Set();
    this.selectedEdge = null;
    this.hover = null;
    this.hoverPort = null;
    this.linking = null;
    this.dragging = null;
    this.panning = null;
    this.marquee = null;
    this.packets = [];
    this.showPackets = true;
    this.on = opts;
    this._bind();
    this.resize();
  }

  setGraph(g) { this.graph = g; this.selection.clear(); this.selectedEdge = null; this.packets.length = 0; }
  setEngine(e) { this.engine = e; }

  // ------------------------------------------------------------ coordinates

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this.dpr = dpr; this.w = r.width; this.h = r.height;
  }

  toWorld(px, py) { return { x: (px - this.view.x) / this.view.k, y: (py - this.view.y) / this.view.k }; }
  toScreen(x, y) { return { x: x * this.view.k + this.view.x, y: y * this.view.k + this.view.y }; }
  center(n) { return { x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 }; }
  outPort(n) { return { x: n.x + NODE_W, y: n.y + NODE_H / 2 }; }
  inPort(n) { return { x: n.x, y: n.y + NODE_H / 2 }; }

  nodeAt(wx, wy) {
    if (!this.graph) return null;
    for (let i = this.graph.nodes.length - 1; i >= 0; i--) {
      const n = this.graph.nodes[i];
      if (wx >= n.x && wx <= n.x + NODE_W && wy >= n.y && wy <= n.y + NODE_H) return n;
    }
    return null;
  }

  edgeAt(wx, wy) {
    if (!this.graph) return null;
    const byId = new Map(this.graph.nodes.map((n) => [n.id, n]));
    for (const e of this.graph.edges) {
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b) continue;
      const p0 = this.outPort(a), p1 = this.inPort(b);
      for (let t = 0; t <= 1; t += 0.04) {
        const p = bezier(p0, p1, t);
        if (Math.hypot(p.x - wx, p.y - wy) < 8) return e;
      }
    }
    return null;
  }

  fit() {
    if (!this.graph || !this.graph.nodes.length) { this.view = { x: 40, y: 40, k: 1 }; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.graph.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + NODE_H);
    }
    const pad = 60;
    const k = clamp(Math.min((this.w - pad * 2) / (maxX - minX), (this.h - pad * 2) / (maxY - minY)), 0.25, 1.4);
    this.view.k = k;
    this.view.x = (this.w - (maxX - minX) * k) / 2 - minX * k;
    this.view.y = (this.h - (maxY - minY) * k) / 2 - minY * k;
  }

  // ------------------------------------------------------------- interaction

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('dblclick', (e) => this.onDblClick(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onContext(e); });
    c.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', (e) => this.onDrop(e));
    window.addEventListener('resize', () => this.resize());
  }

  localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    const p = this.localPos(e);
    const w = this.toWorld(p.x, p.y);
    const node = this.nodeAt(w.x, w.y);

    if (node) {
      const op = this.outPort(node);
      if (Math.hypot(w.x - op.x, w.y - op.y) < 14) {
        this.linking = { from: node.id, x: w.x, y: w.y };
        return;
      }
      if (!this.selection.has(node.id)) {
        if (!e.shiftKey) this.selection.clear();
        this.selection.add(node.id);
      } else if (e.shiftKey) this.selection.delete(node.id);
      this.selectedEdge = null;
      this.dragging = { startX: w.x, startY: w.y, orig: new Map([...this.selection].map((id) => { const n = this.graph.nodes.find((x) => x.id === id); return [id, { x: n.x, y: n.y }]; })) };
      this.on.onSelect?.(this.selectionInfo());
      return;
    }

    const edge = this.edgeAt(w.x, w.y);
    if (edge) {
      this.selection.clear();
      this.selectedEdge = edge;
      this.on.onSelect?.(this.selectionInfo());
      return;
    }

    if (e.shiftKey) { this.marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y }; return; }
    this.selection.clear(); this.selectedEdge = null;
    this.on.onSelect?.(this.selectionInfo());
    this.panning = { px: p.x, py: p.y, vx: this.view.x, vy: this.view.y };
  }

  onMove(e) {
    const p = this.localPos(e);
    const w = this.toWorld(p.x, p.y);
    if (this.panning) {
      this.view.x = this.panning.vx + (p.x - this.panning.px);
      this.view.y = this.panning.vy + (p.y - this.panning.py);
      return;
    }
    if (this.dragging) {
      const dx = w.x - this.dragging.startX, dy = w.y - this.dragging.startY;
      for (const [id, o] of this.dragging.orig) {
        const n = this.graph.nodes.find((x) => x.id === id);
        if (n) { n.x = Math.round((o.x + dx) / 10) * 10; n.y = Math.round((o.y + dy) / 10) * 10; }
      }
      return;
    }
    if (this.linking) { this.linking.x = w.x; this.linking.y = w.y; return; }
    if (this.marquee) { this.marquee.x1 = w.x; this.marquee.y1 = w.y; return; }
    const n = this.nodeAt(w.x, w.y);
    this.hover = n ? n.id : null;
    this.hoverPort = null;
    if (n) {
      const op = this.outPort(n);
      if (Math.hypot(w.x - op.x, w.y - op.y) < 14) this.hoverPort = n.id;
    }
    this.canvas.style.cursor = this.hoverPort ? 'crosshair' : n ? 'grab' : 'default';
  }

  onUp(e) {
    if (this.linking) {
      const p = this.localPos(e);
      const w = this.toWorld(p.x, p.y);
      const target = this.nodeAt(w.x, w.y);
      if (target && target.id !== this.linking.from) this.addEdge(this.linking.from, target.id);
      this.linking = null;
    }
    if (this.marquee) {
      const { x0, y0, x1, y1 } = this.marquee;
      const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
      for (const n of this.graph.nodes) {
        if (n.x + NODE_W > ax && n.x < bx && n.y + NODE_H > ay && n.y < by) this.selection.add(n.id);
      }
      this.marquee = null;
      this.on.onSelect?.(this.selectionInfo());
    }
    if (this.dragging) { this.dragging = null; this.on.onChange?.(); }
    this.panning = null;
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.localPos(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k2 = clamp(this.view.k * factor, 0.2, 2.6);
    const w = this.toWorld(p.x, p.y);
    this.view.k = k2;
    this.view.x = p.x - w.x * k2;
    this.view.y = p.y - w.y * k2;
  }

  onDblClick(e) {
    const p = this.localPos(e);
    const w = this.toWorld(p.x, p.y);
    const edge = this.edgeAt(w.x, w.y);
    if (edge) {
      const kinds = ['default', 'read', 'write', 'replication', 'fallback'];
      edge.kind = kinds[(kinds.indexOf(edge.kind || 'default') + 1) % kinds.length];
      this.on.onChange?.();
    }
  }

  onContext(e) {
    const p = this.localPos(e);
    const w = this.toWorld(p.x, p.y);
    const node = this.nodeAt(w.x, w.y);
    const edge = node ? null : this.edgeAt(w.x, w.y);
    this.on.onContextMenu?.({ node, edge, clientX: e.clientX, clientY: e.clientY });
  }

  onDrop(e) {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/component');
    if (!type || !BY_ID[type]) return;
    const p = this.localPos(e);
    const w = this.toWorld(p.x, p.y);
    this.addNode(type, w.x - NODE_W / 2, w.y - NODE_H / 2);
  }

  // ----------------------------------------------------------------- mutation

  addNode(type, x, y) {
    const def = BY_ID[type];
    const node = { id: uid(), type, x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10, label: def.name, cfg: {} };
    this.graph.nodes.push(node);
    this.selection.clear(); this.selection.add(node.id);
    this.on.onChange?.();
    this.on.onSelect?.(this.selectionInfo());
    return node;
  }

  addEdge(from, to) {
    if (this.graph.edges.some((e) => e.from === from && e.to === to)) return;
    this.graph.edges.push({ id: uid('e'), from, to, kind: 'default', weight: 1 });
    this.on.onChange?.();
  }

  deleteSelection() {
    if (this.selectedEdge) {
      this.graph.edges = this.graph.edges.filter((e) => e !== this.selectedEdge);
      this.selectedEdge = null;
      this.on.onChange?.(); this.on.onSelect?.(this.selectionInfo());
      return;
    }
    if (!this.selection.size) return;
    this.graph.nodes = this.graph.nodes.filter((n) => !this.selection.has(n.id));
    this.graph.edges = this.graph.edges.filter((e) => !this.selection.has(e.from) && !this.selection.has(e.to));
    this.selection.clear();
    this.on.onChange?.(); this.on.onSelect?.(this.selectionInfo());
  }

  duplicateSelection() {
    const map = new Map();
    const added = [];
    for (const id of this.selection) {
      const n = this.graph.nodes.find((x) => x.id === id);
      if (!n) continue;
      const copy = { ...n, id: uid(), x: n.x + 30, y: n.y + 30, cfg: { ...n.cfg } };
      map.set(id, copy.id); this.graph.nodes.push(copy); added.push(copy.id);
    }
    for (const e of [...this.graph.edges]) {
      if (map.has(e.from) && map.has(e.to)) this.graph.edges.push({ ...e, id: uid('e'), from: map.get(e.from), to: map.get(e.to) });
    }
    this.selection = new Set(added);
    this.on.onChange?.(); this.on.onSelect?.(this.selectionInfo());
  }

  selectionInfo() {
    if (this.selectedEdge) return { kind: 'edge', edge: this.selectedEdge };
    if (this.selection.size === 1) {
      const id = [...this.selection][0];
      return { kind: 'node', node: this.graph.nodes.find((n) => n.id === id) };
    }
    if (this.selection.size > 1) return { kind: 'multi', ids: [...this.selection] };
    return { kind: 'none' };
  }

  highlight(ids) {
    this.highlighted = new Set(ids || []);
    this.highlightUntil = performance.now() + 2600;
  }

  // ----------------------------------------------------------------- packets

  spawnPackets(samples) {
    if (!this.showPackets || !samples?.length) return;
    if (this.packets.length > 220) return;
    const step = Math.max(1, Math.floor(samples.length / 14));
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i];
      if (s.path.length < 2) continue;
      this.packets.push({ path: s.path, outcome: s.outcome, seg: 0, t: 0, speed: 1.6 + Math.random() * 1.2, life: 1 });
    }
  }

  stepPackets(dt) {
    const byId = new Map(this.graph ? this.graph.nodes.map((n) => [n.id, n]) : []);
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      p.t += dt * p.speed;
      while (p.t >= 1) {
        p.t -= 1; p.seg++;
        if (p.seg >= p.path.length - 1) { p.done = true; break; }
      }
      if (p.done) { p.life -= dt * 2.5; if (p.life <= 0) this.packets.splice(i, 1); }
      if (!byId.has(p.path[Math.min(p.seg, p.path.length - 1)])) this.packets.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------ render

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#0c1018';
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid();
    if (!this.graph) return;

    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.k, this.view.k);

    const byId = new Map(this.graph.nodes.map((n) => [n.id, n]));
    for (const e of this.graph.edges) this.drawEdge(e, byId);
    if (this.linking) {
      const a = byId.get(this.linking.from);
      if (a) {
        ctx.save();
        ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        const p0 = this.outPort(a);
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y);
        ctx.bezierCurveTo(p0.x + 60, p0.y, this.linking.x - 60, this.linking.y, this.linking.x, this.linking.y);
        ctx.stroke(); ctx.restore();
      }
    }
    if (this.showPackets) this.drawPackets(byId);
    for (const n of this.graph.nodes) this.drawNode(n);
    if (this.marquee) {
      const { x0, y0, x1, y1 } = this.marquee;
      ctx.fillStyle = 'rgba(96,165,250,0.12)'; ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();
  }

  drawGrid() {
    const ctx = this.ctx;
    const k = this.view.k, size = 26 * k;
    if (size < 8) return;
    const ox = this.view.x % size, oy = this.view.y % size;
    ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ox; x < this.w; x += size) { ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    for (let y = oy; y < this.h; y += size) { ctx.moveTo(0, y); ctx.lineTo(this.w, y); }
    ctx.stroke();
  }

  drawEdge(e, byId) {
    const ctx = this.ctx;
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) return;
    const p0 = this.outPort(a), p1 = this.inPort(b);
    const st = this.engine?.edges.get(e.id);
    const rate = st?.rate || 0;
    const selected = this.selectedEdge === e;
    const base = KIND_COLOR[e.kind || 'default'] || KIND_COLOR.default;

    ctx.save();
    ctx.strokeStyle = selected ? '#e2e8f0' : base;
    ctx.lineWidth = selected ? 3 : clamp(1.1 + Math.log10(1 + rate) * 0.55, 1.1, 5.5);
    if (e.kind === 'replication') ctx.setLineDash([6, 5]);
    if (e.kind === 'fallback') ctx.setLineDash([2, 4]);
    ctx.globalAlpha = rate > 0 ? 1 : 0.55;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(p0.x + curve(p0, p1), p0.y, p1.x - curve(p0, p1), p1.y, p1.x, p1.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // arrow head
    const t = 0.985, pA = bezier(p0, p1, t - 0.02), pB = bezier(p0, p1, t);
    const ang = Math.atan2(pB.y - pA.y, pB.x - pA.x);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p1.x - 9 * Math.cos(ang - 0.42), p1.y - 9 * Math.sin(ang - 0.42));
    ctx.lineTo(p1.x - 9 * Math.cos(ang + 0.42), p1.y - 9 * Math.sin(ang + 0.42));
    ctx.closePath(); ctx.fill();

    if ((e.kind && e.kind !== 'default') || rate > 0) {
      const mid = bezier(p0, p1, 0.5);
      const txt = e.kind && e.kind !== 'default' ? e.kind : `${fmtNum(rate)}/s`;
      ctx.font = '10px ui-monospace, monospace';
      const wpx = ctx.measureText(txt).width + 10;
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#0f1622';
      roundRect(ctx, mid.x - wpx / 2, mid.y - 8, wpx, 16, 4); ctx.fill();
      ctx.fillStyle = e.kind && e.kind !== 'default' ? base : '#8fa3bd';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, mid.x, mid.y);
    }
    ctx.restore();
  }

  drawPackets(byId) {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.packets) {
      const i = Math.min(p.seg, p.path.length - 2);
      const a = byId.get(p.path[i]), b = byId.get(p.path[i + 1]);
      if (!a || !b) continue;
      const p0 = this.outPort(a), p1 = this.inPort(b);
      const pos = bezier(p0, p1, clamp(p.t, 0, 1));
      const col = OUTCOME_COLOR[p.outcome] || '#94a3b8';
      ctx.globalAlpha = p.life;
      ctx.fillStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, p.done ? 5 : 3.1, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  drawNode(n) {
    const ctx = this.ctx;
    const def = BY_ID[n.type];
    if (!def) return;
    const cat = CATEGORIES[def.cat] || { color: '#7c8aa0' };
    const st = this.engine?.nodes.get(n.id);
    const selected = this.selection.has(n.id);
    const hi = this.highlighted?.has(n.id) && performance.now() < this.highlightUntil;

    const rho = st ? clamp(st.rho, 0, 1.4) : 0;
    let health = '#2b3a4f';
    if (st && st.down) health = '#ef4444';
    else if (rho > 1) health = '#ef4444';
    else if (rho > 0.85) health = '#f97316';
    else if (rho > 0.7) health = '#facc15';
    else if (rho > 0.02) health = '#4ade80';

    ctx.save();
    // shadow / glow
    if (st && (st.down || rho > 1)) { ctx.shadowColor = 'rgba(239,68,68,0.55)'; ctx.shadowBlur = 22; }
    else if (hi) { ctx.shadowColor = 'rgba(96,165,250,0.9)'; ctx.shadowBlur = 26; }
    ctx.fillStyle = '#151d2b';
    roundRect(ctx, n.x, n.y, NODE_W, NODE_H, 9); ctx.fill();
    ctx.shadowBlur = 0;

    // left category stripe
    ctx.fillStyle = cat.color;
    ctx.save(); ctx.beginPath(); roundRect(ctx, n.x, n.y, NODE_W, NODE_H, 9); ctx.clip();
    ctx.fillRect(n.x, n.y, 4, NODE_H); ctx.restore();

    ctx.strokeStyle = selected ? '#e2e8f0' : hi ? '#60a5fa' : 'rgba(255,255,255,0.09)';
    ctx.lineWidth = selected || hi ? 2 : 1;
    roundRect(ctx, n.x, n.y, NODE_W, NODE_H, 9); ctx.stroke();

    // glyph badge
    ctx.fillStyle = cat.color + '22';
    roundRect(ctx, n.x + 11, n.y + 10, 30, 18, 4); ctx.fill();
    ctx.fillStyle = cat.color;
    ctx.font = '600 10px ui-monospace, SFMono-Regular, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(def.glyph, n.x + 26, n.y + 19.5);

    // title
    ctx.fillStyle = '#e6edf7';
    ctx.font = '600 11.5px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(trunc(ctx, n.label || def.name, NODE_W - 58), n.x + 48, n.y + 19);

    // subtitle
    ctx.fillStyle = '#7d8ea6';
    ctx.font = '10px ui-monospace, monospace';
    const sub = st
      ? `${fmtNum(st.inRate)}/s · ${(rho * 100).toFixed(0)}%${st.replicasNow > 1 ? ` · x${Math.round(st.replicasNow)}` : ''}`
      : def.name;
    ctx.fillText(trunc(ctx, sub, NODE_W - 24), n.x + 12, n.y + 38);

    // utilisation bar
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(ctx, n.x + 11, n.y + 46, NODE_W - 22, 5, 2.5); ctx.fill();
    ctx.fillStyle = health;
    roundRect(ctx, n.x + 11, n.y + 46, (NODE_W - 22) * clamp(rho, 0, 1), 5, 2.5); ctx.fill();
    if (rho > 1) {
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(n.x + 11, n.y + 46, NODE_W - 22, 5);
    }

    // badges
    const badges = [];
    if (st?.down) badges.push(['DOWN', '#ef4444']);
    if (st?.breakerOpen) badges.push(['OPEN', '#a78bfa']);
    if (st?.queue > 50) badges.push(['Q' + fmtNum(st.queue), '#fbbf24']);
    if (st?.dropRate > 1) badges.push(['DROP', '#f87171']);
    let bx = n.x + NODE_W - 8;
    ctx.font = '600 8.5px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (const [txt, col] of badges.slice(0, 2)) {
      const wpx = ctx.measureText(txt).width + 8;
      ctx.fillStyle = col + '28';
      roundRect(ctx, bx - wpx, n.y + 8, wpx, 13, 3); ctx.fill();
      ctx.fillStyle = col;
      ctx.fillText(txt, bx - 4, n.y + 15);
      bx -= wpx + 4;
    }

    // ports
    const op = this.outPort(n);
    ctx.fillStyle = this.hoverPort === n.id ? '#60a5fa' : 'rgba(255,255,255,0.28)';
    ctx.beginPath(); ctx.arc(op.x, op.y, this.hoverPort === n.id ? PORT_R + 2 : PORT_R, 0, Math.PI * 2); ctx.fill();
    const ip = this.inPort(n);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(ip.x, ip.y, 4, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }
}

// ------------------------------------------------------------------ helpers

function curve(p0, p1) { return Math.max(40, Math.min(140, Math.abs(p1.x - p0.x) * 0.45)); }

function bezier(p0, p1, t) {
  const c = curve(p0, p1);
  const x0 = p0.x, y0 = p0.y, x1 = p0.x + c, y1 = p0.y, x2 = p1.x - c, y2 = p1.y, x3 = p1.x, y3 = p1.y;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
    y: mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function trunc(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

export { NODE_W, NODE_H };
