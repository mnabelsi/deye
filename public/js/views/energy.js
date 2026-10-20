import { api } from '../api.js';
import { $, $$, esc, icon, cssVar, fmtEnergy, fmtNumber, localDateStr } from '../util.js';
import { createBarChart } from '../charts.js';

// Fixed order validated for colour-vision deficiency separation (see css tokens).
const SERIES = [
  { key: 'generationValue', label: 'Generation', color: '--solar' },
  { key: 'chargeValue', label: 'Battery charge', color: '--battery' },
  { key: 'consumptionValue', label: 'Consumption', color: '--load' },
  { key: 'purchaseValue', label: 'Grid import', color: '--grid' },
  { key: 'gridValue', label: 'Grid export', color: '--export' },
  { key: 'dischargeValue', label: 'Battery discharge', color: '--gen' },
];

const PRESETS = [
  ['month', 'This month', 'day'],
  ['30d', 'Last 30 days', 'day'],
  ['year', 'This year', 'month'],
  ['12m', 'Last 12 months', 'month'],
  ['all', 'All time', 'year'],
  ['custom', 'Custom', null],
];

function presetRange(key) {
  const now = new Date();
  const d = (y, m, day) => localDateStr(new Date(y, m, day));
  switch (key) {
    case 'month': return [d(now.getFullYear(), now.getMonth(), 1), localDateStr(now)];
    case '30d': return [d(now.getFullYear(), now.getMonth(), now.getDate() - 29), localDateStr(now)];
    case 'year': return [d(now.getFullYear(), 0, 1), localDateStr(now)];
    case '12m': return [d(now.getFullYear(), now.getMonth() - 11, 1), localDateStr(now)];
    default: return ['2000-01-01', localDateStr(now)];
  }
}

export async function mount(root, ctx) {
  const sources = await ctx.store.sources();
  const st = {
    station: ctx.params.get('station') || (sources.stations[0] && sources.stations[0].id) || '',
    preset: ctx.params.get('p') || 'month',
    group: ctx.params.get('g') || 'day',
    from: null,
    to: null,
    hidden: new Set(['chargeValue', 'dischargeValue']),
    mode: 'chart',
    rows: [],
  };
  [st.from, st.to] = presetRange(st.preset);

  root.innerHTML = `
    <div class="stack">
      <div class="card" style="padding:12px 14px">
        <div class="row">
          ${sources.stations.length > 1 ? `<select id="station" class="inline-input">${sources.stations.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>` : ''}
          <div class="seg" id="presets">${PRESETS.map(([k, l]) => `<button data-p="${k}">${l}</button>`).join('')}</div>
          <div class="row hidden" id="custom">
            <input type="date" id="from" class="inline-input"><span class="faint">→</span><input type="date" id="to" class="inline-input">
          </div>
          <span class="spacer"></span>
          <div class="seg" id="groups"><button data-g="day">Daily</button><button data-g="month">Monthly</button><button data-g="year">Yearly</button></div>
        </div>
      </div>
      <div class="grid kpis" id="totals"></div>
      <div class="card">
        <div class="card-head">
          <h2>Energy</h2>
          <div class="seg" id="modes"><button data-v="chart">Chart</button><button data-v="table">Table</button></div>
        </div>
        <div class="row" style="margin-bottom:10px"><div class="series-pills" id="pills"></div></div>
        <div class="chart" id="chart"></div>
        <div id="table" class="hidden"></div>
        <p class="small faint" style="margin-top:8px">Daily totals come from DeyeCloud's station statistics. Import older history from Settings → Import history.</p>
      </div>
    </div>`;

  const chart = createBarChart($('#chart', root));

  function sync() {
    $$('#presets button', root).forEach((b) => b.classList.toggle('active', b.dataset.p === st.preset));
    $$('#groups button', root).forEach((b) => b.classList.toggle('active', b.dataset.g === st.group));
    $$('#modes button', root).forEach((b) => b.classList.toggle('active', b.dataset.v === st.mode));
    $('#custom', root).classList.toggle('hidden', st.preset !== 'custom');
    $('#from', root).value = st.from;
    $('#to', root).value = st.to;
    if ($('#station', root)) $('#station', root).value = st.station;
  }

  function renderPills() {
    $('#pills', root).innerHTML = SERIES.map(
      (s) => `<span class="series-pill ${st.hidden.has(s.key) ? 'off' : ''}" data-k="${s.key}" title="Click to show/hide">
        <span class="swatch" style="background:${cssVar(s.color)};border-radius:3px"></span>${esc(s.label)}</span>`
    ).join('');
  }

  function render() {
    const rows = st.rows;
    const sum = (k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const t = Object.fromEntries(SERIES.map((s) => [s.key, sum(s.key)]));
    const selfSufficiency = t.consumptionValue > 0 ? Math.max(0, Math.min(100, (1 - t.purchaseValue / t.consumptionValue) * 100)) : null;
    const selfConsumption = t.generationValue > 0 ? Math.max(0, Math.min(100, (1 - t.gridValue / t.generationValue) * 100)) : null;
    const tile = (label, kwh, color, ic, sub) => {
      const e = fmtEnergy(kwh);
      return `<div class="card kpi" style="--c:var(${color})"><div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
        <div class="kpi-value">${e.value}<small>${e.unit}</small></div><div class="kpi-sub">${sub || ''}</div></div>`;
    };
    const pct = (label, v, color, ic, sub) => `<div class="card kpi" style="--c:var(${color})"><div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
      <div class="kpi-value">${v === null ? '—' : fmtNumber(v, 0)}<small>%</small></div><div class="kpi-sub">${esc(sub)}</div>
      <div class="bar"><span style="width:${v || 0}%"></span></div></div>`;
    $('#totals', root).innerHTML = [
      tile('Generated', t.generationValue, '--solar', 'sun', `${rows.length} ${st.group === 'day' ? 'days' : st.group === 'month' ? 'months' : 'years'}`),
      tile('Consumed', t.consumptionValue, '--load', 'home'),
      tile('Imported', t.purchaseValue, '--grid', 'grid'),
      tile('Exported', t.gridValue, '--export', 'grid'),
      pct('Self-sufficiency', selfSufficiency, '--battery', 'battery', 'Share of consumption not bought from the grid'),
      pct('Self-consumption', selfConsumption, '--solar', 'bolt', 'Share of generation used on site'),
    ].join('');

    const visible = SERIES.filter((s) => !st.hidden.has(s.key));
    chart.setData({
      categories: rows.map((r) => r.period),
      unit: 'kWh',
      series: visible.map((s) => ({ name: s.label, color: cssVar(s.color), data: rows.map((r) => (r[s.key] === undefined ? null : r[s.key])) })),
    });

    $('#table', root).innerHTML = rows.length
      ? `<div class="table-wrap tall"><table class="table"><thead><tr><th>Period</th>${visible.map((s) => `<th class="num">${esc(s.label)} <span class="faint">(kWh)</span></th>`).join('')}</tr></thead>
        <tbody>${[...rows].reverse().map((r) => `<tr><td>${esc(r.period)}</td>${visible.map((s) => `<td class="num">${r[s.key] === undefined || r[s.key] === null ? '<span class="faint">—</span>' : esc(fmtNumber(r[s.key], 2))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${icon('energy')}<h3>No energy statistics in this range</h3><p>They are collected hourly, or import them from Settings → Import history.</p></div>`;
    const empty = !rows.length;
    $('#chart', root).classList.toggle('hidden', empty || st.mode !== 'chart');
    $('#table', root).classList.toggle('hidden', !empty && st.mode !== 'table');
    if (!empty && st.mode === 'chart') chart.chart.resize();
  }

  async function load() {
    chart.loading(true);
    try {
      const res = await api.get('/api/energy', { stationId: st.station, from: st.from, to: st.to, group: st.group });
      st.rows = res.rows;
      render();
    } finally {
      chart.loading(false);
    }
  }

  $('#presets', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.preset = b.dataset.p;
    const preset = PRESETS.find((p) => p[0] === st.preset);
    if (st.preset !== 'custom') [st.from, st.to] = presetRange(st.preset);
    if (preset[2]) st.group = preset[2];
    sync();
    load();
  };
  $('#groups', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.group = b.dataset.g;
    sync();
    load();
  };
  $('#modes', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.mode = b.dataset.v;
    sync();
    render();
  };
  $('#pills', root).onclick = (e) => {
    const p = e.target.closest('.series-pill');
    if (!p) return;
    if (st.hidden.has(p.dataset.k)) st.hidden.delete(p.dataset.k);
    else st.hidden.add(p.dataset.k);
    renderPills();
    render();
  };
  const onDate = () => {
    st.from = $('#from', root).value || st.from;
    st.to = $('#to', root).value || st.to;
    load();
  };
  $('#from', root).onchange = onDate;
  $('#to', root).onchange = onDate;
  if ($('#station', root)) {
    $('#station', root).onchange = (e) => {
      st.station = e.target.value;
      load();
    };
  }

  sync();
  renderPills();
  await load();
  return () => chart.dispose();
}
