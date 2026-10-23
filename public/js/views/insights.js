import { api } from '../api.js';
import { $, $$, esc, icon, cssVar, fmtNumber, localDateStr, toast } from '../util.js';
import { createCurveChart } from '../charts.js';
import { resolveFlow, combineSeries, sourceNames } from '../flow.js';
import { buildHours, analyse, DEFAULT_ASSUMPTIONS } from '../insights-model.js';

const ROLES = ['solar', 'load', 'grid', 'generator', 'battery', 'soc', 'gridVoltage', 'generatorVoltage'];
const PERIODS = [
  ['12m', 'Last 12 months', 365],
  ['6m', 'Last 6 months', 182],
  ['90d', 'Last 90 days', 90],
];
// Scenario identity colours: the first three categorical slots, which stay apart as overlapping lines.
const COLORS = { solar: '--s1', grid: '--s2', generator: '--s3' };
const MODULE_KWH = 5.12; // a common 51.2 V 100 Ah LiFePO4 module
const STORE_KEY = 'deye-insights-assumptions';

function loadAssumptions() {
  try {
    return { ...DEFAULT_ASSUMPTIONS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_ASSUMPTIONS };
  }
}

function saveAssumptions(a) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(a));
  } catch {
    /* private mode */
  }
}

const kwh = (v, digits) => `${fmtNumber(v, digits !== undefined ? digits : v < 10 ? 1 : 0)} kWh`;
const roundUp = (v, step) => Math.ceil(v / step - 1e-9) * step;
const monthName = (key, style = 'long') => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, style === 'long' ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
};
const dateText = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export async function mount(root, ctx) {
  const live = await api.get('/api/live');
  if (!live.stations.length) {
    root.innerHTML = `<div class="card empty" style="padding:56px 20px">${icon('battery')}<h3>No data yet</h3><p>Connect DeyeCloud in Settings and import your history first.</p></div>`;
    return;
  }

  const st = {
    station: live.stations[0].id,
    period: ctx.params.get('p') || '12m',
    mode: 'chart',
    assumptions: loadAssumptions(),
    hours: null,
    result: null,
  };
  const station = () => live.stations.find((s) => s.id === st.station);

  root.innerHTML = `
    <div class="stack">
      <div class="card" style="padding:12px 14px">
        <div class="row">
          ${live.stations.length > 1 ? `<select id="station" class="inline-input">${live.stations.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>` : ''}
          <div class="seg" id="periods">${PERIODS.map(([k, l]) => `<button data-p="${k}">${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <a class="btn sm ghost" href="#assumptions">${icon('settings')} Assumptions</a>
        </div>
      </div>
      <div id="body"></div>
    </div>`;

  let chart = null;
  const body = $('#body', root);

  function sync() {
    $$('#periods button', root).forEach((b) => b.classList.toggle('active', b.dataset.p === st.period));
    if ($('#station', root)) $('#station', root).value = st.station;
  }

  async function load() {
    if (chart) {
      chart.dispose();
      chart = null;
    }
    const days = PERIODS.find((p) => p[0] === st.period)[2];
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const s = station();
    const flow = resolveFlow(s);
    const ids = [...new Set(ROLES.flatMap((r) => (flow[r].hidden ? [] : flow[r].parts.map((p) => p.metric.id))))];
    body.innerHTML = `<div class="card"><div class="boot" style="min-height:260px;flex-direction:column;gap:12px"><div class="spinner"></div><span class="small faint">Reading ${days} days of hourly history…</span></div></div>`;
    if (!flow.load.parts.length || !flow.solar.parts.length) {
      body.innerHTML = `<div class="alert warn">${icon('warn')}<div class="grow">No solar or home-load readings were found for this station. Pick them in Overview → Customize.</div></div>`;
      return;
    }
    let data;
    try {
      data = await api.get('/api/series', { metrics: ids, from, to, bucket: 3600 });
    } catch (err) {
      body.innerHTML = `<div class="alert err">${icon('warn')}<div class="grow"><b>Could not read the history.</b> ${esc(err.message)}</div></div>`;
      return;
    }
    const byId = new Map(data.series.map((x) => [x.metric.id, x.points]));
    const series = Object.fromEntries(ROLES.map((r) => [r, flow[r].hidden ? [] : combineSeries(flow[r].parts, byId)]));
    st.hours = buildHours(series, from, to);
    st.from = from;
    st.to = to;
    analyseAndRender();
  }

  function analyseAndRender() {
    const s = station();
    st.result = analyse(st.hours, s, st.assumptions);
    render();
  }

  // ---------- rendering ----------

  function render() {
    const r = st.result;
    const s = station();
    const names = sourceNames(s);
    if (chart) {
      chart.dispose();
      chart = null;
    }
    if (!r.ok) {
      body.innerHTML = `<div class="card empty" style="padding:48px 20px">${icon('history')}<h3>Not enough hourly history</h3>
        <p>The analysis needs stored solar and consumption readings. Import your history from Settings → Import history (pick the date the system was installed, or 12 months back).</p>
        ${importButton(true)}</div>`;
      bindImport();
      return;
    }
    const periodDays = PERIODS.find((p) => p[0] === st.period)[2];
    const scenarioTitle = { solar: 'Solar only', grid: `Solar + ${names.grid}`, generator: `Solar + ${names.generator}` };
    const scenarioSub = {
      solar: `No ${names.grid}, no ${names.generator}: fully self-sufficient`,
      grid: `Never need ${names.generator}`,
      generator: `Never need ${names.grid}`,
    };
    const excluded = { solar: `${names.grid} or ${names.generator}`, grid: names.generator, generator: names.grid };
    const kept = { grid: names.grid, generator: names.generator };
    const span = r.days >= 360 ? 'a year' : `these ${r.days} days`;

    const card = (sc) => {
      const color = COLORS[sc.id];
      let big;
      let lines = [];
      if (sc.required === 0) {
        big = `<div class="big">No battery needed</div>`;
      } else if (sc.practical) {
        const size = roundUp(sc.required, 0.5);
        big = `<div class="big">≈ ${fmtNumber(size, 1)}<small>kWh battery</small></div>`;
        lines.push(`${fmtNumber(sc.required * st.assumptions.dod, 1)} kWh usable · e.g. ${Math.ceil(sc.required / MODULE_KWH - 1e-9)} × ${MODULE_KWH} kWh modules`);
        if (sc.p99 !== null && sc.p99 < sc.required * 0.92) lines.push(`${fmtNumber(roundUp(sc.p99, 0.5), 1)} kWh already covers 99% of your use`);
      } else {
        big = `<div class="big">Not practical</div>`;
        lines.push(sc.required !== null ? `It would take ≈ ${kwh(sc.required, 0)} of battery` : `It would take more than ${kwh(r.searchMaxRated, 0)} of battery`);
        if (sc.morePanels) {
          const extra = Number(s.installedCapacity) > 0 ? ` (≈ +${fmtNumber(Number(s.installedCapacity) * (sc.morePanels.factor - 1), 1)} kWp)` : '';
          lines.push(`With ${fmtNumber((sc.morePanels.factor - 1) * 100, 0)}% more panels${extra}, ≈ ${kwh(roundUp(sc.morePanels.rated, 0.5), 1)} would do`);
        }
        if (sc.p99 !== null) lines.push(`≈ ${kwh(roundUp(sc.p99, 0.5), 1)} covers 99% of your use`);
      }
      const facts = [];
      if (sc.atCurrent && r.currentKwh) {
        const cur = `~${fmtNumber(r.currentKwh, 1)} kWh`;
        if (sc.atCurrent.missing <= Math.max(0.5, r.totals.load * 0.0005)) facts.push(`${icon('check')} Your current ${cur} battery already does this`);
        else {
          facts.push(
            `With your current ${cur} battery: <b>${fmtNumber(sc.atCurrent.coverage * 100, 1)}%</b> covered; ${kwh(sc.atCurrent.missing, 0)} over ${span} would still come from ${esc(excluded[sc.id])}${
              sc.atCurrent.worstMonth ? `, most of it in ${esc(monthName(sc.atCurrent.worstMonth))}` : ''
            }`
          );
        }
      }
      if (kept[sc.id] && sc.atRequired) facts.push(`You'd still buy ≈ ${kwh(sc.atRequired.bought, 0)} from ${esc(kept[sc.id])} over ${span}`);
      return `<div class="card scenario" style="--c:var(${color})">
        <div class="scenario-title"><span class="swatch"></span><h3>${esc(scenarioTitle[sc.id])}</h3></div>
        <div class="small muted">${esc(scenarioSub[sc.id])}</div>
        ${big}
        ${lines.map((l) => `<div class="small muted">${l}</div>`).join('')}
        ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${f}</li>`).join('')}</ul>` : ''}
      </div>`;
    };

    const notes = [];
    if (r.days < periodDays * 0.85) {
      notes.push(`<div class="alert warn" style="margin:0">${icon('warn')}<div class="grow"><b>Only ${r.days} days of hourly history in this period</b> (${esc(dateText(r.firstTs))} – ${esc(dateText(r.lastTs))}).
        The sizes below only reflect those days${r.days < 300 ? '; winter and summer can change them a lot' : ''}. Import the rest of the period to size for the full ${esc(PERIODS.find((p) => p[0] === st.period)[1].toLowerCase())}.
        ${importButton(false)}</div></div>`);
    }
    if (r.gridMethod === 'power' || r.generatorMethod === 'power') {
      const which = [r.gridMethod === 'power' ? names.grid : null, r.generatorMethod === 'power' ? names.generator : null].filter(Boolean).join(' and ');
      notes.push(`<div class="alert" style="margin:0">${icon('info')}<div class="grow">No voltage reading was found for ${esc(which)}, so its on-hours are taken from when it delivered power. That undercounts them; pick the voltage reading in Overview → Customize if your inverter reports one.</div></div>`);
    }
    if (r.solar.method === 'measured') {
      notes.push(`<div class="alert" style="margin:0">${icon('info')}<div class="grow">Solar potential could not be estimated (station location or battery level missing), so measured solar is used. If your panels are throttled when the battery is full, the sizes below are too high.</div></div>`);
    }

    const t = r.totals;
    const wastedPct = t.potential > 0 ? (t.wasted / t.potential) * 100 : 0;
    const fact = (label, value, sub, color) => `<div class="card kpi" style="--c:var(${color})"><div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
    const val = (v, unit, d) => `${esc(fmtNumber(v, d))}<small>${esc(unit)}</small>`;
    const facts = [
      fact('Average day', val(r.avgDaily, 'kWh', 1), `${esc(kwh(t.load, 0))} in ${r.days} days · busiest hour ${esc(fmtNumber(r.peakKw, 1))} kW`, '--load'),
      r.nights ? fact('Average night', val(r.nights.avg, 'kWh', 1), `Sunset to sunrise · worst ${esc(kwh(r.nights.max, 1))}`, '--load') : '',
      r.battery ? fact('Your battery', val(r.currentKwh, 'kWh', 1), r.battery.estimated ? 'Estimated from how fast its charge level drops' : 'As entered under Assumptions', '--battery') : '',
      fact('Solar possible', val(t.potential, 'kWh', 0), `${esc(kwh(t.solar, 0))} used · ${esc(fmtNumber(wastedPct, 0))}% lost while the battery was full`, '--solar'),
      ...[
        ['grid', 'gridHours', r.gridMethod],
        ['generator', 'generatorHours', r.generatorMethod],
      ]
        .filter(([, , method]) => method !== 'none')
        .map(([role, key, method]) =>
          fact(names[role], val(avg(r.months, key), 'h/day', 1), method === 'voltage' ? 'Average hours with power' : 'Average hours it delivered power', role === 'grid' ? '--grid' : '--generator')
        ),
    ];

    const sc = r.scenarios;
    body.innerHTML = `
      <div class="stack">
        ${notes.join('')}
        <div class="grid scenarios">${sc.map(card).join('')}</div>
        <div class="card">
          <div class="card-head">
            <h2>Battery size vs. share of your use it covers</h2>
            <div class="seg" id="modes"><button data-v="chart">Chart</button><button data-v="table">Table</button></div>
          </div>
          <p class="small muted" style="margin-top:-4px">Each line is one choice of supply. Where a line flattens, extra battery buys little; the dashed line is your current battery.</p>
          <div class="series-pills static" style="margin-bottom:6px">${sc
            .map((x) => `<span class="series-pill"><span class="swatch" style="background:${cssVar(COLORS[x.id])}"></span>${esc(scenarioTitle[x.id])}</span>`)
            .join('')}</div>
          <div class="chart" id="curve"></div>
          <div id="curve-table" class="hidden"></div>
        </div>
        <div class="grid facts">${facts.join('')}</div>
        <div class="card">
          <div class="card-head"><h2>Month by month</h2></div>
          <div class="table-wrap">${monthTable(r, names)}</div>
          <p class="small faint" style="margin-top:8px">“Solar possible” adds an estimate of what the panels could have given in hours they were throttled because the battery was full.</p>
        </div>
        ${assumptionsCard(r)}
      </div>`;

    chart = createCurveChart($('#curve', body));
    const minY = Math.min(...Object.values(r.curve.series).flat());
    chart.setData({
      x: r.curve.sizes,
      xUnit: 'kWh',
      yUnit: '%',
      yMin: Math.max(0, Math.floor(minY / 10) * 10),
      series: sc.map((x) => ({ name: scenarioTitle[x.id], color: cssVar(COLORS[x.id]), data: r.curve.series[x.id] })),
      marker: r.currentKwh ? { x: Math.min(r.currentKwh, r.curve.sizes[r.curve.sizes.length - 1]), label: `Now ~${fmtNumber(r.currentKwh, 1)} kWh` } : null,
    });
    $('#curve-table', body).innerHTML = `<div class="table-wrap tall"><table class="table"><thead><tr><th class="num">Battery (kWh)</th>${sc
      .map((x) => `<th class="num">${esc(scenarioTitle[x.id])}</th>`)
      .join('')}</tr></thead><tbody>${r.curve.sizes
      .map((size, k) => `<tr><td class="num">${esc(fmtNumber(size, 1))}</td>${sc.map((x) => `<td class="num">${esc(fmtNumber(r.curve.series[x.id][k], 1))}%</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
    syncMode();
    $('#modes', body).onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      st.mode = b.dataset.v;
      syncMode();
    };
    bindImport();
    bindAssumptions();
  }

  function syncMode() {
    $$('#modes button', body).forEach((b) => b.classList.toggle('active', b.dataset.v === st.mode));
    $('#curve', body).classList.toggle('hidden', st.mode !== 'chart');
    $('#curve-table', body).classList.toggle('hidden', st.mode !== 'table');
    if (st.mode === 'chart' && chart) chart.chart.resize();
  }

  const avg = (rows, key) => {
    const days = rows.reduce((n, m) => n + m.days, 0);
    return days ? rows.reduce((n, m) => n + m[key] * m.days, 0) / days : 0;
  };

  function monthTable(r, names) {
    const head = ['Month', 'Used', 'Solar', 'Solar possible', names.grid, `${names.grid} h/day`, names.generator, `${names.generator} h/day`];
    const cell = (v, d = 0) => `<td class="num">${esc(fmtNumber(v, d))}</td>`;
    return `<table class="table"><thead><tr>${head.map((h, i) => `<th class="${i ? 'num' : ''}">${esc(h)}${i && !/h\/day/.test(h) ? ' <span class="faint">(kWh)</span>' : ''}</th>`).join('')}</tr></thead>
      <tbody>${r.months
        .map(
          (m) => `<tr><td>${esc(monthName(m.key, 'short'))}${m.days < 25 ? ` <span class="faint small">(${m.days} d)</span>` : ''}</td>${cell(m.load)}${cell(m.solar)}${cell(m.potential)}${cell(m.grid)}${cell(m.gridHours, 1)}${cell(m.generator)}${cell(m.generatorHours, 1)}</tr>`
        )
        .join('')}</tbody></table>`;
  }

  function assumptionsCard(r) {
    const a = st.assumptions;
    const est = r.battery && r.battery.estimated ? r.battery.kwh : null;
    return `<div class="card" id="assumptions">
      <div class="card-head"><h2>Assumptions</h2><button class="btn sm ghost" id="reset-assumptions">Reset</button></div>
      <form id="assumptions-form" class="grid fields" novalidate>
        <label class="field">Current battery <span class="hint">rated kWh${est ? `, estimated ${esc(fmtNumber(est, 1))}` : ''}</span>
          <input type="number" name="currentKwh" min="0" step="0.1" placeholder="${est ? esc(fmtNumber(est, 1)) : 'unknown'}" value="${a.currentKwh > 0 ? esc(a.currentKwh) : ''}"></label>
        <label class="field">Usable share <span class="hint">% of rated, LiFePO4 ≈ 90</span>
          <input type="number" name="dod" min="40" max="100" step="1" value="${esc(Math.round(a.dod * 100))}"></label>
        <label class="field">Round-trip efficiency <span class="hint">%</span>
          <input type="number" name="eta" min="60" max="100" step="1" value="${esc(Math.round(a.eta * 100))}"></label>
        <label class="field">Max charging from ${esc(sourceNames(station()).grid)} / ${esc(sourceNames(station()).generator)} <span class="hint">kW</span>
          <input type="number" name="extChargeKw" min="0.5" max="30" step="0.5" value="${esc(a.extChargeKw)}"></label>
      </form>
      <details style="margin-top:14px"><summary class="small" style="cursor:pointer">How this is worked out</summary>
        <div class="small muted" style="margin-top:8px;display:grid;gap:6px">
          <p>Every stored hour of the period is replayed with a battery of a given size: solar feeds the home first, the battery covers any shortfall, and while an allowed source (${esc(sourceNames(station()).grid)} or ${esc(sourceNames(station()).generator)}) has power it runs the home and recharges the battery, at up to the charging limit above. Whatever is still missing would have needed the source you want to drop. The smallest size that leaves nothing missing is the answer; the period is replayed twice so the battery does not start with free charge.</p>
          <p>Your inverter throttles the panels when the battery is full and nothing can be exported, so measured solar understates what a bigger battery could store. For those hours the possible output is estimated from the sun's position at your station, this array's output in unthrottled hours and that day's weather.</p>
          <p>When each source had power comes from its voltage reading (pick it in Overview → Customize). Charging is limited to ${esc(fmtNumber(a.cRate, 1))}C. The analysis uses hourly averages, so it does not check short peaks: make sure the inverter and battery can deliver your peak power.</p>
        </div>
      </details>
    </div>`;
  }

  function bindAssumptions() {
    const f = $('#assumptions-form', body);
    if (!f) return;
    f.onchange = () => {
      const num = (name, def) => {
        const v = parseFloat(f[name].value);
        return Number.isFinite(v) ? v : def;
      };
      st.assumptions = {
        currentKwh: num('currentKwh', 0) > 0 ? num('currentKwh', 0) : null,
        dod: Math.min(1, Math.max(0.4, num('dod', 90) / 100)),
        eta: Math.min(1, Math.max(0.6, num('eta', 90) / 100)),
        cRate: DEFAULT_ASSUMPTIONS.cRate,
        extChargeKw: Math.max(0.5, num('extChargeKw', DEFAULT_ASSUMPTIONS.extChargeKw)),
      };
      saveAssumptions(st.assumptions);
      analyseAndRender();
    };
    $('#reset-assumptions', body).onclick = () => {
      st.assumptions = { ...DEFAULT_ASSUMPTIONS };
      saveAssumptions(st.assumptions);
      analyseAndRender();
    };
  }

  // Admins can queue the missing part of the period for import straight from here.
  function importButton(all) {
    if (!ctx.user.isAdmin) return '<span class="small">Ask an admin to import it from Settings → Import history.</span>';
    return `<div style="margin-top:8px"><button class="btn sm primary" id="import-missing" data-all="${all ? 1 : 0}">${icon('history')} Import the missing history</button></div>`;
  }

  function bindImport() {
    const b = $('#import-missing', body);
    if (!b) return;
    b.onclick = async () => {
      const r = st.result;
      const from = localDateStr(new Date(st.from * 1000));
      const firstDay = r && r.ok ? new Date(r.firstTs * 1000) : new Date(st.to * 1000);
      if (r && r.ok) firstDay.setDate(firstDay.getDate() - 1);
      const to = localDateStr(firstDay);
      if (to < from) return toast('Nothing older to import for this period', 'ok');
      b.disabled = true;
      try {
        const res = await api.post('/api/collector/backfill', { from, to });
        toast(res.message, 'ok');
        b.outerHTML = `<p class="small" style="margin-top:8px">Importing ${esc(from)} → ${esc(to)} in the background (see Settings → Import history). Come back when it has finished.</p>`;
        ctx.store.refreshStatus();
      } catch (err) {
        b.disabled = false;
        toast(err.message, 'err');
      }
    };
  }

  $('#periods', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.period = b.dataset.p;
    sync();
    load();
  };
  if ($('#station', root)) {
    $('#station', root).onchange = (e) => {
      st.station = e.target.value;
      load();
    };
  }

  sync();
  await load();
  return () => {
    if (chart) chart.dispose();
  };
}
