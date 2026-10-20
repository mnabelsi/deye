// Works out which stored readings feed each power-flow node (solar, load, grid, generator,
// battery, SOC). DeyeCloud key names differ between inverter models, so readings are matched
// by name and unit; an admin can override any node in the Customize dialog (saved per station).
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
];

const unitOf = (m) => String(m.unit || '').trim().toLowerCase();
const isPower = (m) => m.kind === 'number' && ['w', 'kw'].includes(unitOf(m));
const isPercent = (m) => m.kind === 'number' && unitOf(m) === '%';
const wattScale = (m) => (unitOf(m) === 'kw' ? 1000 : 1);
const PHASE = /(l[123]|phase ?[123abc]|[_\s][abc])$/i;
// "Gen"/"Generator" at a CamelCase word start; not "Generation" (PV) or "ChargingEnergy".
const GEN = /Generator|generator|Gen(?!erat)|^gen(?!erat)|GEN(?!ERAT)/;
// Power-unit readings that are limits or settings rather than live flows.
const NOT_LIVE = /daily|today|run.?time|hours|limit|rated|^max|^min|setting/i;

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

function stationMetric(station, key) {
  return (station.metrics || []).find((m) => m.sourceType === 'station' && m.key === key && m.kind === 'number') || null;
}

function auto(role, station, metrics) {
  const sm = (k) => stationMetric(station, k);
  const devices = metrics.filter((m) => m.sourceType === 'device');
  switch (role) {
    case 'solar': {
      if (sm('generationPower')) return parts([sm('generationPower')]);
      const m = byKey(devices, ['totalsolarpower', 'totalpvpower', 'pvpower', 'solarpower', 'totaldcinputpower', 'dcinputpower'], isPower);
      if (m) return parts([m]);
      const pv = byPattern(devices, /(solar|pv|dc).*power|power.*(pv|solar)/i, GEN);
      if (pv) return parts(pv);
      const strings = devices.filter((x) => isPower(x) && /pv\d|mppt\d/i.test(x.key));
      return strings.length ? parts(strings) : null;
    }
    case 'load': {
      if (sm('consumptionPower')) return parts([sm('consumptionPower')]);
      const m = byKey(devices, ['totalconsumptionpower', 'totalloadpower', 'loadpower', 'consumptionpower', 'loadtotalpower'], isPower);
      if (m) return parts([m]);
      const p = byPattern(devices, /consum|load/i, /smartload|gen/i);
      return p ? parts(p) : null;
    }
    case 'grid': {
      const buy = sm('purchasePower');
      const sell = sm('wirePower');
      if (buy || sell) return [...(buy ? parts([buy]) : []), ...(sell ? parts([sell], -1) : [])];
      if (sm('gridPower')) return parts([sm('gridPower')]);
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
      const ch = sm('chargePower');
      const dis = sm('dischargePower');
      if (ch || dis) return [...(dis ? parts([dis]) : []), ...(ch ? parts([ch], -1) : [])];
      if (sm('batteryPower')) return parts([sm('batteryPower')]);
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
      p = [{ metric: m, scale: (role === 'soc' ? 1 : wattScale(m)) * (o.invert ? -1 : 1) }];
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
  return metricsOf(station).filter((m) => (kind === 'percent' ? isPercent(m) : isPower(m)));
}
