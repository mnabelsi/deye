import { api } from '../api.js';
import { $, $$, esc, icon, cssVar, fmtPower, fmtEnergy, fmtNumber, fmtAgo, fmtTime, fmtValue, startOfDay, localDateStr, modal, toast } from '../util.js';
import { createTimeChart, renderSeriesTable } from '../charts.js';
import { ROLES, DEFAULT_NAMES, resolveFlow, describeParts, combineSeries, generatorEnergyToday, candidates, sourceNames, splitFlows, sourceOn, nodeVolts, phaseCount, toAmps } from '../flow.js';

const TH = 15; // watts below which a flow counts as idle
// Zero-export inverters keep the grid hovering a few tens of watts from 0 even when it isn't needed.
const SOURCE_IDLE = 50;

const NOMINAL_VOLTS = 230; // used for amps when no voltage reading is available

const watts = (w) => {
  const p = fmtPower(w);
  return `${p.value} ${p.unit}`.trim();
};

/**
 * Formats home, grid and generator power in the chosen unit (W or A). Amps are watts ÷ the
 * measured voltage of that source (per phase on three phases). Solar and battery always stay in
 * watts: they are DC, where amps at the house voltage mean nothing.
 */
function powerUnits({ unit, f, station, gridOn, genOn }) {
  const phases = phaseCount(station);
  const gv = nodeVolts(f.gridVoltage);
  const nv = nodeVolts(f.generatorVoltage);
  const lv = nodeVolts(f.loadVoltage);
  const homeV = lv || (gridOn && gv) || (genOn && nv) || null;
  const volts = { grid: gv || lv || NOMINAL_VOLTS, generator: nv || lv || NOMINAL_VOLTS, home: homeV || NOMINAL_VOLTS };
  const measured = { grid: Boolean(gv || lv), generator: Boolean(nv || lv), home: Boolean(homeV) };
  const amps = unit === 'A';
  const obj = (w, kind) => {
    const abs = w === null || w === undefined ? null : Math.abs(w);
    if (!amps || abs === null) return fmtPower(abs);
    const a = toAmps(abs, volts[kind], phases);
    return { value: fmtNumber(a, a < 100 ? 1 : 0), unit: 'A' };
  };
  const text = (kind) => (w) => {
    const p = obj(w, kind);
    return `${p.value} ${p.unit}`.trim();
  };
  const on = { home: true, grid: gridOn !== false, generator: genOn !== false };
  return { amps, phases, volts, measured, on, obj, home: text('home'), grid: text('grid'), generator: text('generator') };
}

// Which voltages the amps come from; a source that is off has none to show.
function ampsNote(u, names, showGenerator) {
  const v = (kind, label) => `${label} ${fmtNumber(u.volts[kind], 0)} V${u.measured[kind] ? '' : ' assumed'}`;
  const sources = [['home', 'home'], ['grid', names.grid], ...(showGenerator ? [['generator', names.generator]] : [])];
  const list = sources.filter(([kind]) => u.on[kind]).map(([kind, label]) => v(kind, label));
  return `<p class="split-note">Amps = watts ÷ voltage (${esc(list.join(' · '))})${u.phases === 3 ? ', per phase on this 3-phase system' : ''}. Solar and battery stay in watts.</p>`;
}

// Why an available grid/generator isn't needed right now.
function coverReason(split, load) {
  if ((load || 0) <= TH) return 'the home is using almost nothing';
  const near = (w) => w >= load - SOURCE_IDLE;
  if (near(split.solarToHome)) return 'solar covers the home';
  if (near(split.batteryToHome)) return 'the battery covers the home';
  if (near(split.solarToHome + split.batteryToHome)) return 'solar and the battery cover the home';
  return '';
}

/**
 * What an outside source is doing: off, on but not needed (and why), supplying or exporting.
 * Returns { on, short, text } where short fits a KPI tile.
 */
function sourceStatus({ on, power, toHome, toBattery, isGrid, split, load, fmt = watts }) {
  const p = power || 0;
  if (on === false) return { on, short: 'Off', text: isGrid ? 'No grid power right now' : 'Not running' };
  if (p > SOURCE_IDLE) {
    const where = [toHome > TH ? `${fmt(toHome)} to the home` : '', toBattery > TH ? `${fmt(toBattery)} charging the battery` : ''].filter(Boolean).join(' · ');
    return { on: true, short: 'In use', text: `In use, supplying ${fmt(p)}${where ? `: ${where}` : ''}` };
  }
  if (isGrid && p < -SOURCE_IDLE) {
    const from = [split.solarToGrid > TH ? `${fmt(split.solarToGrid)} of extra solar` : '', split.batteryToGrid > TH ? `${fmt(split.batteryToGrid)} from the battery` : ''].filter(Boolean).join(' · ');
    return { on: true, short: 'Exporting', text: `Exporting ${fmt(-p)}${from ? `: ${from}` : ''}` };
  }
  const why = coverReason(split, load);
  if (on) return { on, short: 'Not used', text: `On but not used${why ? `, ${why}` : ''}` };
  return { on: null, short: 'Not used', text: `Not used${why ? `, ${why}` : ''} (no voltage reading to tell whether it is on)` };
}

// One row of the breakdown: a stacked bar and "x to A · y to B" for the parts above TH.
function splitRow(title, total, items, empty, state = '', fmt = watts) {
  const shown = items.filter((x) => x.w > TH);
  const sum = shown.reduce((a, x) => a + x.w, 0);
  const bar = sum > 0
    ? `<div class="split-bar">${shown.map((x) => `<span style="width:${((x.w / sum) * 100).toFixed(1)}%;background:var(${x.color})"></span>`).join('')}</div>`
    : '<div class="split-bar"></div>';
  const text = (state ? `<span class="split-state">${esc(state)}</span>` : '') + (shown.length
    ? shown.map((x) => `<span class="split-part"><i style="background:var(${x.color})"></i>${esc(fmt(x.w))} ${esc(x.label)}</span>`).join('')
    : `<span class="faint">${esc(empty)}</span>`);
  return `<div class="split-row"><div class="split-title">${esc(title)}<b>${esc(total)}</b></div>${bar}<div class="split-text">${text}</div></div>`;
}

function statusRow(title, status) {
  const badge = status.on === true ? '<span class="badge ok">On</span>' : status.on === false ? '<span class="badge off">Off</span>' : '';
  return `<div class="split-row"><div class="split-title">${esc(title)}${badge}</div><div class="split-text">${esc(status.text)}</div></div>`;
}

function breakdown({ solar, load, battery, soc, split, names, gridStatus, genStatus, u, showGenerator }) {
  const b = battery || 0;
  const pct = soc !== null && soc !== undefined ? ` · ${fmtNumber(soc, 0)}%` : '';
  const battState = `${b < -TH ? 'Charging' : b > TH ? 'Discharging' : 'Idle'}${pct}`;
  const battItems = b < -TH
    ? [
        { w: split.solarToBattery, label: 'from solar', color: '--solar' },
        { w: split.generatorToBattery, label: `from ${names.generator}`, color: '--generator' },
        { w: split.gridToBattery, label: `from ${names.grid}`, color: '--grid' },
      ]
    : [
        { w: split.batteryToHome, label: 'to the home', color: '--load' },
        { w: split.batteryToGrid, label: `to ${names.grid}`, color: '--export' },
      ];
  return `<div class="flow-split">
    ${splitRow('Solar', watts(solar), [
      { w: split.solarToHome, label: 'to the home', color: '--load' },
      { w: split.solarToBattery, label: 'charging the battery', color: '--battery' },
      { w: split.solarToGrid, label: `to ${names.grid}`, color: '--export' },
    ], 'No solar right now')}
    ${splitRow('Home', u.home(load), [
      { w: split.solarToHome, label: 'from solar', color: '--solar' },
      { w: split.batteryToHome, label: 'from the battery', color: '--discharge' },
      { w: split.generatorToHome, label: `from ${names.generator}`, color: '--generator' },
      { w: split.gridToHome, label: `from ${names.grid}`, color: '--grid' },
    ], 'Using almost nothing', '', u.home)}
    ${splitRow('Battery', watts(Math.abs(b)), battItems, b > TH || b < -TH ? 'not matched to the other readings' : '', battState)}
    ${gridStatus ? statusRow(names.grid, gridStatus) : ''}
    ${genStatus ? statusRow(names.generator, genStatus) : ''}
    ${u.amps ? ampsNote(u, names, showGenerator) : ''}
  </div>`;
}

function kpi({ label, power, color, ic, sub, pct }) {
  const p = typeof power === 'object' && power !== null ? power : fmtPower(power);
  return `<div class="card kpi" style="--c:var(${color})">
    <div class="kpi-top"><div class="kpi-icon">${icon(ic)}</div><div class="kpi-label">${esc(label)}</div></div>
    <div class="kpi-value">${esc(p.value)}<small>${esc(p.unit)}</small></div>
    <div class="kpi-sub">${sub || ''}</div>
    ${pct !== undefined && pct !== null ? `<div class="bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>` : ''}
  </div>`;
}

const iconInner = (name) => icon(name).replace(/^<svg[^>]*>|<\/svg>$/g, '');

// Line from the edge of node (x1,y1) to the edge of the inverter at (x2,y2).
function seg(x1, y1, x2, y2, r1 = 31, r2 = 33) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  return `M${(x1 + ux * r1).toFixed(1)} ${(y1 + uy * r1).toFixed(1)} L${(x2 - ux * r2).toFixed(1)} ${(y2 - uy * r2).toFixed(1)}`;
}

function flowSvg({ solar, load, grid, generator, battery, soc, showGenerator, names, gridOn, genOn, u }) {
  const c = {
    solar: cssVar('--solar'),
    load: cssVar('--load'),
    grid: cssVar('--grid'),
    export: cssVar('--export'),
    generator: cssVar('--generator'),
    battery: cssVar('--battery'),
    inv: cssVar('--primary'),
  };
  const fp = (w) => {
    const p = fmtPower(w === null || w === undefined ? null : Math.abs(w));
    return `${p.value} ${p.unit}`.trim();
  };
  const node = (x, y, label, value, color, ic, off) => `
    <g${off ? ' class="node-off"' : ''}>
      <circle class="node-circle" cx="${x}" cy="${y}" r="30" stroke="${color}"/>
      <g transform="translate(${x - 11}, ${y - 11})" style="color:${color}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconInner(ic)}</svg></g>
      <text class="node-value" x="${x}" y="${y + 50}">${esc(value)}</text>
      <text class="node-label" x="${x}" y="${y + 66}">${esc(label)}</text>
    </g>`;
  // Lines are drawn node → inverter; "rev" animates the other way (power flowing out to the node).
  const line = (d, active, color, reverse) => `<path class="line" d="${d}"/>${active ? `<path class="line-active ${reverse ? 'rev' : ''}" d="${d}" stroke="${color}"/>` : ''}`;
  const CX = 220;
  const CY = 165;
  const gridPos = showGenerator ? [62, 98] : [62, 165];
  const genPos = [62, 236];
  const g = grid || 0;
  const gridColor = g < -TH ? c.export : c.grid;
  const gridLabel = gridOn === false ? `${names.grid} · off` : g > TH ? `${names.grid} · importing` : g < -TH ? `${names.grid} · exporting` : gridOn ? `${names.grid} · on` : names.grid;
  const genLabel = genOn === false ? `${names.generator} · off` : (generator || 0) > TH ? `${names.generator} · running` : genOn ? `${names.generator} · on` : names.generator;
  return `<svg class="flow" viewBox="0 0 440 345" role="img" aria-label="Power flow diagram">
    ${line(seg(CX, 46, CX, CY), (solar || 0) > TH, c.solar, false)}
    ${line(seg(gridPos[0], gridPos[1], CX, CY), Math.abs(g) > TH, gridColor, g < 0)}
    ${showGenerator ? line(seg(genPos[0], genPos[1], CX, CY), (generator || 0) > TH, c.generator, false) : ''}
    ${line(seg(378, CY, CX, CY), (load || 0) > TH, c.load, true)}
    ${line(seg(CX, 266, CX, CY), Math.abs(battery || 0) > TH, c.battery, (battery || 0) < 0)}
    ${node(CX, 46, 'Solar', fp(solar), c.solar, 'sun')}
    ${node(gridPos[0], gridPos[1], gridLabel, gridOn === false ? 'Off' : u.grid(grid), gridColor, 'grid', gridOn === false)}
    ${showGenerator ? node(genPos[0], genPos[1], genLabel, genOn === false ? 'Off' : u.generator(generator), c.generator, 'plug', genOn === false) : ''}
    ${node(378, CY, 'Home', u.home(load), c.load, 'home')}
    ${node(CX, 266, `Battery${soc !== null && soc !== undefined ? ` · ${fmtNumber(soc, 0)}%` : ''}`, fp(battery), c.battery, 'battery')}
    <g><circle class="node-circle" cx="${CX}" cy="${CY}" r="32" stroke="${c.inv}"/>
      <g transform="translate(${CX - 11},${CY - 11})" style="color:${c.inv}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconInner('bolt')}</svg></g></g>
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

  const st = { day: startOfDay(), hidden: new Set(), mode: 'chart', panels: [], flow: null, unit: 'W' };
  try {
    if (localStorage.getItem('deye-power-unit') === 'A') st.unit = 'A';
  } catch {}

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
          <div class="card-head"><h2>Power flow</h2><span class="small faint" id="updated"></span>
            <div class="seg sm" id="units" title="Show home, grid and generator power in watts or amps"><button data-v="W">W</button><button data-v="A">A</button></div>
            ${ctx.user.isAdmin ? `<button class="btn sm ghost" id="customize" title="Choose which readings feed each node">${icon('settings')} Customize</button>` : ''}</div>
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
    const f = resolveFlow(s);
    st.flow = f;
    const solar = f.solar.value;
    const load = f.load.value;
    const grid = f.grid.value;
    const battery = f.battery.value;
    const soc = f.soc.value;
    const generator = f.generator.value;
    const showGenerator = !f.generator.hidden && f.generator.parts.length > 0;
    const genToday = generatorEnergyToday(s);
    const names = sourceNames(s);
    const namedGrid = names.grid !== DEFAULT_NAMES.grid;
    const e = s.energy;
    const cap = s.installedCapacity ? Number(s.installedCapacity) * 1000 : null;
    const ageMin = s.lastTs ? (Date.now() / 1000 - s.lastTs) / 60 : null;
    const kwh = (v) => {
      const x = fmtEnergy(v);
      return `${x.value} ${x.unit}`;
    };

    $('#stale', root).innerHTML = ageMin !== null && ageMin > 30
      ? `<div class="alert warn" style="margin:0">${icon('warn')}<div class="grow">Latest data from DeyeCloud is ${esc(fmtAgo(s.lastTs))}. The logger may be offline or the collector is not running.</div></div>`
      : '';

    const split = splitFlows({ solar, load, grid, generator, battery });
    const gridOn = f.grid.hidden ? null : sourceOn(f.gridVoltage, grid, SOURCE_IDLE);
    const genOn = showGenerator ? sourceOn(f.generatorVoltage, generator, SOURCE_IDLE) : null;
    const u = powerUnits({ unit: st.unit, f, station: s, gridOn, genOn });
    // In amps the tiles also keep the watts, so both are visible.
    const alsoW = (w) => (u.amps && w !== null ? `${esc(watts(Math.abs(w)))} · ` : '');
    const gridStatus = f.grid.hidden
      ? null
      : sourceStatus({ on: gridOn, power: grid, toHome: split.gridToHome, toBattery: split.gridToBattery, isGrid: true, split, load, fmt: u.grid });
    const genStatus = showGenerator
      ? sourceStatus({ on: genOn, power: generator, toHome: split.generatorToHome, toBattery: split.generatorToBattery, isGrid: false, split, load, fmt: u.generator })
      : null;
    const tileState = (st) => (!st ? '' : st.on === null ? st.short : st.on ? `On · ${st.short.toLowerCase()}` : 'Off');
    const gridState = tileState(gridStatus);
    const tiles = [
      kpi({ label: 'Solar', power: solar, color: '--solar', ic: 'sun', sub: cap && solar !== null ? `${fmtNumber((solar / cap) * 100, 0)}% of ${fmtNumber(s.installedCapacity)} kWp` : 'PV generation', pct: cap && solar !== null ? (solar / cap) * 100 : null }),
      kpi({ label: 'Home load', power: u.obj(load, 'home'), color: '--load', ic: 'home', sub: `${alsoW(load)}${e.consumptionValue !== undefined ? `${esc(kwh(e.consumptionValue))} today` : 'Consumption'}` }),
      kpi({
        label: namedGrid ? names.grid : grid !== null && grid < -TH ? 'Grid export' : 'Grid import',
        power: u.obj(grid, 'grid'),
        color: grid !== null && grid < -TH ? '--export' : '--grid',
        ic: 'grid',
        sub: `${alsoW(grid)}${gridState}${e.purchaseValue !== undefined ? `${gridState ? ' · ' : ''}${esc(kwh(e.purchaseValue))} imported today` : ''}`,
      }),
    ];
    if (showGenerator) {
      tiles.push(
        kpi({
          label: names.generator,
          power: u.obj(generator, 'generator'),
          color: '--generator',
          ic: 'plug',
          sub: `${alsoW(generator)}${tileState(genStatus)}${genToday !== null ? ` · ${esc(kwh(genToday))} today` : ''}`,
        })
      );
    }
    tiles.push(
      kpi({
        label: 'Battery',
        power: battery === null ? null : Math.abs(battery),
        color: '--battery',
        ic: 'battery',
        sub: `${battery === null ? '' : battery < -TH ? 'Charging' : battery > TH ? 'Discharging' : 'Idle'}${soc !== null ? ` · ${fmtNumber(soc, 0)}% charged` : ''}`,
        pct: soc,
      }),
      kpi({ label: 'Generated today', power: fmtEnergy(e.generationValue), color: '--solar', ic: 'bolt', sub: !s.energyDay ? 'Waiting for daily statistics' : s.energyDay === localDateStr(new Date()) ? 'Daily statistics' : `For ${esc(s.energyDay)}` })
    );
    $('#kpis', root).innerHTML = tiles.join('');

    $('#flow', root).innerHTML =
      flowSvg({ solar, load, grid, generator, battery, soc, showGenerator, names, gridOn, genOn, u }) +
      breakdown({ solar, load, battery, soc, split, names, gridStatus, genStatus, u, showGenerator });
    $('#updated', root).textContent = s.lastTs ? `Updated ${fmtAgo(s.lastTs)} · ${fmtTime(s.lastTs, { timeStyle: 'short' })}` : '';

    const mini = (label, v, color) => {
      const x = fmtEnergy(v);
      return `<div class="kpi" style="--c:var(${color});padding:4px 2px"><div class="row" style="gap:7px"><span class="swatch" style="width:10px;height:10px;border-radius:3px;background:var(${color})"></span><span class="kpi-label">${esc(label)}</span></div>
        <div class="kpi-value" style="font-size:21px">${esc(x.value)}<small>${esc(x.unit)}</small></div></div>`;
    };
    $('#today-title', root).textContent = s.energyDay && s.energyDay !== localDateStr(new Date()) ? `Energy · ${s.energyDay}` : 'Energy today';
    $('#today', root).innerHTML = [
      mini('Generated', e.generationValue, '--solar'),
      mini('Consumed', e.consumptionValue, '--load'),
      mini(namedGrid ? names.grid : 'Grid import', e.purchaseValue, '--grid'),
      mini(`${names.grid} export`, e.gridValue, '--export'),
      ...(genToday !== null ? [mini(names.generator, genToday, '--generator')] : []),
      mini('Battery charged', e.chargeValue, '--battery'),
      mini('Battery discharged', e.dischargeValue, '--discharge'),
    ].join('');
  }

  // Order validated for colour-vision separation: battery, solar, generator, load, grid.
  function chartNodes() {
    const f = st.flow;
    const names = sourceNames(station());
    return [
      { role: 'battery', name: 'Battery', color: '--battery' },
      { role: 'solar', name: 'Solar', color: '--solar' },
      { role: 'generator', name: names.generator, color: '--generator' },
      { role: 'load', name: 'Load', color: '--load' },
      { role: 'grid', name: names.grid, color: '--grid' },
    ].filter((n) => !f[n.role].hidden && f[n.role].parts.length);
  }

  async function loadChart() {
    if (!st.flow) return;
    $('#day', root).value = localDateStr(st.day);
    const from = Math.floor(st.day.getTime() / 1000);
    const to = from + 86400;
    const nodes = chartNodes();
    const soc = st.flow.soc.parts;
    const ids = [...new Set([...nodes.flatMap((n) => st.flow[n.role].parts.map((p) => p.metric.id)), ...soc.map((p) => p.metric.id)])];
    $('#open-explorer', root).href = `#/charts?m=${ids.slice(0, 8).join(',')}&r=custom&from=${from}&to=${to}`;
    if (!ids.length) {
      st.panels = [];
      chart.setData([]);
      renderPills();
      return;
    }
    chart.loading(true);
    try {
      const data = await api.get('/api/series', { metrics: ids, from, to, bucket: 'auto', tz: new Date().getTimezoneOffset() });
      const byId = new Map(data.series.map((x) => [x.metric.id, x.points]));
      const power = nodes
        .map((n) => ({ id: `node-${n.role}`, name: n.name, unit: 'W', color: cssVar(n.color), data: combineSeries(st.flow[n.role].parts, byId) }))
        .filter((x) => x.data.length);
      const panels = [{ title: 'Power (W) · grid + import / − export · battery + discharge / − charge', unit: 'W', series: power }];
      const socData = combineSeries(soc, byId);
      if (socData.length) panels.push({ title: 'Battery state of charge (%)', unit: '%', series: [{ id: 'node-soc', name: 'SOC', unit: '%', color: cssVar('--battery'), data: socData }] });
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

  // Lets an admin pick the exact reading behind each node when auto-detection guesses wrong.
  async function customize() {
    const s = station();
    const f = resolveFlow(s);
    const map = s.flowMap || {};
    const opt = (m) => `${m.label} — ${m.sourceType === 'station' ? 'station' : m.sourceId} · ${fmtValue(m.lastValue, m.unit)}`;
    const names = map.names || {};
    const nameField = (role, example) => `<label class="field">${esc(DEFAULT_NAMES[role])} name <span class="hint">e.g. ${esc(example)}</span>
        <input type="text" name="name_${role}" maxlength="40" placeholder="${esc(DEFAULT_NAMES[role])}" value="${esc(names[role] || '')}"></label>`;
    const body = ROLES.map(({ role, label, kind, signed, hint }) => {
      const cur = map[role] || {};
      const list = candidates(s, kind).sort((a, b) => a.label.localeCompare(b.label));
      const autoText = f[role].auto ? describeParts(f[role].parts) : 'see list';
      return `<label class="field">${esc(label)}${signed || hint ? ` <span class="hint">${esc(signed || hint)}</span>` : ''}
          <select name="${role}">
            <option value="">Automatic (${esc(autoText)})</option>
            <option value="hidden" ${cur.hidden ? 'selected' : ''}>Hide this node</option>
            ${list.map((m) => `<option value="${m.id}" ${cur.metricId === m.id ? 'selected' : ''}>${esc(opt(m))}</option>`).join('')}
          </select></label>
        ${signed ? `<label class="check small" style="margin-top:-8px"><input type="checkbox" name="${role}Invert" ${cur.invert ? 'checked' : ''}> Invert sign of the chosen reading</label>` : ''}`;
    }).join('');
    const res = await modal({
      title: 'Customize power flow',
      submitLabel: 'Save',
      body: `<div class="grid cols-2" style="gap:12px">${nameField('grid', 'Kadisha')}${nameField('generator', 'Eshtirak')}</div>
        <p class="small muted" style="margin:0">Pick the reading that feeds each node. Find names and live values under Devices &amp; Readings (e.g. search “gen” or “grid”).</p>${body}`,
    });
    if (!res) return;
    const out = {};
    for (const { role } of ROLES) {
      if (res[role] === 'hidden') out[role] = { hidden: true };
      else if (res[role]) out[role] = { metricId: Number(res[role]), invert: Boolean(res[`${role}Invert`]) };
    }
    try {
      await api.put(`/api/flowmap/${encodeURIComponent(s.id)}`, { map: out, names: { grid: res.name_grid, generator: res.name_generator } });
      live = await api.get('/api/live');
      renderLive();
      await loadChart();
      toast('Power flow updated', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  }
  if ($('#customize', root)) $('#customize', root).onclick = customize;

  const markUnit = () => $$('#units button', root).forEach((x) => x.classList.toggle('active', x.dataset.v === st.unit));
  $('#units', root).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === st.unit) return;
    st.unit = b.dataset.v;
    try {
      localStorage.setItem('deye-power-unit', st.unit);
    } catch {}
    markUnit();
    renderLive();
  };
  markUnit();

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
