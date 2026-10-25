// Works out which stored readings feed each power-flow node (solar, load, grid, generator,
// battery, SOC), plus the grid and generator voltages that show when each source has power.
// DeyeCloud key names differ between inverter models, so readings are matched by name and unit;
// an admin can override any node in the Customize dialog (saved per station).
//
// A resolved node is a list of parts { metric, scale }: its value is Σ value × scale. This covers
// kW → W, inverted signs, grid = purchase − feed-in and per-phase readings that must be summed.

export const ROLES = [
  { role: 'solar', label: 'Solar', kind: 'power' },
  { role: 'load', label: 'Home load', kind: 'power' },
  { role: 'grid', label: 'Grid', kind: 'power', signed: 'import is positive, export negative' },
  { role: 'generator', label: 'Generator', kind: 'power' },
  { role: 'battery', label: 'Battery', kind: 'power', signed: 'discharge is positive, charge negative' },
  { role: 'soc', label: 'Battery SOC', kind: 'percent' },
  { role: 'gridVoltage', label: 'Grid voltage', kind: 'presence', hint: 'shows when the grid has power' },
  { role: 'generatorVoltage', label: 'Generator voltage', kind: 'presence', hint: 'shows when the generator runs' },
  { role: 'loadVoltage', label: 'Home voltage', kind: 'voltage', hint: 'turns home power into amps' },
  { role: 'batteryVoltage', label: 'Battery voltage', kind: 'voltage', hint: 'turns battery power into amps' },
];

// Display names for the two outside sources, e.g. "Kadisha" and "Eshtirak". Set in Customize.
export const DEFAULT_NAMES = { grid: 'Grid', generator: 'Generator' };

const unitOf = (m) => String(m.unit || '').trim().toLowerCase();
const isPower = (m) => m.kind === 'number' && ['w', 'kw'].includes(unitOf(m));
const isPercent = (m) => m.kind === 'number' && unitOf(m) === '%';
const isPresence = (m) => m.kind === 'number' && ['v', 'hz'].includes(unitOf(m));
const isVoltage = (m) => m.kind === 'number' && unitOf(m) === 'v';
const wattScale = (m) => (unitOf(m) === 'kw' ? 1000 : 1);
const PHASE = /(l[123]|phase ?[123abc]|[_\s][abc])$/i;
// "Gen"/"Generator" at a CamelCase word start; not "Generation" (PV) or "ChargingEnergy".
const GEN = /Generator|generator|Gen(?!erat)|^gen(?!erat)|GEN(?!ERAT)/;
// Power-unit readings that are limits or settings rather than live flows.
const NOT_LIVE = /daily|today|run.?time|hours|limit|rated|^max|^min|setting/i;
// Voltage-unit readings that are thresholds rather than measurements.
const NOT_MEASURED = /limit|rated|max|min|setting|high|low|protect|start|stop|restore|reconnect|charge/i;

function metricsOf(station) {
  const list = [...(station.metrics || [])];
  for (const d of station.devices || []) list.push(...d.metrics);
  return list;
}

function byKey(metrics, keys, test) {
  for (const k of keys) {
    const m = metrics.find((x) => x.key.toLowerCase() === k && test(x));
    if (m) return m;
  }
  return null;
}

// Best single non-phase reading matching a pattern, else the sum of its phase readings.
function byPattern(metrics, re, exclude) {
  const hits = metrics.filter((m) => isPower(m) && re.test(m.key) && !(exclude && exclude.test(m.key)) && !NOT_LIVE.test(m.key));
  if (!hits.length) return null;
  const whole = hits.filter((m) => !PHASE.test(m.key));
  if (whole.length) {
    whole.sort((a, b) => Number(/total/i.test(b.key)) - Number(/total/i.test(a.key)) || a.key.length - b.key.length);
    return [whole[0]];
  }
  return hits;
}

const parts = (list, sign = 1) => list.map((m) => ({ metric: m, scale: wattScale(m) * sign }));

// A grid/generator voltage (or else frequency) reading; any one phase is enough to tell power is present.
function presence(metrics, re, exclude, units = ['v', 'hz']) {
  const excluded = (key) => [].concat(exclude || []).some((x) => x.test(key));
  for (const unit of units) {
    const hits = metrics.filter((m) => isPresence(m) && unitOf(m) === unit && re.test(m.key) && !excluded(m.key) && !NOT_MEASURED.test(m.key));
    if (hits.length) {
      hits.sort((a, b) => Number(PHASE.test(a.key)) - Number(PHASE.test(b.key)) || a.key.localeCompare(b.key));
      return [{ metric: hits[0], scale: 1 }];
    }
  }
  return null;
}

function stationMetric(station, key) {
  return (station.metrics || []).find((m) => m.sourceType === 'station' && m.key === key && m.kind === 'number') || null;
}

function auto(role, station, metrics) {
  const sm = (k) => stationMetric(station, k);
  const devices = metrics.filter((m) => m.sourceType === 'device');
  switch (role) {
    case 'solar': {
      // The inverter's own PV readings come first: the station's generationPower is DeyeCloud's
      // "Production", which also counts a generator on the GEN port, so at night it shows the
      // generator's output as solar. Totals are summed over devices (stations with several inverters).
      const total = ['totalsolarpower', 'totalpvpower', 'pvpower', 'solarpower', 'totaldcinputpower', 'dcinputpower']
        .map((k) => devices.filter((x) => x.key.toLowerCase() === k && isPower(x)))
        .find((list) => list.length);
      if (total) return parts(total);
      const strings = devices.filter((x) => isPower(x) && /pv\d|mppt\d/i.test(x.key) && !NOT_LIVE.test(x.key) && !GEN.test(x.key));
      if (strings.length) return parts(strings);
      const pv = byPattern(devices, /(solar|pv|dc).*power|power.*(pv|solar)/i, GEN);
      if (pv) return parts(pv);
      if (!sm('generationPower')) return null;
      // Last resort: Production minus the generator.
      const gen = auto('generator', station, metrics);
      return [...parts([sm('generationPower')]), ...(gen || []).map((p) => ({ ...p, scale: -p.scale }))];
    }
    case 'load': {
      if (sm('consumptionPower')) return parts([sm('consumptionPower')]);
      const m = byKey(devices, ['totalconsumptionpower', 'totalloadpower', 'loadpower', 'consumptionpower', 'loadtotalpower'], isPower);
      if (m) return parts([m]);
      const p = byPattern(devices, /consum|load/i, /smartload|gen/i);
      return p ? parts(p) : null;
    }
    case 'grid': {
      // wirePower is the net grid power (+ buying / − exporting); purchasePower and gridPower
      // are its buying and exporting sides (checked against DeyeCloud's own history export).
      if (sm('wirePower')) return parts([sm('wirePower')]);
      const buy = sm('purchasePower');
      const sell = sm('gridPower');
      if (buy || sell) return [...(buy ? parts([buy]) : []), ...(sell ? parts([sell], -1) : [])];
      const m = byKey(devices, ['totalgridpower', 'gridpower', 'gridtotalpower', 'totalexternalctpower', 'externalctpower'], isPower);
      if (m) return parts([m]);
      const p = byPattern(devices, /grid|externalct/i, GEN);
      return p ? parts(p) : null;
    }
    case 'generator': {
      const st = byPattern(station.metrics || [], GEN);
      if (st) return parts(st);
      const p = byPattern(devices, GEN);
      return p ? parts(p) : null;
    }
    case 'battery': {
      // batteryPower is signed (+ discharging / − charging); charge/dischargePower are its sides.
      if (sm('batteryPower')) return parts([sm('batteryPower')]);
      const ch = sm('chargePower');
      const dis = sm('dischargePower');
      if (ch || dis) return [...(dis ? parts([dis]) : []), ...(ch ? parts([ch], -1) : [])];
      const m = byKey(devices, ['batterypower', 'totalbatterypower', 'batterytotalpower'], isPower);
      if (m) return parts([m]);
      const p = byPattern(devices, /batt/i, /bms|limit/i);
      return p ? parts(p) : null;
    }
    case 'soc': {
      if (sm('batterySOC')) return [{ metric: sm('batterySOC'), scale: 1 }];
      const m = byKey(devices, ['soc', 'batterysoc', 'bmssoc', 'batterycapacity'], isPercent);
      return m ? [{ metric: m, scale: 1 }] : null;
    }
    case 'gridVoltage':
      return presence(devices, /grid/i, GEN);
    case 'generatorVoltage':
      return presence(devices, GEN);
    case 'loadVoltage':
      return presence(devices, /load|ups|backup|output|^ac.?volt/i, [/grid/i, GEN], ['v']);
    case 'batteryVoltage':
      return presence(devices, /batt|bms/i, [GEN], ['v']);
    default:
      return null;
  }
}

/** Returns { role: { parts, value, auto, hidden } } for one station from /api/live. */
export function resolveFlow(station) {
  const metrics = metricsOf(station);
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const map = station.flowMap || {};
  const out = {};
  for (const { role } of ROLES) {
    const o = map[role];
    let p = null;
    let isAuto = true;
    if (o && o.hidden) {
      out[role] = { parts: [], value: null, auto: false, hidden: true };
      continue;
    }
    if (o && byId.has(o.metricId)) {
      const m = byId.get(o.metricId);
      const kind = ROLES.find((r) => r.role === role).kind;
      p = [{ metric: m, scale: (kind === 'power' ? wattScale(m) : 1) * (o.invert ? -1 : 1) }];
      isAuto = false;
    } else {
      p = auto(role, station, metrics);
    }
    out[role] = { parts: p || [], value: valueOf(p), auto: isAuto, hidden: false };
  }
  return out;
}

function valueOf(p) {
  if (!p || !p.length) return null;
  let sum = 0;
  let any = false;
  for (const { metric, scale } of p) {
    const v = Number(metric.lastValue);
    if (metric.lastValue === null || metric.lastValue === undefined || metric.lastValue === '' || Number.isNaN(v)) continue;
    sum += v * scale;
    any = true;
  }
  return any ? sum : null;
}

/**
 * Who feeds whom right now, in W, following the inverter's own priority: solar serves the home
 * first, then the battery, then the grid; what solar leaves uncovered comes from the battery, then
 * the generator, then the grid, which also make up any battery charging solar doesn't. Small
 * mismatches (inverter losses, readings a few seconds apart) are left unassigned.
 * Inputs: grid + import / − export, battery + discharge / − charge.
 */
export function splitFlows({ solar, load, grid, generator, battery }) {
  const pos = (v) => Math.max(0, Number(v) || 0);
  const supply = { solar: pos(solar), battery: pos(battery), generator: pos(generator), grid: pos(grid) };
  const demand = { home: pos(load), battery: pos(-battery), grid: pos(-grid) };
  const out = {};
  const route = (from, to) => {
    const w = Math.min(supply[from], demand[to]);
    supply[from] -= w;
    demand[to] -= w;
    out[`${from}To${to[0].toUpperCase()}${to.slice(1)}`] = w;
  };
  route('solar', 'home');
  route('solar', 'battery');
  route('solar', 'grid');
  route('battery', 'home');
  route('generator', 'home');
  route('grid', 'home');
  route('generator', 'battery');
  route('grid', 'battery');
  route('battery', 'grid');
  return out;
}

// A grid/generator voltage at or above this, or frequency at or above ON_HERTZ, means it has power.
const ON_VOLTS = 50;
const ON_HERTZ = 40;

/**
 * Whether an outside source (grid or generator) has power: true while power flows through it,
 * otherwise from its voltage or frequency node, else null (can't tell).
 */
export function sourceOn(presenceNode, powerW, idleW) {
  if (Math.abs(Number(powerW) || 0) > idleW) return true;
  if (presenceNode && !presenceNode.hidden && presenceNode.parts.length && presenceNode.value !== null) {
    return presenceNode.value >= (unitOf(presenceNode.parts[0].metric) === 'hz' ? ON_HERTZ : ON_VOLTS);
  }
  return null;
}

// Below this a voltage reading means the source is off, so it can't be used to work out amps.
const MIN_VOLTS = 50;

/** A node's reading in volts, or null when it isn't a live voltage (missing, Hz, or source off). */
export function nodeVolts(node, min = MIN_VOLTS) {
  if (!node || node.hidden || !node.parts.length || node.value === null) return null;
  return unitOf(node.parts[0].metric) === 'v' && node.value >= min ? node.value : null;
}

/** 3 when the inverter reports a live third phase (L3, or R/S/T as …TWC), else 1. */
export function phaseCount(station) {
  return metricsOf(station).some((m) => isVoltage(m) && /(l3|twc)$/i.test(m.key) && Number(m.lastValue) >= MIN_VOLTS) ? 3 : 1;
}

/**
 * Current in A for a power in W: watts ÷ volts on one phase; on three phases the current per phase,
 * from a phase voltage (L-N) or, above 300 V, a line voltage (L-L).
 */
export function toAmps(w, volts, phases = 1) {
  if (w === null || w === undefined || !volts) return null;
  if (phases === 3) return volts > 300 ? w / (Math.sqrt(3) * volts) : w / (3 * volts);
  return w / volts;
}

// ---------- battery reserve and inverter mode ----------

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Minutes since midnight at an instant in the station's time zone.
function localMinutes(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const get = (t) => Number(parts.find((x) => x.type === t).value);
    return get('hour') * 60 + get('minute');
  } catch {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
  }
}

/**
 * The time-of-use slot in force at an instant: { from, to, soc, gridCharge, genCharge }, or null
 * when time of use is off. Each of the inverter's slots runs from its time to the next slot's.
 */
export function touSlot(tou, ms, timeZone) {
  if (!tou || !['on', 'true', '1', 'enable', 'enabled'].includes(String(tou.touAction).toLowerCase())) return null;
  const items = (tou.timeUseSettingItems || [])
    .map((x) => ({ ...x, m: minutesOf(x.time) }))
    .filter((x) => x.m !== null)
    .sort((a, b) => a.m - b.m);
  if (!items.length) return null;
  const now = localMinutes(ms, timeZone);
  let i = items.length - 1; // before the first slot of the day, the last one is still running
  items.forEach((x, k) => {
    if (x.m <= now) i = k;
  });
  const cur = items[i];
  return { from: cur.time, to: items[(i + 1) % items.length].time, soc: num(cur.soc), gridCharge: Boolean(cur.enableGridCharge), genCharge: Boolean(cur.enableGeneration) };
}

const LABELS = {
  BATTERY_FIRST: 'Battery first',
  LOAD_FIRST: 'Load first',
  SELLING_FIRST: 'Selling first',
  ZERO_EXPORT_TO_LOAD: 'Zero export to load',
  ZERO_EXPORT_TO_CT: 'Zero export to CT',
};
const modeLabel = (v) => (v ? LABELS[String(v).toUpperCase()] || String(v).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : null);

/**
 * The battery's reserve and the inverter's mode, from its settings (read hourly) or Customize.
 * The reserve is the charge the battery keeps right now: with time of use on, the current slot's
 * SOC while the grid or generator can take over; otherwise, and during an outage, Shutdown (the
 * level where the inverter stops the battery). Low Batt is only an alarm on Deye inverters, so
 * it is used just when Shutdown is unknown.
 * `sourceAvailable` is whether the grid or generator has power (null when unknown).
 */
export function batteryInfo(station, { sourceAvailable = null, now = Date.now() } = {}) {
  const cfg = (station.devices || []).map((d) => d.config).find((c) => c && (c.battery || c.system || c.tou)) || {};
  const b = cfg.battery || {};
  const sys = cfg.system || {};
  const low = num(b.battLowCapacity);
  const shutdown = num(b.battShutDownCapacity);
  const slot = touSlot(cfg.tou, now, station.timezone);
  const manual = num(station.flowMap && station.flowMap.reserve);
  let reserve = null;
  let reserveFrom = null;
  if (manual !== null) [reserve, reserveFrom] = [manual, 'manual'];
  else if (slot && slot.soc !== null && sourceAvailable !== false) [reserve, reserveFrom] = [slot.soc, 'tou'];
  else if (shutdown !== null) [reserve, reserveFrom] = [shutdown, 'shutdown'];
  else if (low !== null) [reserve, reserveFrom] = [low, 'low'];
  return {
    reserve,
    reserveFrom,
    low,
    shutdown,
    slot,
    pattern: modeLabel(sys.energyPattern),
    workMode: modeLabel(sys.systemWorkMode),
    capacityAh: num(b.battCapacity),
    maxChargeA: num(b.maxChargeCurrent),
    maxDischargeA: num(b.maxDischargeCurrent),
    error: cfg.batteryError || null,
  };
}

export function describeParts(p) {
  if (!p || !p.length) return 'not found';
  return p
    .map(({ metric, scale }, i) => `${i ? (scale < 0 ? ' − ' : ' + ') : scale < 0 ? '− ' : ''}${metric.label}${metric.sourceType === 'device' ? ` (${metric.sourceId})` : ''}`)
    .join('');
}

/** Combines the stored series of a node's parts into one series of [ms, value]. */
export function combineSeries(p, seriesById) {
  if (!p.length) return [];
  if (p.length === 1) {
    const s = seriesById.get(p[0].metric.id);
    return s ? s.map(([t, v]) => [t, v === null ? null : v * p[0].scale]) : [];
  }
  const acc = new Map();
  for (const { metric, scale } of p) {
    for (const [t, v] of seriesById.get(metric.id) || []) {
      if (v === null) continue;
      acc.set(t, (acc.get(t) || 0) + v * scale);
    }
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0]);
}

/** Today's generator energy (kWh), if the inverter reports one. */
export function generatorEnergyToday(station) {
  const m = metricsOf(station).find((x) => x.kind === 'number' && unitOf(x) === 'kwh' && GEN.test(x.key) && /daily|day|today/i.test(x.key));
  return m ? Number(m.lastValue) : null;
}

/** Candidate readings for the Customize dialog. */
export function candidates(station, kind) {
  const test = { percent: isPercent, presence: isPresence, voltage: isVoltage }[kind] || isPower;
  return metricsOf(station).filter(test);
}

/** { grid, generator } display names for a station from /api/live. */
export function sourceNames(station) {
  const n = (station && station.flowMap && station.flowMap.names) || {};
  return { grid: n.grid || DEFAULT_NAMES.grid, generator: n.generator || DEFAULT_NAMES.generator };
}
