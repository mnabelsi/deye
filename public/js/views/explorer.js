import { api } from '../api.js';
import { $, $$, esc, icon, toast, modal, confirmDialog, fmtValue, fmtTime, debounce, localDateTimeStr, startOfDay, slotColor, MAX_SERIES } from '../util.js';
import { createTimeChart, renderSeriesTable } from '../charts.js';

const RANGES = [
  ['6h', '6 h'],
  ['24h', '24 h'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', '7 d'],
  ['30d', '30 d'],
  ['90d', '90 d'],
  ['1y', '1 y'],
  ['custom', 'Custom'],
];

const BUCKETS = [
  ['auto', 'Auto'],
  ['raw', 'Raw'],
  ['300', '5 min'],
  ['900', '15 min'],
  ['3600', '1 hour'],
  ['21600', '6 hours'],
  ['86400', '1 day'],
];

export function rangeToTimes(range, customFrom, customTo) {
  const now = Math.floor(Date.now() / 1000);
  const day = 86400;
  switch (range) {
    case '6h': return [now - 6 * 3600, now];
    case 'today': return [Math.floor(startOfDay().getTime() / 1000), now];
    case 'yesterday': {
      const s = Math.floor(startOfDay().getTime() / 1000);
      return [s - day, s];
    }
    case '7d': return [now - 7 * day, now];
    case '30d': return [now - 30 * day, now];
    case '90d': return [now - 90 * day, now];
    case '1y': return [now - 365 * day, now];
    case 'custom': return [customFrom || now - day, customTo || now];
    default: return [now - day, now];
  }
}

function sourceName(sources, type, id) {
  if (type === 'station') {
    const st = sources.stations.find((s) => s.id === id);
    return st ? st.name : `Station ${id}`;
  }
  for (const st of sources.stations) {
    const d = st.devices.find((x) => x.sn === id);
    if (d) return `${d.type ? d.type.charAt(0) + d.type.slice(1).toLowerCase().replace(/_/g, ' ') : 'Device'} ${id}`;
  }
  return `Device ${id}`;
}

export async function mount(root, ctx) {
  const [sources, metricsRes, prefsRes] = await Promise.all([
    ctx.store.sources(),
    api.get('/api/metrics'),
    api.get('/api/prefs').catch(() => ({ prefs: {} })),
  ]);
  const metrics = metricsRes.metrics.filter((m) => m.kind === 'number');
  const byId = new Map(metrics.map((m) => [m.id, m]));
  let prefs = prefsRes.prefs || {};

  const p = ctx.params;
  const st = {
    selected: (p.get('m') || '').split(',').map(Number).filter((id) => byId.has(id)),
    slots: new Map(),
    hidden: new Set(),
    range: p.get('r') || 'today',
    from: Number(p.get('from')) || null,
    to: Number(p.get('to')) || null,
    bucket: p.get('b') || 'auto',
    agg: p.get('a') || 'avg',
    type: p.get('t') || 'line',
    mode: 'chart',
    source: p.get('s') || '',
    category: '',
    search: '',
    collapsed: new Set(),
    lastData: null,
    reqId: 0,
  };

  // Default selection: the station's main power readings.
  if (!st.selected.length && !p.get('m')) {
    const defaults = ['generationPower', 'consumptionPower', 'gridPower', 'batteryPower'];
    const station = sources.stations[0];
    if (station) {
      for (const key of defaults) {
        const m = metrics.find((x) => x.sourceType === 'station' && x.sourceId === station.id && x.key === key);
        if (m) st.selected.push(m.id);
      }
    }
  }
  st.selected = st.selected.slice(0, MAX_SERIES);
  // Each series keeps its colour slot while it stays selected, so removing one never repaints the rest.
  st.selected.forEach((id, i) => st.slots.set(id, i));

  const sourceOptions = [];
  for (const s of sources.stations) {
    sourceOptions.push({ value: `station:${s.id}`, label: `${s.name} (station)` });
    for (const d of s.devices) sourceOptions.push({ value: `device:${d.sn}`, label: `↳ ${sourceName(sources, 'device', d.sn)}` });
  }
  for (const d of sources.unassignedDevices || []) sourceOptions.push({ value: `device:${d.sn}`, label: sourceName(sources, 'device', d.sn) });
  const categories = [...new Set(metrics.map((m) => m.category))].sort();

  root.innerHTML = `
    <div class="stack">
      <div class="card" style="padding:12px 14px">
        <div class="row">
          <div class="seg" id="ranges">${RANGES.map(([k, l]) => `<button data-r="${k}">${l}</button>`).join('')}</div>
          <div class="row ${st.range === 'custom' ? '' : 'hidden'}" id="custom-range">
            <input type="datetime-local" id="from" class="inline-input">
            <span class="faint">→</span>
            <input type="datetime-local" id="to" class="inline-input">
          </div>
          <span class="spacer"></span>
          <label class="row small muted" style="gap:6px">Resolution
            <select id="bucket" class="inline-input">${BUCKETS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          </label>
          <label class="row small muted" style="gap:6px">Aggregate
            <select id="agg" class="inline-input"><option value="avg">Average</option><option value="min">Minimum</option><option value="max">Maximum</option></select>
          </label>
        </div>
      </div>

      <div class="explorer">
        <div class="card picker">
          <div class="picker-head">
            <select id="source"><option value="">All sources</option>${sourceOptions.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>
            <input type="search" id="search" placeholder="Search ${metrics.length} readings…">
            <div class="chips" id="cats"><button class="chip active" data-c="">All</button>${categories.map((c) => `<button class="chip" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
          </div>
          <div class="picker-list" id="picker-list"></div>
        </div>

        <div class="stack" style="min-width:0">
          <div class="card">
            <div class="card-head">
              <h2 id="chart-title">Readings</h2>
              <div class="seg" id="types">
                <button data-t="line">Line</button><button data-t="area">Area</button><button data-t="step">Step</button><button data-t="bar">Bar</button>
              </div>
              <div class="seg" id="modes"><button data-v="chart">Chart</button><button data-v="table">Table</button></div>
            </div>
            <div class="row" style="margin-bottom:10px">
              <div class="series-pills" id="pills"></div>
              <span class="spacer"></span>
              <div class="legend-actions">
                <button class="btn sm ghost" id="show-all" title="Show all series">Show all</button>
                <button class="btn sm ghost" id="clear" title="Remove all series">Clear</button>
              </div>
            </div>
            <div id="chart-wrap"><div class="chart" id="chart"></div></div>
            <div id="table-wrap" class="hidden"></div>
            <div class="row small faint" style="margin-top:8px" id="chart-meta"></div>
          </div>
          <div class="card">
            <div class="card-head">
              <h2>Saved views</h2>
              <button class="btn sm" id="save-view">${icon('save')} Save current view</button>
              <button class="btn sm" id="export">${icon('download')} Export CSV</button>
              <button class="btn sm" id="copy-link">${icon('link')} Copy link</button>
            </div>
            <div id="views"></div>
          </div>
        </div>
      </div>
    </div>`;

  const chartEl = $('#chart', root);
  const chart = createTimeChart(chartEl, {
    type: st.type,
    onZoom: debounce((startMs, endMs) => refineZoom(startMs, endMs), 350),
  });

  // ---------- controls ----------
  function syncControls() {
    $$('#ranges button', root).forEach((b) => b.classList.toggle('active', b.dataset.r === st.range));
    $$('#types button', root).forEach((b) => b.classList.toggle('active', b.dataset.t === st.type));
    $$('#modes button', root).forEach((b) => b.classList.toggle('active', b.dataset.v === st.mode));
    $$('#cats .chip', root).forEach((b) => b.classList.toggle('active', b.dataset.c === st.category));
    $('#bucket', root).value = st.bucket;
    $('#agg', root).value = st.agg;
    $('#source', root).value = st.source;
    $('#custom-range', root).classList.toggle('hidden', st.range !== 'custom');
    const [f, t] = rangeToTimes(st.range, st.from, st.to);
    $('#from', root).value = localDateTimeStr(new Date(f * 1000));
    $('#to', root).value = localDateTimeStr(new Date(t * 1000));
  }

  function writeUrl() {
    const q = new URLSearchParams();
    if (st.selected.length) q.set('m', st.selected.join(','));
    q.set('r', st.range);
    if (st.range === 'custom') {
      const [f, t] = rangeToTimes(st.range, st.from, st.to);
      q.set('from', f);
      q.set('to', t);
    }
    if (st.bucket !== 'auto') q.set('b', st.bucket);
    if (st.agg !== 'avg') q.set('a', st.agg);
    if (st.type !== 'line') q.set('t', st.type);
    if (st.source) q.set('s', st.source);
    history.replaceState(null, '', `#/charts?${q.toString()}`);
  }

  $('#ranges', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.r === 'custom' && st.range !== 'custom') {
      const [f, t] = rangeToTimes(st.range);
      st.from = f;
      st.to = t;
    }
    st.range = b.dataset.r;
    syncControls();
    load();
  };
  const onCustom = () => {
    const f = new Date($('#from', root).value).getTime() / 1000;
    const t = new Date($('#to', root).value).getTime() / 1000;
    if (!Number.isFinite(f) || !Number.isFinite(t)) return;
    st.from = Math.floor(f);
    st.to = Math.floor(t);
    load();
  };
  $('#from', root).onchange = onCustom;
  $('#to', root).onchange = onCustom;
  $('#bucket', root).onchange = (e) => {
    st.bucket = e.target.value;
    load();
  };
  $('#agg', root).onchange = (e) => {
    st.agg = e.target.value;
    load();
  };
  $('#types', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.type = b.dataset.t;
    syncControls();
    writeUrl();
    chart.setType(st.type);
    chart.setHidden([...st.hidden]);
  };
  $('#modes', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.mode = b.dataset.v;
    syncControls();
    $('#chart-wrap', root).classList.toggle('hidden', st.mode !== 'chart');
    $('#table-wrap', root).classList.toggle('hidden', st.mode !== 'table');
    if (st.mode === 'table' && st.lastData) renderSeriesTable($('#table-wrap', root), visiblePanels(st.lastData));
  };
  $('#source', root).onchange = (e) => {
    st.source = e.target.value;
    writeUrl();
    renderPicker();
  };
  $('#search', root).oninput = debounce((e) => {
    st.search = e.target.value.trim().toLowerCase();
    renderPicker();
  }, 120);
  $('#cats', root).onclick = (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    st.category = b.dataset.c;
    syncControls();
    renderPicker();
  };
  $('#show-all', root).onclick = () => {
    st.hidden.clear();
    chart.setHidden([]);
    renderPills();
  };
  $('#clear', root).onclick = () => {
    st.selected = [];
    st.slots.clear();
    st.hidden.clear();
    renderPicker();
    load();
  };

  // ---------- picker ----------
  function toggleMetric(id, on) {
    if (on) {
      if (st.selected.includes(id)) return;
      if (st.selected.length >= MAX_SERIES) {
        toast(`Up to ${MAX_SERIES} readings per chart keep colours distinguishable. Remove one, or save this view and start another.`, 'err');
        renderPicker();
        return;
      }
      const used = new Set(st.selected.map((x) => st.slots.get(x)));
      let slot = 0;
      while (used.has(slot)) slot++;
      st.slots.set(id, slot);
      st.selected.push(id);
    } else {
      st.selected = st.selected.filter((x) => x !== id);
      st.slots.delete(id);
      st.hidden.delete(seriesName(byId.get(id)));
    }
    renderPicker();
    load();
  }

  function renderPicker() {
    const [srcType, srcId] = st.source ? st.source.split(':') : [];
    const list = metrics.filter((m) => {
      if (srcType && (m.sourceType !== srcType || m.sourceId !== srcId)) return false;
      if (st.category && m.category !== st.category) return false;
      if (st.search && !`${m.label} ${m.key} ${m.unit} ${m.sourceId}`.toLowerCase().includes(st.search)) return false;
      return true;
    });
    const groups = new Map();
    for (const m of list) {
      const g = srcType ? m.category : `${sourceName(sources, m.sourceType, m.sourceId)} · ${m.category}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    }
    const el = $('#picker-list', root);
    if (!metrics.length) {
      el.innerHTML = `<div class="empty">${icon('database')}<h3>No readings yet</h3><p>Configure DeyeCloud in Settings and wait for the first collection.</p></div>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = '<div class="empty small">No readings match these filters</div>';
      return;
    }
    el.innerHTML = [...groups.entries()]
      .map(([g, items]) => {
        const collapsed = st.collapsed.has(g) && !st.search;
        return `<div class="picker-group">
          <div class="picker-group-title" data-g="${esc(g)}">${collapsed ? '▸' : '▾'} ${esc(g)}<span class="count">${items.length}</span></div>
          ${collapsed ? '' : items
            .map((m) => {
              const on = st.selected.includes(m.id);
              return `<label class="picker-item" title="${esc(m.key)}">
                <input type="checkbox" data-id="${m.id}" ${on ? 'checked' : ''}>
                ${on ? `<span class="swatch" style="background:${slotColor(st.slots.get(m.id))}"></span>` : ''}
                <span class="pi-label">${esc(m.label)}</span>
                <span class="pi-value">${esc(fmtValue(m.lastValue, m.unit))}</span>
              </label>`;
            })
            .join('')}
        </div>`;
      })
      .join('');
  }
  $('#picker-list', root).addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-id]');
    if (cb) toggleMetric(Number(cb.dataset.id), cb.checked);
  });
  $('#picker-list', root).addEventListener('click', (e) => {
    const t = e.target.closest('.picker-group-title');
    if (!t) return;
    const g = t.dataset.g;
    if (st.collapsed.has(g)) st.collapsed.delete(g);
    else st.collapsed.add(g);
    renderPicker();
  });

  // ---------- chart ----------
  // Short source tag, only added when the chart mixes sources: "Station", "Inverter …8452".
  function shortSource(m) {
    if (m.sourceType === 'station') {
      return sources.stations.length > 1 ? sourceName(sources, 'station', m.sourceId) : 'Station';
    }
    const name = sourceName(sources, 'device', m.sourceId);
    return name.replace(m.sourceId, `…${m.sourceId.slice(-4)}`);
  }

  function seriesName(m) {
    if (!m) return '';
    const multiSource = new Set(st.selected.map((id) => byId.get(id) && byId.get(id).sourceId)).size > 1;
    return multiSource ? `${m.label} · ${shortSource(m)}` : m.label;
  }

  function toPanels(data) {
    const panels = new Map();
    for (const s of data.series) {
      const unit = s.metric.unit || '';
      if (!panels.has(unit)) panels.set(unit, { unit, title: unit ? `${quantityName(s.metric.quantity)} (${unit})` : 'Value', series: [] });
      panels.get(unit).series.push({
        id: s.metric.id,
        name: seriesName(s.metric),
        unit,
        color: slotColor(st.slots.get(s.metric.id) || 0),
        data: s.points,
      });
    }
    return [...panels.values()];
  }

  function visiblePanels(panels) {
    return panels.map((p) => ({ ...p, series: p.series.filter((s) => !st.hidden.has(s.name)) })).filter((p) => p.series.length);
  }

  function renderPills() {
    const el = $('#pills', root);
    el.innerHTML = st.selected
      .map((id) => {
        const m = byId.get(id);
        if (!m) return '';
        const name = seriesName(m);
        return `<span class="series-pill ${st.hidden.has(name) ? 'off' : ''}" data-id="${id}" title="Click to show/hide">
          <span class="swatch" style="background:${slotColor(st.slots.get(id))}"></span>${esc(name)}
          <button class="x" data-remove="${id}" title="Remove" aria-label="Remove ${esc(name)}">×</button></span>`;
      })
      .join('') || '<span class="small faint">Pick readings from the list to plot them.</span>';
  }
  $('#pills', root).onclick = (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      toggleMetric(Number(rm.dataset.remove), false);
      return;
    }
    const pill = e.target.closest('.series-pill');
    if (!pill) return;
    const name = seriesName(byId.get(Number(pill.dataset.id)));
    if (st.hidden.has(name)) st.hidden.delete(name);
    else st.hidden.add(name);
    chart.setHidden([...st.hidden]);
    renderPills();
    if (st.mode === 'table' && st.lastData) renderSeriesTable($('#table-wrap', root), visiblePanels(st.lastData));
  };

  function sizeChart(panelCount) {
    const per = window.innerWidth < 820 ? 230 : 260;
    chartEl.style.height = `${Math.max(panelCount, 1) * per + 60}px`;
  }

  async function load() {
    writeUrl();
    renderPills();
    const [from, to] = rangeToTimes(st.range, st.from, st.to);
    const id = ++st.reqId;
    if (!st.selected.length) {
      st.lastData = [];
      sizeChart(1);
      chart.setData([]);
      $('#chart-meta', root).textContent = '';
      $('#chart-title', root).textContent = 'Readings';
      if (st.mode === 'table') renderSeriesTable($('#table-wrap', root), []);
      return;
    }
    chart.loading(true);
    try {
      const data = await api.get('/api/series', {
        metrics: st.selected,
        from,
        to,
        bucket: st.bucket,
        agg: st.agg,
        tz: new Date().getTimezoneOffset(),
      });
      if (id !== st.reqId) return;
      const panels = toPanels(data);
      st.lastData = panels;
      st.window = { from, to, bucket: data.bucket };
      sizeChart(panels.length);
      chart.chart.resize();
      chart.setData(panels);
      chart.setHidden([...st.hidden]);
      const pts = data.series.reduce((n, s) => n + s.points.length, 0);
      $('#chart-title', root).textContent = `${st.selected.length} reading${st.selected.length > 1 ? 's' : ''}`;
      $('#chart-meta', root).innerHTML = `${esc(fmtTime(from))} → ${esc(fmtTime(to))} · ${pts.toLocaleString()} points · resolution ${esc(bucketLabel(data.bucket))}${data.bucket ? ` (${esc(st.agg)})` : ''} · scroll or drag to zoom, double-check exact values in Table view`;
      if (st.mode === 'table') renderSeriesTable($('#table-wrap', root), visiblePanels(panels));
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      if (id === st.reqId) chart.loading(false);
    }
  }

  // When zooming into a range that was downsampled, fetch finer data for just that window
  // and splice it into the coarse series, so the overview slider keeps the full range.
  async function refineZoom(startMs, endMs) {
    if (!st.window || !st.window.bucket || st.bucket !== 'auto' || !st.lastData) return;
    const from = Math.floor(startMs / 1000);
    const to = Math.ceil(endMs / 1000);
    if (to - from <= 0 || (to - from) / 2000 >= st.window.bucket / 2) return;
    const id = st.reqId;
    try {
      const data = await api.get('/api/series', { metrics: st.selected, from, to, bucket: 'auto', agg: st.agg, tz: new Date().getTimezoneOffset() });
      if (id !== st.reqId) return;
      const fine = new Map(data.series.map((s) => [s.metric.id, s.points]));
      for (const p of st.lastData) {
        for (const s of p.series) {
          const f = fine.get(s.id);
          if (!f) continue;
          s.data = [...s.data.filter(([t]) => t < startMs), ...f, ...s.data.filter(([t]) => t > endMs)];
        }
      }
      chart.setData(st.lastData, { keepZoom: true });
      chart.setHidden([...st.hidden]);
      $('#chart-meta', root).textContent += ' · refined for zoom';
    } catch {
      /* keep the coarse data */
    }
  }

  // ---------- saved views ----------
  function currentView() {
    return { m: st.selected, r: st.range, from: st.from, to: st.to, b: st.bucket, a: st.agg, t: st.type, s: st.source, hidden: [...st.hidden] };
  }
  function renderViews() {
    const views = prefs.views || [];
    $('#views', root).innerHTML = views.length
      ? `<div class="row">${views
          .map(
            (v, i) => `<span class="series-pill" data-load="${i}">${icon('chart', 'style="width:13px;height:13px"')} ${esc(v.name)}
              <button class="x" data-del="${i}" title="Delete view">×</button></span>`
          )
          .join('')}</div>`
      : '<p class="small faint">Save combinations of readings, ranges and settings to reopen them in one click.</p>';
  }
  $('#views', root).onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const v = prefs.views[Number(del.dataset.del)];
      if (!(await confirmDialog('Delete view', `Delete the saved view "${v.name}"?`, 'Delete'))) return;
      prefs.views.splice(Number(del.dataset.del), 1);
      await api.put('/api/prefs', { prefs });
      renderViews();
      return;
    }
    const ld = e.target.closest('[data-load]');
    if (!ld) return;
    const v = prefs.views[Number(ld.dataset.load)];
    st.selected = (v.m || []).filter((id) => byId.has(id)).slice(0, MAX_SERIES);
    st.slots = new Map(st.selected.map((id, i) => [id, i]));
    st.range = v.r || 'today';
    st.from = v.from || null;
    st.to = v.to || null;
    st.bucket = v.b || 'auto';
    st.agg = v.a || 'avg';
    st.type = v.t || 'line';
    st.source = v.s || '';
    st.hidden = new Set(v.hidden || []);
    chart.setType(st.type);
    syncControls();
    renderPicker();
    load();
  };
  $('#save-view', root).onclick = async () => {
    if (!st.selected.length) return toast('Select at least one reading first', 'err');
    const res = await modal({ title: 'Save view', body: '<label class="field">Name<input type="text" name="name" required maxlength="60" placeholder="e.g. Battery health"></label>' });
    if (!res || !res.name.trim()) return;
    prefs.views = prefs.views || [];
    prefs.views.push({ name: res.name.trim(), ...currentView() });
    await api.put('/api/prefs', { prefs });
    renderViews();
    toast('View saved', 'ok');
  };
  $('#export', root).onclick = () => {
    if (!st.selected.length) return toast('Select at least one reading first', 'err');
    const [from, to] = rangeToTimes(st.range, st.from, st.to);
    location.href = api.url('/api/export.csv', { metrics: st.selected, from, to, bucket: st.bucket, agg: st.agg, tz: new Date().getTimezoneOffset() });
  };
  $('#copy-link', root).onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied', 'ok');
    } catch {
      toast('Copy failed — use the address bar', 'err');
    }
  };

  syncControls();
  renderPicker();
  renderViews();
  load();

  return () => chart.dispose();
}

function bucketLabel(b) {
  if (!b) return 'raw';
  if (b < 3600) return `${b / 60} min`;
  if (b < 86400) return `${b / 3600} h`;
  return `${b / 86400} d`;
}

function quantityName(q) {
  return {
    power: 'Power',
    energy: 'Energy',
    voltage: 'Voltage',
    current: 'Current',
    frequency: 'Frequency',
    percent: 'Percentage',
    temperature: 'Temperature',
  }[q] || 'Value';
}
