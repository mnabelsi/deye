import { api } from '../api.js';
import { $, $$, esc, icon, cssVar, fmtPower, fmtEnergy, fmtNumber, fmtAgo, fmtTime, startOfDay, localDateStr } from '../util.js';
import { createTimeChart, renderSeriesTable } from '../charts.js';

// Station-level keys from /station/latest, with inverter measure points as a fallback
// for accounts where station data is missing.
const FALLBACK_KEYS = {
  generationPower: ['totalsolarpower', 'pvpower', 'totaldcinputpower', 'totalpvpower'],
  consumptionPower: ['totalconsumptionpower', 'loadpower', 'totalloadpower'],
  gridPower: ['totalgridpower', 'gridpower', 'totalexternalctpower'],
  batteryPower: ['batterypower', 'totalbatterypower'],
  batterySOC: ['soc', 'batterysoc', 'bmssoc'],
};

function pick(station, key) {
  const v = station.values[key];
  if (v !== undefined && v !== null && v !== '') return Number(v);
  const candidates = FALLBACK_KEYS[key] || [];
  for (const d of station.devices) {
    for (const m of d.metrics) {
      if (candidates.includes(m.key.toLowerCase()) && m.lastValue !== null && m.lastValue !== undefined) return Number(m.lastValue);
    }
  }
  return null;
}

function metricIdFor(station, key) {
  if (station.metricIds[key]) return station.metricIds[key];
  const candidates = FALLBACK_KEYS[key] || [];
  for (const d of station.devices) for (const m of d.metrics) if (candidates.includes(m.key.toLowerCase())) return m.id;
  return null;
}

// Positive = importing from the grid, negative = exporting.
function gridFlow(station) {
  const buy = pick(station, 'purchasePower');
  const sell = pick(station, 'wirePower');
  if (buy !== null || sell !== null) {
    if ((buy || 0) > 0) return buy;
    if ((sell || 0) > 0) return -sell;
  }
  const g = pick(station, 'gridPower');
  return g === null ? (buy !== null || sell !== null ? 0 : null) : g;
}

// Positive = discharging, negative = charging (Deye's convention for battery power).
function batteryFlow(station) {
  const ch = pick(station, 'chargePower');
  const dis = pick(station, 'dischargePower');
  if (ch !== null || dis !== null) {
    if ((ch || 0) > 0) return -ch;
    if ((dis || 0) > 0) return dis;
  }
  const b = pick(station, 'batteryPower');
  return b === null ? (ch !== null || dis !== null ? 0 : null) : b;
}

function kpi({ label, power, color, ic, sub, pct }) {
  const p = typeof power === 'object' ? power : fmtPower(power);
  return `<div class="card kpi" style="--c:var(${color})">
    <div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
    <div class="kpi-value">${esc(p.value)}<small>${esc(p.unit)}</small></div>
    <div class="kpi-sub">${sub || ''}</div>
    ${pct !== undefined && pct !== null ? `<div class="bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>` : ''}
  </div>`;
}

function flowSvg({ solar, load, grid, battery, soc }) {
  const node = (x, y, label, value, color, ic) => `
    <g>
      <circle class="node-circle" cx="${x}" cy="${y}" r="30" stroke="${color}"/>
      <g transform="translate(${x - 11}, ${y - 11})" style="color:${color}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon(ic).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg></g>
      <text class="node-value" x="${x}" y="${y + 50}">${esc(value)}</text>
      <text class="node-label" x="${x}" y="${y + 66}">${esc(label)}</text>
    </g>`;
  const line = (d, active, color, reverse) => `
    <path class="line" d="${d}"/>
    ${active ? `<path class="line-active ${reverse ? 'rev' : ''}" d="${d}" stroke="${color}"/>` : ''}`;
  const c = { solar: cssVar('--solar'), load: cssVar('--load'), grid: cssVar('--grid'), export: cssVar('--export'), battery: cssVar('--battery'), inv: cssVar('--primary') };
  const fp = (w) => {
    const p = fmtPower(w === null ? null : Math.abs(w));
    return `${p.value} ${p.unit}`;
  };
  const th = 15;
  return `<svg class="flow" viewBox="0 0 440 345" role="img" aria-label="Power flow diagram">
    ${line('M220 78 L220 132', (solar || 0) > th, c.solar, false)}
    ${line('M92 165 L188 165', Math.abs(grid || 0) > th, (grid || 0) < 0 ? c.export : c.grid, (grid || 0) < 0)}
    ${line('M252 165 L348 165', (load || 0) > th, c.load, false)}
    ${line('M220 198 L220 236', Math.abs(battery || 0) > th, c.battery, (battery || 0) < 0)}
    ${node(220, 46, 'Solar', fp(solar), c.solar, 'sun')}
    ${node(62, 165, (grid || 0) < -th ? 'Grid · exporting' : (grid || 0) > th ? 'Grid · importing' : 'Grid', fp(grid), (grid || 0) < 0 ? c.export : c.grid, 'grid')}
    ${node(378, 165, 'Home', fp(load), c.load, 'home')}
    ${node(220, 266, `Battery${soc !== null ? ` · ${fmtNumber(soc, 0)}%` : ''}`, fp(battery), c.battery, 'battery')}
    <g><circle class="node-circle" cx="220" cy="165" r="32" stroke="${c.inv}"/>
      <g transform="translate(209,154)" style="color:${c.inv}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon('bolt').replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg></g></g>
  </svg>`;
}

export async function mount(root, ctx) {
  let live = await api.get('/api/live');
  if (!live.stations.length) {
    const st = ctx.store.status;
    root.innerHTML = `
      ${ctx.user.mustChangePassword ? `<div class="alert warn">${icon('warn')}<div class="grow"><b>Default password in use.</b> Change it in <a href="#/settings">Settings</a>.</div></div>` : ''}
      <div class="card empty" style="padding:56px 20px">
        ${icon('sun')}
        <h3>No data yet</h3>
        <p>${st && st.configured ? 'Your DeyeCloud connection is configured. The first collection runs within a few minutes.' : 'Connect your DeyeCloud account to start collecting inverter data.'}</p>
        <div class="row" style="justify-content:center;margin-top:12px">
          <a class="btn primary" href="#/settings">${icon('settings')} Open settings</a>
          ${st && st.configured ? `<button class="btn" id="collect-now">${icon('refresh')} Collect now</button>` : ''}
        </div>
      </div>`;
    const btn = $('#collect-now', root);
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner sm"></span> Collecting…';
        try {
          await api.post('/api/collector/run', { discover: true });
          await ctx.store.sources(true);
          location.reload();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = err.message;
        }
      };
    }
    return;
  }

  let stationId = null;
  try {
    stationId = localStorage.getItem('deye-station');
  } catch {}
  if (!live.stations.some((s) => s.id === stationId)) stationId = live.stations[0].id;

  const st = { day: startOfDay(), hidden: new Set(), mode: 'chart', panels: [] };

  if (live.stations.length > 1) {
    ctx.actions.innerHTML = `<select id="station-select" class="inline-input">${live.stations.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>`;
    const sel = $('#station-select');
    sel.value = stationId;
    sel.onchange = () => {
      stationId = sel.value;
      try {
        localStorage.setItem('deye-station', stationId);
      } catch {}
      renderLive();
      loadChart();
    };
  }

  root.innerHTML = `
    <div class="stack">
      ${ctx.user.mustChangePassword ? `<div class="alert warn">${icon('warn')}<div class="grow"><b>You are using the default password (admin / 123456).</b> Change it in <a href="#/settings">Settings</a>.</div></div>` : ''}
      <div id="stale"></div>
      <div class="grid kpis" id="kpis"></div>
      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h2>Power flow</h2><span class="small faint" id="updated"></span></div>
          <div id="flow"></div>
        </div>
        <div class="card">
          <div class="card-head"><h2 id="today-title">Today</h2><a class="small" href="#/energy">Energy history →</a></div>
          <div class="grid kpis" id="today" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:10px"></div>
        </div>
      </div>
      <div class="card" style="padding:12px 14px">
        <div class="row">
          <button class="btn icon sm" id="prev-day" title="Previous day">‹</button>
          <input type="date" id="day" class="inline-input">
          <button class="btn icon sm" id="next-day" title="Next day">›</button>
          <button class="btn sm" id="today-btn">Today</button>
          <span class="spacer"></span>
          <div class="seg" id="modes"><button data-v="chart">Chart</button><button data-v="table">Table</button></div>
          <a class="btn sm" id="open-explorer" href="#/charts">${icon('chart')} Open in Charts</a>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2 id="chart-title">Power</h2></div>
        <div class="row" style="margin-bottom:10px"><div class="series-pills" id="pills"></div></div>
        <div class="chart tall" id="chart"></div>
        <div id="table" class="hidden"></div>
      </div>
    </div>`;

  const chart = createTimeChart($('#chart', root), { type: 'line' });

  function station() {
    return live.stations.find((s) => s.id === stationId);
  }

  function renderLive() {
    const s = station();
    const solar = pick(s, 'generationPower');
    const load = pick(s, 'consumptionPower');
    const grid = gridFlow(s);
    const battery = batteryFlow(s);
    const soc = pick(s, 'batterySOC');
    const cap = s.installedCapacity ? Number(s.installedCapacity) * 1000 : null;
    const ageMin = s.lastTs ? (Date.now() / 1000 - s.lastTs) / 60 : null;

    $('#stale', root).innerHTML = ageMin !== null && ageMin > 30
      ? `<div class="alert warn" style="margin:0">${icon('warn')}<div class="grow">Latest data from DeyeCloud is ${esc(fmtAgo(s.lastTs))}. The logger may be offline or the collector is not running.</div></div>`
      : '';

    $('#kpis', root).innerHTML = [
      kpi({ label: 'Solar', power: solar, color: '--solar', ic: 'sun', sub: cap ? `${fmtNumber((solar / cap) * 100, 0)}% of ${fmtNumber(s.installedCapacity)} kWp` : 'PV generation', pct: cap ? (solar / cap) * 100 : null }),
      kpi({ label: 'Home load', power: load, color: '--load', ic: 'home', sub: 'Consumption' }),
      kpi({
        label: 'Grid',
        power: grid === null ? null : Math.abs(grid),
        color: grid !== null && grid < 0 ? '--export' : '--grid',
        ic: 'grid',
        sub: grid === null ? '' : grid > 15 ? 'Importing' : grid < -15 ? 'Exporting' : 'Idle',
      }),
      kpi({
        label: 'Battery',
        power: battery === null ? null : Math.abs(battery),
        color: '--battery',
        ic: 'battery',
        sub: battery === null ? '' : battery < -15 ? 'Charging' : battery > 15 ? 'Discharging' : 'Idle',
      }),
      kpi({ label: 'State of charge', power: { value: soc === null ? '—' : fmtNumber(soc, 0), unit: soc === null ? '' : '%' }, color: '--battery', ic: 'battery', sub: 'Battery SOC', pct: soc }),
      kpi({ label: 'Generated today', power: fmtEnergy(s.energy.generationValue), color: '--solar', ic: 'bolt', sub: !s.energyDay ? 'Waiting for daily statistics' : s.energyDay === localDateStr(new Date()) ? 'Daily statistics' : `For ${esc(s.energyDay)}` }),
    ].join('');

    $('#flow', root).innerHTML = flowSvg({ solar, load, grid, battery, soc });
    $('#updated', root).textContent = s.lastTs ? `Updated ${fmtAgo(s.lastTs)} · ${fmtTime(s.lastTs, { timeStyle: 'short' })}` : '';

    const e = s.energy;
    const mini = (label, kwh, color) => {
      const v = fmtEnergy(kwh);
      return `<div class="kpi" style="--c:var(${color});padding:4px 2px"><div class="row" style="gap:7px"><span class="swatch" style="width:10px;height:10px;border-radius:3px;background:var(${color})"></span><span class="kpi-label">${esc(label)}</span></div>
        <div class="kpi-value" style="font-size:21px">${esc(v.value)}<small>${esc(v.unit)}</small></div></div>`;
    };
    $('#today-title', root).textContent = s.energyDay && s.energyDay !== localDateStr(new Date()) ? `Energy · ${s.energyDay}` : 'Energy today';
    $('#today', root).innerHTML = [
      mini('Generated', e.generationValue, '--solar'),
      mini('Consumed', e.consumptionValue, '--load'),
      mini('Imported', e.purchaseValue, '--grid'),
      mini('Exported', e.gridValue, '--export'),
      mini('Battery charged', e.chargeValue, '--battery'),
      mini('Battery discharged', e.dischargeValue, '--gen'),
    ].join('');
  }

  // Validated order: solar, battery, load, grid.
  function chartSeriesDefs(s) {
    return [
      { key: 'generationPower', name: 'Solar', color: '--solar' },
      { key: 'batteryPower', name: 'Battery', color: '--battery' },
      { key: 'consumptionPower', name: 'Load', color: '--load' },
      { key: 'gridPower', name: 'Grid', color: '--grid' },
    ]
      .map((d) => ({ ...d, id: metricIdFor(s, d.key) }))
      .filter((d) => d.id);
  }

  async function loadChart() {
    const s = station();
    $('#day', root).value = localDateStr(st.day);
    const from = Math.floor(st.day.getTime() / 1000);
    const to = from + 86400;
    const defs = chartSeriesDefs(s);
    const socId = metricIdFor(s, 'batterySOC');
    const ids = [...defs.map((d) => d.id), ...(socId ? [socId] : [])];
    $('#open-explorer', root).href = `#/charts?m=${ids.join(',')}&r=custom&from=${from}&to=${to}`;
    if (!ids.length) {
      chart.setData([]);
      return;
    }
    chart.loading(true);
    try {
      const data = await api.get('/api/series', { metrics: ids, from, to, bucket: 'auto', tz: new Date().getTimezoneOffset() });
      const pts = new Map(data.series.map((x) => [x.metric.id, x]));
      const panels = [
        {
          title: 'Power (W)',
          unit: 'W',
          series: defs.filter((d) => pts.has(d.id)).map((d) => ({ id: d.id, name: d.name, unit: pts.get(d.id).metric.unit || 'W', color: cssVar(d.color), data: pts.get(d.id).points })),
        },
      ];
      if (socId && pts.has(socId)) {
        panels.push({ title: 'Battery state of charge (%)', unit: '%', series: [{ id: socId, name: 'SOC', unit: '%', color: cssVar('--battery'), data: pts.get(socId).points }] });
      }
      st.panels = panels.filter((p) => p.series.length);
      chart.setData(st.panels);
      chart.setHidden([...st.hidden]);
      renderPills();
      if (st.mode === 'table') renderSeriesTable($('#table', root), visiblePanels());
    } finally {
      chart.loading(false);
    }
  }

  function visiblePanels() {
    return st.panels.map((p) => ({ ...p, series: p.series.filter((x) => !st.hidden.has(x.name)) })).filter((p) => p.series.length);
  }

  function renderPills() {
    const all = st.panels.flatMap((p) => p.series);
    $('#pills', root).innerHTML = all.length
      ? all.map((x) => `<span class="series-pill ${st.hidden.has(x.name) ? 'off' : ''}" data-n="${esc(x.name)}" title="Click to show/hide"><span class="swatch" style="background:${x.color}"></span>${esc(x.name)}</span>`).join('')
      : '<span class="small faint">No power readings stored for this day.</span>';
  }

  $('#pills', root).onclick = (e) => {
    const p = e.target.closest('.series-pill');
    if (!p) return;
    const n = p.dataset.n;
    if (st.hidden.has(n)) st.hidden.delete(n);
    else st.hidden.add(n);
    chart.setHidden([...st.hidden]);
    renderPills();
    if (st.mode === 'table') renderSeriesTable($('#table', root), visiblePanels());
  };
  $('#modes', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.mode = b.dataset.v;
    $$('#modes button', root).forEach((x) => x.classList.toggle('active', x.dataset.v === st.mode));
    $('#chart', root).classList.toggle('hidden', st.mode !== 'chart');
    $('#table', root).classList.toggle('hidden', st.mode !== 'table');
    if (st.mode === 'table') renderSeriesTable($('#table', root), visiblePanels());
  };
  $$('#modes button', root).forEach((x) => x.classList.toggle('active', x.dataset.v === st.mode));
  const shiftDay = (n) => {
    const d = new Date(st.day);
    d.setDate(d.getDate() + n);
    if (d > new Date()) return;
    st.day = startOfDay(d);
    loadChart();
  };
  $('#prev-day', root).onclick = () => shiftDay(-1);
  $('#next-day', root).onclick = () => shiftDay(1);
  $('#today-btn', root).onclick = () => {
    st.day = startOfDay();
    loadChart();
  };
  $('#day', root).onchange = (e) => {
    const [y, m, d] = e.target.value.split('-').map(Number);
    if (!y) return;
    st.day = new Date(y, m - 1, d);
    loadChart();
  };

  renderLive();
  await loadChart();

  // Live refresh every minute; the chart only refreshes while viewing today.
  const timer = setInterval(async () => {
    try {
      live = await api.get('/api/live');
      renderLive();
      if (localDateStr(st.day) === localDateStr(new Date())) loadChart();
    } catch {
      /* transient */
    }
  }, 60000);

  return () => {
    clearInterval(timer);
    chart.dispose();
  };
}
