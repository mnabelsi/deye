import { api } from '../api.js';
import { $, $$, esc, icon, cssVar, fmtEnergy, fmtNumber, localDateStr } from '../util.js';
import { createBarChart } from '../charts.js';
import { DEFAULT_NAMES, resolveFlow, sourceNames } from '../flow.js';

// Where the electricity came from (solar, grid, generator) and how much was used. The first four
// are in an order validated for colour-vision separation; the rest start hidden.
function seriesFor(names, hasGenerator) {
  const gridName = names.grid === DEFAULT_NAMES.grid ? 'Grid import' : names.grid;
  return [
    { key: 'solarValue', label: 'Solar', color: '--solar' },
    ...(hasGenerator ? [{ key: 'generatorValue', label: names.generator, color: '--generator' }] : []),
    { key: 'consumptionValue', label: 'Consumption', color: '--load' },
    { key: 'purchaseValue', label: gridName, color: '--grid' },
    { key: 'gridValue', label: `${names.grid} export`, color: '--export' },
    { key: 'chargeValue', label: 'Battery charge', color: '--battery' },
    { key: 'dischargeValue', label: 'Battery discharge', color: '--discharge' },
  ];
}

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
  const [sources, live] = await Promise.all([ctx.store.sources(), api.get('/api/live')]);
  const st = {
    station: ctx.params.get('station') || (sources.stations[0] && sources.stations[0].id) || '',
    preset: ctx.params.get('p') || 'month',
    group: ctx.params.get('g') || 'day',
    from: null,
    to: null,
    hidden: new Set(['gridValue', 'chargeValue', 'dischargeValue']),
    mode: 'chart',
    rows: [],
  };

  // The generator's energy is computed from whichever reading feeds the Overview's generator node.
  function sourcesFor(stationId) {
    const s = live.stations.find((x) => x.id === stationId);
    const gen = s ? resolveFlow(s).generator : null;
    const genParts = gen && !gen.hidden ? gen.parts : [];
    return { names: sourceNames(s), gen: genParts.map((p) => `${p.metric.id}:${p.scale}`).join(',') };
  }
  let src = sourcesFor(st.station);
  let SERIES = seriesFor(src.names, Boolean(src.gen));
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
        <p class="small faint" style="margin-top:8px" id="footnote"></p>
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
    const bought = t.purchaseValue + (t.generatorValue || 0);
    const supply = t.solarValue + bought;
    const share = (v) => (supply > 0 ? `${fmtNumber((v / supply) * 100, 0)}% of supply` : '');
    const { names } = src;
    const gridName = names.grid === DEFAULT_NAMES.grid ? 'Grid import' : names.grid;
    const boughtFrom = src.gen ? `${names.grid} or ${names.generator}` : names.grid;
    const selfSufficiency = t.consumptionValue > 0 ? Math.max(0, Math.min(100, (1 - bought / t.consumptionValue) * 100)) : null;
    const selfConsumption = t.solarValue > 0 ? Math.max(0, Math.min(100, (1 - t.gridValue / t.solarValue) * 100)) : null;
    const tile = (label, kwh, color, ic, sub) => {
      const e = fmtEnergy(kwh);
      return `<div class="card kpi" style="--c:var(${color})"><div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
        <div class="kpi-value">${e.value}<small>${e.unit}</small></div><div class="kpi-sub">${sub || ''}</div></div>`;
    };
    const pct = (label, v, color, ic, sub) => `<div class="card kpi" style="--c:var(${color})"><div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
      <div class="kpi-value">${v === null ? '—' : fmtNumber(v, 0)}<small>%</small></div><div class="kpi-sub">${esc(sub)}</div>
      <div class="bar"><span style="width:${v || 0}%"></span></div></div>`;
    // Export and self-consumption only matter when something was exported.
    const exported = t.gridValue > 0.05;
    $('#totals', root).innerHTML = [
      tile('Consumed', t.consumptionValue, '--load', 'home', `${rows.length} ${st.group === 'day' ? 'days' : st.group === 'month' ? 'months' : 'years'}`),
      tile('Solar', t.solarValue, '--solar', 'sun', share(t.solarValue)),
      tile(gridName, t.purchaseValue, '--grid', 'grid', share(t.purchaseValue)),
      ...(src.gen ? [tile(names.generator, t.generatorValue, '--generator', 'plug', share(t.generatorValue))] : []),
      ...(exported ? [tile(`${names.grid} export`, t.gridValue, '--export', 'grid')] : []),
      pct('Self-sufficiency', selfSufficiency, '--battery', 'battery', `Share of consumption not bought from ${boughtFrom}`),
      ...(exported ? [pct('Self-consumption', selfConsumption, '--solar', 'bolt', 'Share of solar used on site')] : []),
    ].join('');
    const grid = names.grid === DEFAULT_NAMES.grid ? 'grid import' : names.grid;
    $('#footnote', root).textContent = `Consumption and ${grid} come from DeyeCloud's daily statistics. ${
      src.gen
        ? `Solar is DeyeCloud's daily production minus ${names.generator}, because DeyeCloud counts the generator as production; ${names.generator} is worked out from its stored power readings (—: none stored for that period). `
        : ''
    }Consumed is measured by the inverter: it is roughly ${src.gen ? `solar + ${grid} + ${names.generator}` : `solar + ${grid}`}, plus what the battery gave, minus what it stored and inverter losses. Import older history from Settings → Import history.`;

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
      const res = await api.get('/api/energy', {
        stationId: st.station,
        from: st.from,
        to: st.to,
        group: st.group,
        gen: src.gen,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
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
      src = sourcesFor(st.station);
      SERIES = seriesFor(src.names, Boolean(src.gen));
      renderPills();
      load();
    };
  }

  sync();
  renderPills();
  await load();
  return () => chart.dispose();
}
