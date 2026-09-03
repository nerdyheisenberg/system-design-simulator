// APPLICATION
// Wires the catalog, engine, doctor, canvas and panels together.

import { COMPONENTS, BY_ID, CATEGORIES, componentsByCategory, defaultCfg, deriveModel } from '../model/catalog.js';
import { BLUEPRINTS, blueprintToGraph } from '../model/blueprints.js';
import { MISSIONS, missionContext } from '../model/missions.js';
import { CHAOS, CHAOS_CATEGORIES, chaosFor } from '../model/chaos.js';
import { Engine } from '../engine/engine.js';
import { reviewStatic, diagnose, scoreDesign, chapterUrl, chapterLabel } from '../doctor/doctor.js';
import { CanvasEditor } from './canvas.js';
import { drawChart, drawBars } from './charts.js';
import { $, $$, el, clamp, uid, fmtNum, fmtMs, fmtMoney, fmtPct, escapeHtml, downloadJson, Ring } from '../core/util.js';

// ============================================================ state

const state = {
  graph: null,
  engine: new Engine(),
  editor: null,
  running: false,
  speed: 1,
  acc: 0,
  lastFrame: performance.now(),
  statics: [],
  runtimes: [],
  score: { score: 0, grade: '–', parts: {}, crit: 0, warn: 0 },
  mission: null,
  missionState: null,
  openFindings: new Set(),
  lastDoctor: 0,
  tab: 'inspect',
  selection: { kind: 'none' },
};

const SIM_STEP = 0.1; // simulated seconds per engine tick

// ============================================================ boot

function boot() {
  state.editor = new CanvasEditor($('#canvas'), {
    onChange: onGraphChange,
    onSelect: (sel) => { state.selection = sel; renderInspector(); },
    onContextMenu: showContextMenu,
  });

  const saved = localStorage.getItem('sds:graph');
  loadGraph(saved ? JSON.parse(saved) : blueprintToGraph(BLUEPRINTS.find((b) => b.id === 'naive')));

  buildPalette();
  bindToolbar();
  bindTabs();
  bindKeys();
  renderChaosPanel();
  state.editor.fit();
  requestAnimationFrame(loop);
  toast('Loaded. Press Run, then open the Doctor tab.', 3200);
}

function loadGraph(g, opts = {}) {
  state.graph = normaliseGraph(g);
  state.engine.load(state.graph);
  state.editor.setGraph(state.graph);
  state.editor.setEngine(state.engine);
  syncToolbarFromWorkload();
  onGraphChange(true);
  if (opts.fit !== false) state.editor.fit();
}

function normaliseGraph(g) {
  const out = {
    version: 1,
    name: g.name || 'Untitled design',
    workload: {
      rps: 2000, pattern: 'steady', readPct: 90, payloadKB: 20, timeoutMs: 3000,
      sloSuccessPct: 99, sloP99Ms: 400, budgetUsd: 0, ...(g.workload || {}),
    },
    nodes: (g.nodes || []).filter((n) => BY_ID[n.type]).map((n) => ({
      id: n.id || uid(), type: n.type, x: n.x ?? 100, y: n.y ?? 100,
      label: n.label || BY_ID[n.type].name, cfg: { ...(n.cfg || {}) },
    })),
    edges: [],
  };
  const ids = new Set(out.nodes.map((n) => n.id));
  out.edges = (g.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ id: e.id || uid('e'), from: e.from, to: e.to, kind: e.kind || 'default', weight: e.weight ?? 1, ratio: e.ratio ?? 1, latMs: e.latMs ?? 0.4 }));
  return out;
}

function onGraphChange(full) {
  state.engine.rebuild();
  state.statics = reviewStatic(state.graph);
  refreshDoctor(true);
  renderInspector();
  persist();
}

const persist = debounce(() => {
  try { localStorage.setItem('sds:graph', JSON.stringify(state.graph)); } catch { /* quota */ }
}, 700);

// ============================================================ main loop

function loop(now) {
  const dtReal = Math.min(0.12, (now - state.lastFrame) / 1000);
  state.lastFrame = now;

  if (state.running) {
    state.acc += dtReal * state.speed;
    let steps = 0;
    while (state.acc >= SIM_STEP && steps < 40) {
      state.engine.step(SIM_STEP);
      state.acc -= SIM_STEP; steps++;
      runMissionTick(SIM_STEP);
    }
    if (steps) state.editor.spawnPackets(state.engine.samples);
  }

  state.editor.stepPackets(dtReal);
  state.editor.render();
  renderHud();

  if (now - state.lastDoctor > 420) { state.lastDoctor = now; refreshDoctor(); }
  if (state.tab === 'metrics') renderMetricsPanel();
  if (state.tab === 'cost') renderCostPanel();
  if (state.tab === 'log') renderLogPanel();

  requestAnimationFrame(loop);
}

function refreshDoctor(force) {
  // The static review quotes live workload numbers, so it is recomputed too.
  state.statics = reviewStatic(state.graph);
  state.runtimes = state.running || force ? diagnose(state.engine) : state.runtimes;
  state.score = scoreDesign(state.engine, state.statics, state.runtimes);
  renderDoctorPanel();
  renderMissionCard();
}

// ============================================================ palette

function buildPalette() {
  const list = $('#compList');
  $('#compCount').textContent = COMPONENTS.length + ' types';
  const render = (filter = '') => {
    list.innerHTML = '';
    const f = filter.trim().toLowerCase();
    for (const [catKey, comps] of componentsByCategory()) {
      const cat = CATEGORIES[catKey];
      const matches = comps.filter((c) =>
        !f || c.name.toLowerCase().includes(f) || c.id.includes(f) || (c.caps || []).some((x) => x.includes(f)) || c.blurb.toLowerCase().includes(f));
      if (!matches.length) continue;
      list.appendChild(el('div', { class: 'cat-title', text: cat.label }));
      for (const c of matches) {
        const item = el('div', {
          class: 'comp', draggable: 'true', title: c.blurb,
          ondragstart: (e) => { e.dataTransfer.setData('text/component', c.id); e.dataTransfer.effectAllowed = 'copy'; },
          ondblclick: () => {
            const v = state.editor.toWorld(state.editor.w / 2, state.editor.h / 2);
            state.editor.addNode(c.id, v.x, v.y);
          },
        }, [
          el('div', { class: 'g', style: { background: cat.color + '22', color: cat.color }, text: c.glyph }),
          el('div', {}, [el('div', { class: 'n', text: c.name }), el('div', { class: 'd', text: c.blurb.slice(0, 62) + (c.blurb.length > 62 ? '…' : '') })]),
        ]);
        list.appendChild(item);
      }
    }
    if (!list.children.length) list.appendChild(el('div', { class: 'empty', text: 'No components match "' + filter + '"' }));
  };
  render();
  $('#compSearch').addEventListener('input', (e) => render(e.target.value));
}

// ============================================================ toolbar

const rpsToSlider = (r) => clamp(Math.round(140 * Math.log10(Math.max(10, r) / 10)), 1, 700);
const sliderToRps = (v) => Math.round(10 * Math.pow(10, v / 140));

function bindToolbar() {
  $('#btnPlay').addEventListener('click', togglePlay);
  $('#btnStep').addEventListener('click', () => {
    for (let i = 0; i < 10; i++) { state.engine.step(SIM_STEP); runMissionTick(SIM_STEP); }
    state.editor.spawnPackets(state.engine.samples);
    refreshDoctor(true);
  });
  $('#btnReset').addEventListener('click', () => {
    state.engine.clearChaos(); state.engine.reset();
    if (state.missionState) state.missionState = freshMissionState(state.mission);
    state.editor.packets.length = 0;
    refreshDoctor(true);
    toast('Simulation reset');
  });
  $('#selSpeed').addEventListener('change', (e) => { state.speed = parseFloat(e.target.value); });

  $('#rngRps').addEventListener('input', (e) => setRps(sliderToRps(+e.target.value)));
  $('#numRps').addEventListener('change', (e) => setRps(clamp(+e.target.value || 10, 1, 5000000)));
  $('#selPattern').addEventListener('change', (e) => { state.graph.workload.pattern = e.target.value; persist(); });
  $('#rngRead').addEventListener('input', (e) => {
    state.graph.workload.readPct = +e.target.value;
    $('#lblRead').textContent = e.target.value + '%';
    persist();
  });

  $('#btnBlueprints').addEventListener('click', showBlueprints);
  $('#btnMissions').addEventListener('click', showMissions);
  $('#btnPackets').addEventListener('click', (e) => {
    state.editor.showPackets = !state.editor.showPackets;
    e.currentTarget.classList.toggle('on', state.editor.showPackets);
  });
  $('#btnFit').addEventListener('click', () => state.editor.fit());
  $('#btnSave').addEventListener('click', () => {
    localStorage.setItem('sds:graph', JSON.stringify(state.graph));
    toast('Saved to browser storage');
  });
  $('#btnExport').addEventListener('click', () => downloadJson((state.graph.name || 'design').replace(/\W+/g, '-').toLowerCase() + '.json', state.graph));
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { loadGraph(JSON.parse(await f.text())); toast('Imported ' + f.name); }
    catch (err) { toast('Could not read that file: ' + err.message, 4000); }
    e.target.value = '';
  });
  $('#btnClear').addEventListener('click', () => {
    if (!confirm('Clear the canvas?')) return;
    state.mission = null; state.missionState = null; $('#missionCard').classList.remove('show');
    loadGraph({ name: 'Untitled design', nodes: [{ id: uid(), type: 'client', x: 120, y: 220, label: 'Users', cfg: {} }], edges: [] });
  });
  $('#btnHelp').addEventListener('click', showHelp);
  $('#modalClose').addEventListener('click', () => $('#overlay').classList.remove('show'));
  $('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') $('#overlay').classList.remove('show'); });
}

function setRps(r) {
  state.graph.workload.rps = r;
  $('#numRps').value = r;
  $('#rngRps').value = rpsToSlider(r);
  persist();
}

function syncToolbarFromWorkload() {
  const w = state.graph.workload;
  $('#numRps').value = w.rps;
  $('#rngRps').value = rpsToSlider(w.rps);
  $('#selPattern').value = w.pattern;
  $('#rngRead').value = w.readPct;
  $('#lblRead').textContent = w.readPct + '%';
}

function togglePlay() {
  state.running = !state.running;
  $('#btnPlay').textContent = state.running ? '❚❚ Pause' : '▶ Run';
  $('#btnPlay').classList.toggle('primary', !state.running);
  state.lastFrame = performance.now();
}

function bindTabs() {
  $$('#tabs .tab').forEach((t) => t.addEventListener('click', () => {
    $$('#tabs .tab').forEach((x) => x.classList.remove('active'));
    $$('.tabpanel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    state.tab = t.dataset.t;
    $('#p-' + state.tab).classList.add('active');
    if (state.tab === 'chaos') renderChaosPanel();
    if (state.tab === 'inspect') renderInspector();
  }));
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); state.editor.deleteSelection(); }
    if (e.key === 'f') state.editor.fit();
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); state.editor.duplicateSelection(); }
    if (e.key === 'Escape') { $('#overlay').classList.remove('show'); hideContextMenu(); }
    if (e.key === '?') showHelp();
  });
  document.addEventListener('click', hideContextMenu);
}

// ============================================================ HUD

function renderHud() {
  const m = state.engine.metrics;
  const hud = $('#hud');
  const cells = [
    ['clock', fmtClock(state.engine.t), ''],
    ['offered', fmtNum(m.offeredRps) + '/s', 'acc'],
    ['served', fmtNum(m.okRps) + '/s', m.successRate > 0.99 ? 'ok' : m.successRate > 0.95 ? 'warn' : 'bad'],
    ['success', (m.successRate * 100).toFixed(2) + '%', m.successRate >= (state.graph.workload.sloSuccessPct ?? 99) / 100 ? 'ok' : 'bad'],
    ['p50', fmtMs(m.p50), ''],
    ['p95', fmtMs(m.p95), ''],
    ['p99', fmtMs(m.p99), m.p99 <= (state.graph.workload.sloP99Ms ?? 400) ? 'ok' : 'bad'],
    ['errors', fmtNum(m.errorRps + m.timeoutRps + m.droppedRps) + '/s', (m.errorRps + m.timeoutRps + m.droppedRps) > 0.5 ? 'bad' : 'ok'],
    ['429s', fmtNum(m.throttledRps) + '/s', m.throttledRps > 0.5 ? 'warn' : ''],
    ['cost/mo', fmtMoney(m.cost), 'acc'],
  ];
  if (hud.children.length !== cells.length) {
    hud.innerHTML = '';
    for (const [k] of cells) hud.appendChild(el('div', { class: 'stat' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: '–' })]));
  }
  cells.forEach(([k, v, cls], i) => {
    const node = hud.children[i];
    node.className = 'stat ' + cls;
    node.children[1].textContent = v;
  });

  const gb = $('#gradeBadge');
  const s = state.score;
  const col = s.score >= 85 ? 'var(--ok)' : s.score >= 65 ? 'var(--warn)' : 'var(--bad)';
  gb.children[0].textContent = s.grade;
  gb.children[0].style.color = col;
  gb.children[1].textContent = `score ${s.score} · ${s.crit} critical`;
}

const fmtClock = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ============================================================ inspector

function renderInspector() {
  const p = $('#p-inspect');
  const sel = state.selection;
  p.innerHTML = '';

  if (sel.kind === 'edge') return renderEdgeInspector(p, sel.edge);
  if (sel.kind === 'multi') {
    p.appendChild(el('div', { class: 'section' }, [
      el('h4', { text: sel.ids.length + ' components selected' }),
      el('div', { class: 'blurb', text: 'Ctrl+D duplicates the selection, Delete removes it.' }),
    ]));
    return;
  }
  if (sel.kind !== 'node') return renderWorkloadInspector(p);

  const node = sel.node;
  const def = BY_ID[node.type];
  const cat = CATEGORIES[def.cat];
  const st = state.engine.nodes.get(node.id);
  const cfg = { ...defaultCfg(node.type), ...node.cfg };

  // header
  p.appendChild(el('div', { class: 'section' }, [
    el('div', { class: 'rowflex', style: { marginBottom: '8px' } }, [
      el('div', { class: 'g', style: { background: cat.color + '22', color: cat.color, padding: '4px 8px', borderRadius: '5px', font: '600 10px var(--mono)' }, text: def.glyph }),
      el('input', { type: 'text', value: node.label || def.name, onchange: (e) => { node.label = e.target.value; persist(); } }),
    ]),
    el('div', { class: 'blurb', text: def.blurb }),
    el('div', { style: { marginTop: '8px' } }, (def.caps || []).map((c) => el('span', { class: 'chip', text: c }))),
    chapterRef(def.chapter, { text: '📖 Read the chapter' }),
  ]));

  // live telemetry
  if (st) {
    p.appendChild(el('div', { class: 'section' }, [
      el('h4', { text: 'Live' }),
      el('div', { class: 'kv' }, flatKv([
        ['Arrivals', fmtNum(st.inRate) + ' rps'],
        ['Capacity', fmtNum(st.capacity) + ' rps'],
        ['Utilisation', (st.rho * 100).toFixed(1) + '%'],
        ['Queue depth', fmtNum(st.queue)],
        ['Queue wait', fmtMs(st.waitMs)],
        ['Service time', fmtMs(st.serviceMsEff)],
        ['Downstream wait', fmtMs(st.downstreamMs)],
        ['Response time', fmtMs(st.respMs)],
        ['Concurrency', fmtNum(st.concurrency)],
        st.model.connLimit ? ['Connections', `${fmtNum(st.concurrency)} / ${fmtNum(st.model.connLimit)}`] : null,
        st.def.dispatch === 'cache' ? ['Effective hit ratio', (st.hitRatioEff * 100).toFixed(1) + '%'] : null,
        st.retryAmp > 1.01 ? ['Retry amplification', st.retryAmp.toFixed(2) + 'x'] : null,
        ['Replicas', fmtNum(st.replicasNow)],
        ['Dropped', fmtNum(st.dropRate) + ' rps'],
        ['Throttled', fmtNum(st.throttleRate) + ' rps'],
        ['Cost', fmtMoney(st.cost) + '/mo'],
      ])),
    ]));
  }

  // parameters
  const paramSection = el('div', { class: 'section' }, [el('h4', { text: 'Configuration' })]);
  for (const spec of def.params) paramSection.appendChild(paramField(node, spec, cfg));
  p.appendChild(paramSection);

  // targeted chaos
  const applicable = chaosFor(node.type).filter((c) => !c.global);
  p.appendChild(el('div', { class: 'section' }, [
    el('h4', { text: 'Break this component' }),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } },
      applicable.slice(0, 10).map((c) => el('button', {
        class: 'mini', text: c.name, title: c.desc,
        onclick: () => injectChaos(c, node.id),
      }))),
  ]));
}

function paramField(node, spec, cfg) {
  const wrap = el('div', { class: 'field' });
  const val = cfg[spec.k];
  const commit = (v) => {
    node.cfg[spec.k] = v;
    state.engine.rebuild();
    state.statics = reviewStatic(state.graph);
    persist();
  };

  if (spec.type === 'bool') {
    wrap.appendChild(el('label', { class: 'switch' }, [
      el('input', { type: 'checkbox', checked: !!val, onchange: (e) => commit(e.target.checked) }),
      el('span', { text: spec.label }),
    ]));
  } else if (spec.type === 'select') {
    wrap.appendChild(el('label', {}, [el('span', { text: spec.label })]));
    wrap.appendChild(el('select', { onchange: (e) => commit(e.target.value) },
      spec.options.map((o) => el('option', { value: o, selected: o === val, text: String(o).replace(/_/g, ' ') }))));
  } else {
    wrap.appendChild(el('label', {}, [el('span', { text: spec.label }), el('span', { class: 'u', text: spec.unit || '' })]));
    const num = el('input', { type: 'number', value: val, min: spec.min, max: spec.max, step: spec.step });
    const rng = el('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: val });
    rng.addEventListener('input', () => { num.value = rng.value; commit(+rng.value); });
    num.addEventListener('change', () => { const v = clamp(+num.value, spec.min, spec.max); num.value = v; rng.value = v; commit(v); });
    wrap.appendChild(el('div', { class: 'rowflex' }, [rng, num]));
  }
  if (spec.help) wrap.appendChild(el('div', { class: 'help', text: spec.help }));
  return wrap;
}

function renderEdgeInspector(p, edge) {
  const from = state.graph.nodes.find((n) => n.id === edge.from);
  const to = state.graph.nodes.find((n) => n.id === edge.to);
  const st = state.engine.edges.get(edge.id);
  p.appendChild(el('div', { class: 'section' }, [
    el('h4', { text: 'Connection' }),
    el('div', { class: 'blurb', text: `${from?.label || '?'} → ${to?.label || '?'}` }),
  ]));
  const kinds = {
    default: 'All requests use this edge.',
    read: 'Only read requests take this path. Use it to send reads to a replica or cache.',
    write: 'Only write requests take this path. Use it to route writes to the primary.',
    replication: 'Data replication, not request traffic. Excluded from the request flow.',
    fallback: 'Only used when the upstream circuit breaker is OPEN.',
  };
  const sec = el('div', { class: 'section' }, [el('h4', { text: 'Edge kind' })]);
  const selEl = el('select', { onchange: (e) => { edge.kind = e.target.value; help.textContent = kinds[edge.kind]; onGraphChange(); } },
    Object.keys(kinds).map((k) => el('option', { value: k, selected: (edge.kind || 'default') === k, text: k })));
  const help = el('div', { class: 'help', text: kinds[edge.kind || 'default'] });
  sec.appendChild(selEl); sec.appendChild(help);
  sec.appendChild(paramField({ cfg: edge }, { k: 'weight', label: 'Routing weight', type: 'num', def: 1, min: 0, max: 20, step: 0.1, help: 'Relative share when the source splits traffic across several edges.' }, edge));
  sec.appendChild(paramField({ cfg: edge }, { k: 'ratio', label: 'Calls per request', type: 'num', def: 1, min: 0, max: 100, step: 0.01, unit: 'x', help: 'Fan-in / fan-out ratio. 0.01 means a stream processor aggregates 100 events into one write; 3 means each request triggers three calls.' }, edge));
  sec.appendChild(paramField({ cfg: edge }, { k: 'latMs', label: 'Network latency', type: 'num', def: 0.4, min: 0, max: 500, step: 0.1, unit: 'ms', help: 'Same-AZ ≈ 0.3ms, cross-AZ ≈ 1ms, cross-region ≈ 30-150ms.' }, edge));
  p.appendChild(sec);
  if (st) p.appendChild(el('div', { class: 'section' }, [el('h4', { text: 'Live' }), el('div', { class: 'kv' }, flatKv([['Flow', fmtNum(st.rate) + ' rps']]))]));
  p.appendChild(el('div', { class: 'section' }, [el('button', { class: 'btn danger', text: 'Delete connection', onclick: () => state.editor.deleteSelection() })]));
}

function renderWorkloadInspector(p) {
  const w = state.graph.workload;
  const set = (k) => (v) => { w[k] = v; persist(); };
  p.appendChild(el('div', { class: 'section' }, [
    el('h4', { text: 'Design' }),
    el('input', { type: 'text', value: state.graph.name, onchange: (e) => { state.graph.name = e.target.value; persist(); } }),
    el('div', { class: 'help', text: 'Nothing selected. Click a component to configure it, or edit the workload and objectives below.' }),
  ]));

  const wl = el('div', { class: 'section' }, [el('h4', { text: 'Workload' })]);
  [
    { k: 'payloadKB', label: 'Average response size', type: 'num', min: 0.1, max: 10000, step: 0.1, unit: 'KB', help: 'Drives egress bandwidth and cost.' },
    { k: 'timeoutMs', label: 'Client timeout', type: 'num', min: 10, max: 120000, step: 10, unit: 'ms', help: 'Requests slower than this are counted as timeouts, not successes.' },
    { k: 'spikeMult', label: 'Spike multiplier', type: 'num', min: 1, max: 100, step: 1, unit: 'x', help: 'Used by the spike and flash-sale traffic shapes.' },
  ].forEach((s) => wl.appendChild(paramField({ cfg: w }, { ...s, def: w[s.k] ?? 1 }, w)));
  p.appendChild(wl);

  const slo = el('div', { class: 'section' }, [el('h4', { text: 'Objectives (SLO & budget)' })]);
  [
    { k: 'sloSuccessPct', label: 'Success rate objective', type: 'num', min: 90, max: 100, step: 0.01, unit: '%', help: '99.9% allows about 43 minutes of full outage a month.' },
    { k: 'sloP99Ms', label: 'p99 latency objective', type: 'num', min: 5, max: 60000, step: 5, unit: 'ms', help: 'The Doctor grades against this.' },
    { k: 'budgetUsd', label: 'Monthly budget', type: 'num', min: 0, max: 1000000, step: 100, unit: '$', help: 'Set to 0 to ignore cost in the score.' },
  ].forEach((s) => slo.appendChild(paramField({ cfg: w }, { ...s, def: w[s.k] ?? 0 }, w)));
  p.appendChild(slo);

  const sc = state.score;
  p.appendChild(el('div', { class: 'section' }, [
    el('h4', { text: 'Score breakdown' }),
    el('div', { class: 'kv' }, flatKv(Object.entries(sc.parts || {}).map(([k, v]) => [k, Math.round(v) + ' / 100']))),
  ]));
}

const flatKv = (pairs) => pairs.filter(Boolean).flatMap(([k, v]) => [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v })]);

/** A chapter reference: a real link when the book is reachable, a plain label otherwise. */
function chapterRef(chapter, opts = {}) {
  if (!chapter) return null;
  const text = opts.text || '📖 ' + chapterLabel(chapter);
  const cls = opts.class || 'mini';
  const url = chapterUrl(chapter);
  if (!url) {
    return el('span', { class: cls, style: { opacity: '.55', cursor: 'default' }, title: 'No book linked in this deployment — see js/config.js', text });
  }
  return el('a', { class: cls, href: url, target: '_blank', rel: 'noopener', text });
}

// ============================================================ doctor panel

function renderDoctorPanel() {
  const p = $('#p-doctor');
  const all = [...state.runtimes, ...state.statics];
  const order = { critical: 0, warn: 1, info: 2, good: 3 };
  all.sort((a, b) => order[a.severity] - order[b.severity]);

  const crit = all.filter((f) => f.severity === 'critical').length;
  const warn = all.filter((f) => f.severity === 'warn').length;
  const badge = $('#badgeDoctor');
  if (crit || warn) {
    badge.style.display = '';
    badge.textContent = crit || warn;
    badge.className = 'badge' + (crit ? '' : ' w');
  } else badge.style.display = 'none';

  const sig = all.map((f) => f.id + f.severity + (f.title || '')).join('|');
  if (p.dataset.sig === sig) return;
  p.dataset.sig = sig;
  p.innerHTML = '';

  p.appendChild(el('div', { class: 'section' }, [
    el('div', { class: 'kv' }, flatKv([
      ['Design score', `${state.score.score} / 100  (${state.score.grade})`],
      ['Critical issues', String(crit)],
      ['Warnings', String(warn)],
    ])),
    el('div', { class: 'help', text: 'Findings update live. Static design issues persist; runtime findings appear while the simulation runs.' }),
  ]));

  if (!all.length) {
    p.appendChild(el('div', { class: 'empty', text: 'No findings yet. Press Run to start the simulation.' }));
    return;
  }

  for (const f of all) {
    const open = state.openFindings.has(f.id) || f.severity === 'critical';
    const body = el('div', { class: 'fb' }, [
      f.what ? el('p', { html: mdish(f.what) }) : null,
      f.why ? el('span', { class: 'lab', text: 'Why this happens' }) : null,
      f.why ? el('p', { html: mdish(f.why) }) : null,
      f.fix?.length ? el('span', { class: 'lab', text: 'How to fix it' }) : null,
      f.fix?.length ? el('ul', {}, f.fix.map((x) => el('li', { html: mdish(x) }))) : null,
      el('div', { class: 'acts' }, [
        f.nodeIds?.length ? el('button', { class: 'mini', text: '⌖ Show me', onclick: (e) => { e.stopPropagation(); state.editor.highlight(f.nodeIds); focusNodes(f.nodeIds); } }) : null,
        chapterRef(f.chapter),
      ]),
    ]);
    const card = el('div', { class: 'finding ' + f.severity + (open ? ' open' : '') }, [
      el('div', {
        class: 'fh',
        onclick: (ev) => {
          const c = ev.currentTarget.parentElement;
          c.classList.toggle('open');
          c.classList.contains('open') ? state.openFindings.add(f.id) : state.openFindings.delete(f.id);
        },
      }, [
        el('span', { class: 'sev', text: f.severity === 'good' ? 'ok' : f.severity }),
        el('span', { class: 'ft', text: f.title }),
      ]),
      body,
    ]);
    p.appendChild(card);
  }
}

function focusNodes(ids) {
  const nodes = state.graph.nodes.filter((n) => ids.includes(n.id));
  if (!nodes.length) return;
  const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length + 79;
  const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length + 31;
  const k = state.editor.view.k;
  state.editor.view.x = state.editor.w / 2 - cx * k;
  state.editor.view.y = state.editor.h / 2 - cy * k;
  state.editor.selection = new Set(ids);
  state.selection = state.editor.selectionInfo();
  renderInspector();
}

/** Very small markdown subset: **bold** and `code`. */
function mdish(s) {
  return escapeHtml(String(s))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// ============================================================ metrics panel

const nodeHist = new Map();

function renderMetricsPanel() {
  const p = $('#p-metrics');
  if (!p.dataset.built) {
    p.dataset.built = '1';
    p.innerHTML = `
      <div class="chartbox"><h5>Latency percentiles (ms)</h5><canvas id="chLat"></canvas></div>
      <div class="chartbox"><h5>Throughput (rps)</h5><canvas id="chRps"></canvas></div>
      <div class="chartbox"><h5>Cost ($/month)</h5><canvas id="chCost"></canvas></div>
      <div class="panel-head"><span>Per-component</span><span class="mono">sorted by utilisation</span></div>
      <table class="nodes"><thead><tr>
        <th>Component</th><th>In rps</th><th>Util</th><th>Wait</th><th>Queue</th><th>Resp</th>
      </tr></thead><tbody id="nodeRows"></tbody></table>`;
  }
  const h = state.engine.history;
  drawChart($('#chLat'), [
    { ring: h.p50, color: '#4ade80', label: 'p50' },
    { ring: h.p95, color: '#fbbf24', label: 'p95' },
    { ring: h.p99, color: '#f87171', label: 'p99' },
  ], { log: true, fmt: (v) => fmtMs(v) });
  drawChart($('#chRps'), [
    { ring: h.rps, color: '#38bdf8', label: 'offered', fill: true },
    { ring: h.ok, color: '#4ade80', label: 'served' },
    { ring: h.err, color: '#ef4444', label: 'failed' },
  ], {});
  drawChart($('#chCost'), [{ ring: h.cost, color: '#a78bfa', label: '$/mo', fill: true }], { fmt: (v) => fmtMoney(v) });

  const rows = $('#nodeRows');
  const list = [...state.engine.nodes.values()].filter((n) => n.def.dispatch !== 'source').sort((a, b) => b.rho - a.rho);
  rows.innerHTML = '';
  for (const nd of list) {
    const label = state.graph.nodes.find((n) => n.id === nd.id)?.label || nd.def.name;
    const col = nd.down ? '#ef4444' : nd.rho > 1 ? '#ef4444' : nd.rho > 0.85 ? '#f97316' : nd.rho > 0.7 ? '#facc15' : '#4ade80';
    const tr = el('tr', { onclick: () => focusNodes([nd.id]) }, [
      el('td', { text: label }),
      el('td', { text: fmtNum(nd.inRate) }),
      el('td', {}, [el('div', { class: 'bar', style: { display: 'inline-block', width: '46px', verticalAlign: 'middle' } }, [el('i', { style: { width: Math.min(100, nd.rho * 100) + '%', background: col } })]),
      el('span', { style: { marginLeft: '6px', color: col }, text: (nd.rho * 100).toFixed(0) + '%' })]),
      el('td', { text: fmtMs(nd.waitMs) }),
      el('td', { text: fmtNum(nd.queue) }),
      el('td', { text: fmtMs(nd.respMs) }),
    ]);
    rows.appendChild(tr);
  }
}

// ============================================================ cost panel

function renderCostPanel() {
  const p = $('#p-cost');
  const m = state.engine.metrics;
  if (!p.dataset.built) {
    p.dataset.built = '1';
    p.innerHTML = `<div class="section" id="costTop"></div>
      <div class="chartbox"><h5>Monthly cost by component</h5><canvas id="chBars" style="height:280px"></canvas></div>
      <div class="section"><h4>How this is calculated</h4><div class="blurb">
      Prices are AWS us-east-1 on-demand list prices: EC2/EKS per instance-hour, RDS per instance with a Multi-AZ multiplier,
      ElastiCache per GB, S3 per GB-month plus requests, DynamoDB per RCU/WCU or per million requests, and $0.085/GB egress.
      Request-driven costs use the live simulated rate extrapolated to a 30-day month, so the number moves as you change the load.
      Treat it as an order-of-magnitude estimate for comparing designs, not a quote.
      </div></div>`;
  }
  const budget = state.graph.workload.budgetUsd || 0;
  $('#costTop').innerHTML = '';
  $('#costTop').appendChild(el('div', { class: 'kv' }, flatKv([
    ['Total', fmtMoney(m.cost) + ' / month'],
    ['Per year', fmtMoney(m.cost * 12)],
    ['Per million requests', m.okRps > 0 ? '$' + (m.cost / (m.okRps * 2.6e6 / 1e6)).toFixed(3) : '–'],
    budget ? ['Budget', fmtMoney(budget) + (m.cost > budget ? `  (over by ${fmtMoney(m.cost - budget)})` : '  ✓')] : null,
  ])));
  drawBars($('#chBars'), m.costBreakdown.map((c) => ({ label: c.name, value: c.cost })), { fmt: fmtMoney });
}

// ============================================================ chaos panel

function renderChaosPanel() {
  const p = $('#p-chaos');
  p.innerHTML = '';

  const active = el('div', { class: 'section' }, [el('h4', { text: 'Active incidents' })]);
  if (!state.engine.chaos.length) active.appendChild(el('div', { class: 'help', text: 'None. Click any scenario below to inject it. Select a component first to target it precisely.' }));
  for (const c of state.engine.chaos) {
    active.appendChild(el('div', { class: 'active-chaos' }, [
      el('span', { text: c.name + (c.targetLabel ? ' → ' + c.targetLabel : ' (global)') }),
      el('span', { class: 'mono', text: c.durationSec ? Math.max(0, c.durationSec - c.elapsed).toFixed(0) + 's' : '∞' }),
    ]));
  }
  if (state.engine.chaos.length) {
    active.appendChild(el('button', { class: 'btn danger', style: { marginTop: '8px' }, text: 'Stop all incidents', onclick: () => { state.engine.clearChaos(); renderChaosPanel(); } }));
  }
  p.appendChild(active);

  const selNode = state.selection.kind === 'node' ? state.selection.node : null;
  p.appendChild(el('div', { class: 'section' }, [
    el('div', { class: 'help', html: selNode ? `Targeted scenarios will hit <strong>${escapeHtml(selNode.label)}</strong>. Select another component to change the target.` : 'No component selected — targeted scenarios will pick a sensible victim automatically.' }),
  ]));

  for (const cat of CHAOS_CATEGORIES) {
    p.appendChild(el('div', { class: 'cat-title', text: cat }));
    for (const c of CHAOS.filter((x) => x.cat === cat)) {
      const item = el('div', {
        class: 'chaos-item',
        onclick: (e) => {
          if (e.target.classList.contains('mini')) return;
          e.currentTarget.classList.toggle('open');
        },
      }, [
        el('div', { class: 'top' }, [
          el('span', { class: 'nm', text: c.name }),
          el('span', { class: 'sev-tag sev-' + c.sev, text: c.sev }),
        ]),
        el('div', { class: 'ds', text: c.desc }),
        el('div', { class: 'ls', html: '<strong>What it teaches:</strong> ' + mdish(c.lesson) }),
        el('div', { class: 'acts', style: { marginTop: '7px' } }, [
          el('button', { class: 'mini', text: '⚡ Inject', onclick: (e) => { e.stopPropagation(); injectChaos(c, selNode?.id); } }),
          chapterRef(c.chapter, { text: '📖 chapter' }),
        ]),
      ]);
      p.appendChild(item);
    }
  }
}

function injectChaos(scenario, targetId) {
  let id = scenario.global ? null : targetId;
  if (!scenario.global && !id) id = pickChaosTarget(scenario);
  const label = id ? (state.graph.nodes.find((n) => n.id === id)?.label) : null;
  if (!scenario.global && !id) { toast('No suitable target on the canvas for "' + scenario.name + '"', 3200); return; }
  if (scenario.effect.readPctOverride !== undefined) state.graph.workload.readPct = scenario.effect.readPctOverride;
  state.engine.injectChaos({
    id: scenario.id, name: scenario.name, targetId: id, targetLabel: label,
    durationSec: scenario.durationSec, ...scenario.effect,
  });
  if (!state.running) togglePlay();
  renderChaosPanel();
  toast(`⚡ ${scenario.name}${label ? ' → ' + label : ''} — ${scenario.lesson.split('.')[0]}.`, 5200);
}

function pickChaosTarget(scenario) {
  const candidates = [...state.engine.nodes.values()].filter((nd) => {
    if (scenario.targets) return scenario.targets.includes(nd.type);
    return nd.def.dispatch !== 'source';
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rho - a.rho || b.inRate - a.inRate);
  return candidates[0].id;
}

// ============================================================ log panel

function renderLogPanel() {
  const p = $('#p-log');
  const log = state.engine.eventLog;
  if (p.dataset.n === String(log.length)) return;
  p.dataset.n = String(log.length);
  p.innerHTML = '';
  if (!log.length) { p.appendChild(el('div', { class: 'empty', text: 'No events yet. Incidents, failures and recoveries appear here with their simulated timestamp.' })); return; }
  for (const e of log) {
    p.appendChild(el('div', { class: 'logline ' + e.kind }, [
      el('span', { class: 't', text: fmtClock(e.t) }),
      el('span', { class: 'm', text: e.text }),
    ]));
  }
}

// ============================================================ missions

function freshMissionState(mission) {
  return { fired: new Set(), held: 0, passed: false, results: mission.objectives.map(() => false) };
}

function startMission(mission) {
  state.mission = mission;
  const bp = mission.blueprint ? BLUEPRINTS.find((b) => b.id === mission.blueprint) : null;
  const g = bp ? blueprintToGraph(bp) : { name: mission.name, nodes: [{ id: uid(), type: 'client', x: 120, y: 240, label: 'Users', cfg: {} }], edges: [] };
  g.name = mission.name;
  g.workload = { ...g.workload, ...mission.workload };
  if (mission.patch) mission.patch(g);
  loadGraph(g);
  state.engine.clearChaos();
  state.engine.reset();
  state.missionState = freshMissionState(mission);
  $('#missionCard').classList.add('show');
  renderMissionCard();
  $('#overlay').classList.remove('show');
  if (!state.running) togglePlay();
  toast('Mission started: ' + mission.name, 3600);
}

function runMissionTick(dt) {
  const mi = state.mission, ms = state.missionState;
  if (!mi || !ms) return;
  for (const ev of mi.chaos || []) {
    const key = ev.chaosId + '@' + ev.atSec;
    if (ms.fired.has(key) || state.engine.t < ev.atSec) continue;
    ms.fired.add(key);
    const sc = CHAOS.find((c) => c.id === ev.chaosId);
    if (!sc) continue;
    let target = null;
    if (ev.targetType) target = [...state.engine.nodes.values()].find((n) => n.type === ev.targetType)?.id;
    else if (ev.targetCap) {
      const c = [...state.engine.nodes.values()].filter((n) => (n.def.caps || []).includes(ev.targetCap)).sort((a, b) => b.rho - a.rho)[0];
      target = c?.id;
    }
    injectChaos(sc, target);
  }

  const ctx = missionContext(state.engine, [...state.statics, ...state.runtimes]);
  // A design that serves no traffic cannot satisfy anything.
  const live = state.engine.metrics.samples > 60 && state.engine.metrics.okRps > 0;
  ms.results = mi.objectives.map((o) => { try { return live && !!o.check(ctx); } catch { return false; } });
  const all = ms.results.every(Boolean) && state.engine.t >= (mi.minRunSec || 0);
  ms.held = all ? ms.held + dt : 0;
  if (!ms.passed && ms.held >= (mi.holdSec || 15)) {
    ms.passed = true;
    state.running = false;
    $('#btnPlay').textContent = '▶ Run';
    showMissionComplete(mi);
  }
}

function renderMissionCard() {
  const mi = state.mission, ms = state.missionState;
  const card = $('#missionCard');
  if (!mi || !ms) { card.classList.remove('show'); return; }
  card.classList.add('show');
  $('#mLevel').textContent = mi.level;
  $('#mName').textContent = mi.name;
  const done = ms.results.filter(Boolean).length;
  const holdPct = ms.results.every(Boolean) ? Math.min(1, ms.held / (mi.holdSec || 15)) : 0;
  $('#mProgress').style.width = ((done / mi.objectives.length) * 100 * 0.8 + holdPct * 20).toFixed(0) + '%';

  const body = $('#mBody');
  const sig = ms.results.join(',') + '|' + ms.passed + '|' + Math.floor(ms.held);
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  body.innerHTML = '';
  body.appendChild(el('div', { class: 'blurb', style: { marginBottom: '8px' }, text: mi.brief }));
  mi.objectives.forEach((o, i) => {
    const ok = ms.results[i];
    body.appendChild(el('div', { class: 'obj' + (ok ? ' done' : '') }, [
      el('div', { class: 'tick', text: ok ? '✓' : '' }),
      el('div', {}, [
        el('div', { class: 'lbl', text: o.label }),
        !ok && o.hint ? el('div', { class: 'hint', text: o.hint }) : null,
      ]),
    ]));
  });
  if (ms.results.every(Boolean) && !ms.passed) {
    body.appendChild(el('div', { class: 'help', style: { color: 'var(--ok)', marginTop: '6px' }, text: `All objectives met — hold for ${((mi.holdSec || 15) - ms.held).toFixed(0)}s more to pass.` }));
  }
  body.appendChild(el('div', { class: 'acts', style: { marginTop: '10px' } }, [
    el('button', { class: 'mini', text: 'Restart mission', onclick: () => startMission(mi) }),
    chapterRef(mi.chapter, { text: '📖 chapter' }),
    el('button', { class: 'mini', text: 'Abandon', onclick: () => { state.mission = null; state.missionState = null; $('#missionCard').classList.remove('show'); } }),
  ]));
}

function showMissionComplete(mi) {
  const m = state.engine.metrics;
  modal('Mission complete: ' + mi.name, el('div', {}, [
    el('div', { class: 'blurb', style: { marginBottom: '12px' }, html: `<strong style="color:var(--ok)">All objectives held.</strong> Final grade ${state.score.grade} (${state.score.score}/100).` }),
    el('div', { class: 'kv', style: { marginBottom: '14px' } }, flatKv([
      ['Served', fmtNum(m.okRps) + ' rps'],
      ['Success rate', (m.successRate * 100).toFixed(3) + '%'],
      ['p50 / p95 / p99', `${fmtMs(m.p50)} / ${fmtMs(m.p95)} / ${fmtMs(m.p99)}`],
      ['Cost', fmtMoney(m.cost) + ' / month'],
    ])),
    el('div', { class: 'section', style: { border: 0, padding: 0 } }, [
      el('h4', { text: 'What this mission taught' }),
      el('div', { class: 'blurb', text: mi.teaches || '' }),
    ]),
    el('div', { class: 'acts', style: { marginTop: '14px' } }, [
      chapterRef(mi.chapter, { class: 'btn', text: '📖 Read the chapter' }),
      el('button', { class: 'btn primary', text: 'Next mission', onclick: () => { const i = MISSIONS.indexOf(mi); startMission(MISSIONS[(i + 1) % MISSIONS.length]); } }),
      el('button', { class: 'btn', text: 'Keep experimenting', onclick: () => $('#overlay').classList.remove('show') }),
    ]),
  ]));
}

// ============================================================ modals

function modal(title, content) {
  $('#modalTitle').textContent = title;
  const b = $('#modalBody'); b.innerHTML = '';
  b.appendChild(content);
  $('#overlay').classList.add('show');
}

function showBlueprints() {
  const grid = el('div', { class: 'card-grid' });
  for (const bp of BLUEPRINTS) {
    grid.appendChild(el('div', {
      class: 'card',
      onclick: () => {
        state.mission = null; state.missionState = null; $('#missionCard').classList.remove('show');
        loadGraph(blueprintToGraph(bp));
        state.engine.clearChaos(); state.engine.reset();
        $('#overlay').classList.remove('show');
        toast('Loaded ' + bp.name + ' — check the Doctor tab before you run it.', 4200);
      },
    }, [
      el('div', { class: 'lv', text: bp.level }),
      el('div', { class: 'nm', text: bp.name }),
      el('div', { class: 'ds', text: bp.brief }),
      el('div', { class: 'tc', text: `${bp.nodes.length} components · ${fmtNum(bp.workload.rps)} rps · ${bp.workload.readPct}% reads` }),
    ]));
  }
  modal('Blueprints — ' + BLUEPRINTS.length + ' reference architectures', grid);
}

function showMissions() {
  const grid = el('div', { class: 'card-grid' });
  for (const mi of MISSIONS) {
    grid.appendChild(el('div', { class: 'card', onclick: () => startMission(mi) }, [
      el('div', { class: 'lv', text: mi.level }),
      el('div', { class: 'nm', text: mi.name }),
      el('div', { class: 'ds', text: mi.brief }),
      el('div', { class: 'tc', text: '▸ ' + (mi.teaches || '') }),
    ]));
  }
  modal('Guided missions — learn by fixing real failures', grid);
}

function showHelp() {
  modal('How to use this simulator', el('div', {}, [
    el('div', { class: 'blurb', style: { marginBottom: '14px' } , html:
      'This is a <strong>queueing-network simulator</strong>, not a drawing tool. Every component is modelled as an M/G/c service station: '
      + 'capacity = workers ÷ occupancy time, queueing delay from Kingman\'s approximation, and a Monte-Carlo sampler walks ~240 virtual requests '
      + 'through the live graph every tick to produce honest p50/p95/p99 tails. A caller\'s occupancy includes the time it spends waiting on its '
      + 'dependencies, which is why thread-pool exhaustion and cascading failure emerge on their own rather than being scripted.' }),
    el('h4', { style: { margin: '12px 0 6px', color: 'var(--txt-3)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.7px' }, text: 'A good way to learn with it' }),
    el('ol', { style: { margin: '0 0 14px 18px', lineHeight: '1.75', color: 'var(--txt-2)', fontSize: '12.5px' } }, [
      el('li', { html: 'Open <strong>Missions</strong> and start at the top. Each one has measurable objectives and a hint when you are stuck.' }),
      el('li', { html: 'Raise the load until something turns red. That number is your real capacity — write it down.' }),
      el('li', { html: 'Read the <strong>Doctor</strong> tab. It names the bottleneck, shows the arithmetic and gives the fix.' }),
      el('li', { html: 'Inject a <strong>Chaos</strong> scenario. A design that survives steady state and dies on a cache flush is not finished.' }),
      el('li', { html: 'Check the <strong>Cost</strong> tab. Meeting the SLO at four times the budget is not meeting the requirements.' }),
    ]),
    el('table', { class: 'helptable' }, [
      ['<kbd>Space</kbd>', 'Run / pause'],
      ['<kbd>Delete</kbd>', 'Delete the selected component or connection'],
      ['<kbd>Ctrl</kbd>+<kbd>D</kbd>', 'Duplicate selection'],
      ['<kbd>F</kbd>', 'Fit the diagram to the screen'],
      ['<kbd>Shift</kbd>+drag', 'Marquee select'],
      ['drag from the right dot', 'Create a connection'],
      ['double-click a connection', 'Cycle its kind: default → read → write → replication → fallback'],
      ['right-click', 'Context actions'],
      ['scroll', 'Zoom · drag empty space to pan'],
    ].map(([k, v]) => el('tr', {}, [el('td', { html: k }), el('td', { text: v })]))),
    el('div', { class: 'blurb', style: { marginTop: '14px' }, html:
      'Edge kinds matter: mark an edge <code>read</code> to send only reads down it (to a replica or cache) and <code>write</code> for the primary. '
      + '<code>replication</code> edges are excluded from request flow. <code>fallback</code> edges are used only when an upstream circuit breaker is OPEN.' }),
    el('div', { class: 'blurb', style: { marginTop: '10px', color: 'var(--txt-3)' }, text:
      'Every finding links to the matching chapter of the System Design book. Where that book lives is set in js/config.js.' }),
  ]));
}

// ============================================================ context menu

function showContextMenu({ node, edge, clientX, clientY }) {
  const menu = $('#ctxmenu');
  menu.innerHTML = '';
  const add = (label, fn) => menu.appendChild(el('div', { class: 'mi', text: label, onclick: () => { fn(); hideContextMenu(); } }));
  if (node) {
    add('Duplicate', () => { state.editor.selection = new Set([node.id]); state.editor.duplicateSelection(); });
    add('Delete', () => { state.editor.selection = new Set([node.id]); state.editor.selectedEdge = null; state.editor.deleteSelection(); });
    menu.appendChild(el('div', { class: 'sep' }));
    const applicable = chaosFor(node.type).filter((c) => !c.global).slice(0, 6);
    for (const c of applicable) add('⚡ ' + c.name, () => injectChaos(c, node.id));
  } else if (edge) {
    for (const k of ['default', 'read', 'write', 'replication', 'fallback']) add('Set kind: ' + k, () => { edge.kind = k; onGraphChange(); });
    menu.appendChild(el('div', { class: 'sep' }));
    add('Delete connection', () => { state.editor.selectedEdge = edge; state.editor.deleteSelection(); });
  } else {
    add('Fit to screen', () => state.editor.fit());
    add('Reset simulation', () => { state.engine.clearChaos(); state.engine.reset(); });
  }
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  menu.classList.add('show');
}
function hideContextMenu() { $('#ctxmenu').classList.remove('show'); }

// ============================================================ misc

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function debounce(fn, ms) {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

window.__sds = state;

boot();
