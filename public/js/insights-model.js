// Battery sizing from stored hourly history. Pure functions (no DOM or network) so they can be
// checked in Node against the mock inverter, whose true battery size and solar output are known.
//
// The approach, hour by hour over the chosen period:
// 1. Solar potential. With zero export the inverter throttles the panels once the battery is full,
//    so measured solar understates what a bigger battery could store. In those hours the potential
//    is estimated from a clear-sky model (sun position at the station's location), scaled to this
//    array by the hours that were not throttled and to that day's weather.
// 2. Availability of each outside source (grid / generator) from its voltage reading, as the
//    fraction of each hour it had power.
// 3. A battery of a given size is simulated: solar first, the battery covers shortfalls, and when
//    an allowed outside source is on it covers the home and recharges the battery. Whatever is still
//    missing would have needed the excluded source(s). The period runs twice so the battery starts
//    the measured pass in the state the period leaves it in (no free initial charge).
// 4. The smallest battery that leaves nothing missing is found by bisection.

const HOUR = 3600;
const rad = Math.PI / 180;

export const DEFAULT_ASSUMPTIONS = {
  dod: 0.9, // usable share of the battery's rated capacity
  eta: 0.9, // round-trip efficiency (battery and inverter)
  cRate: 0.5, // max charge power as a share of usable capacity per hour
  extChargeKw: 3, // max battery charging from the grid or generator
  currentKwh: null, // rated size of today's battery; estimated from the data when null
};

// "Completely" self-sufficient: what is left over is measurement noise, not real shortfalls.
const FULL_TOLERANCE = 0.0005;
const PRACTICAL_DAYS = 3; // bigger than this many days of average use is not a practical home battery

// ---------- small statistics helpers ----------

export function quantile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const median = (values) => quantile(values, 0.5);

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// ---------- solar geometry ----------

/** Sine of the sun's elevation at an instant (low-precision NOAA formulas, ~0.5°). */
export function sunSine(ts, lat, lng) {
  const n = (ts - 946728000) / 86400; // days since J2000.0
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (((280.46 + 0.9856474 * n) % 360) + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = (gmst * 15 + lng) * rad - ra;
  return Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha);
}

/** Clear-sky irradiance on a horizontal surface (Haurwitz, W/m²), averaged over the hour from ts. */
export function clearSkyHour(ts, lat, lng) {
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const s = sunSine(ts + 450 + k * 900, lat, lng);
    if (s > 0) sum += 1098 * s * Math.exp(-0.057 / s);
  }
  return sum / 4;
}

// ---------- input ----------

/**
 * Aligns hourly series onto one timeline. `series` maps a role (solar, load, grid, generator,
 * battery, soc, gridVoltage, generatorVoltage) to [[ms, value]] hourly averages; power in W with
 * grid + import / − export and battery + discharge / − charge.
 */
export function buildHours(series, fromSec, toSec) {
  const start = Math.floor(fromSec / HOUR) * HOUR;
  const n = Math.max(0, Math.ceil((toSec - start) / HOUR));
  const h = { start, n, t: new Float64Array(n), has: {} };
  for (let i = 0; i < n; i++) h.t[i] = start + i * HOUR;
  for (const role of ['solar', 'load', 'grid', 'generator', 'battery', 'soc', 'gridVoltage', 'generatorVoltage']) {
    const a = new Float64Array(n).fill(NaN);
    let count = 0;
    for (const [ms, v] of series[role] || []) {
      const i = Math.round((ms / 1000 - start) / HOUR);
      if (i >= 0 && i < n && v !== null && Number.isFinite(v)) {
        a[i] = v;
        count += 1;
      }
    }
    h[role] = a;
    h.has[role] = count > 0;
  }
  return h;
}

// Fraction of each hour a source had power: from its voltage when there is one (230 V all hour = 1,
// on for half the hour ≈ 0.5), otherwise from whether it delivered power at all.
function availability(volt, power, hasVolt) {
  const n = volt.length;
  const out = new Float64Array(n);
  let ref = NaN;
  if (hasVolt) {
    const max = quantile(Array.from(volt), 0.99);
    ref = quantile(Array.from(volt).filter((v) => v > max * 0.5), 0.9);
  }
  for (let i = 0; i < n; i++) {
    const v = volt[i];
    if (Number.isFinite(v) && ref > 0) {
      const f = v / ref;
      out[i] = f < 0.1 ? 0 : f > 0.92 ? 1 : f;
    } else {
      out[i] = power[i] > 30 ? 1 : 0;
    }
  }
  return out;
}

// ---------- solar potential ----------

function solarPotential(h, valid, cs, dayOf, days, { lat, lng, capacityKw }) {
  const n = h.n;
  const pot = Float64Array.from(h.solar, (v) => (Number.isFinite(v) ? Math.max(0, v) : NaN));
  const curtailed = new Uint8Array(n);
  const out = { pot, curtailedHours: 0, method: 'measured' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !h.has.soc) return out;

  // Hours in which the panels were probably throttled: battery full and not discharging, and
  // nothing bought from outside (zero export systems can only throttle).
  for (let i = 0; i < n; i++) {
    if (!valid[i] || cs[i] < 20 || !Number.isFinite(h.soc[i])) continue;
    const grid = h.grid[i];
    curtailed[i] =
      h.soc[i] >= 94 && !(h.battery[i] > 150) && !(grid > 200) && !(grid < -50) && !(h.generator[i] > 200) && h.solar[i] > 0 ? 1 : 0;
  }

  // Array factor: how much power this array gives per W/m² of clear-sky sun, from unthrottled hours.
  const ratios = days.map(() => []);
  for (let i = 0; i < n; i++) {
    if (valid[i] && !curtailed[i] && cs[i] > 300 && Number.isFinite(h.soc[i])) ratios[dayOf[i]].push(h.solar[i] / cs[i]);
  }
  const all = ratios.flat();
  if (all.length < 10) return out;
  const globalA = quantile(all, 0.9);
  const factor = days.map((_, d) => {
    for (const w of [20, 45]) {
      const pool = [];
      for (let k = Math.max(0, d - w); k <= Math.min(days.length - 1, d + w); k++) pool.push(...ratios[k]);
      if (pool.length >= 15) return quantile(pool, 0.9);
    }
    return globalA;
  });

  // Each day's weather (0 = overcast, 1 = clear) from its unthrottled daylight hours.
  const clearness = days.map(() => []);
  for (let i = 0; i < n; i++) {
    const d = dayOf[i];
    if (valid[i] && !curtailed[i] && cs[i] > 150 && Number.isFinite(h.soc[i]) && factor[d] > 0) clearness[d].push(h.solar[i] / (factor[d] * cs[i]));
  }
  const k0 = clearness.map((list) => (list.length >= 2 ? Math.min(1, median(list)) : NaN));
  const near = (d, w) => median(k0.slice(Math.max(0, d - w), d + w + 1));
  const k = k0.map((v, d) => {
    if (Number.isFinite(v)) return v;
    for (const w of [3, 15]) {
      const m = near(d, w);
      if (Number.isFinite(m)) return m;
    }
    return 0.7;
  });

  const cap = capacityKw > 0 ? capacityKw * 1000 : Infinity;
  for (let i = 0; i < n; i++) {
    if (!curtailed[i]) continue;
    const d = dayOf[i];
    pot[i] = Math.max(h.solar[i], Math.min(cap, k[d] * factor[d] * cs[i]));
    out.curtailedHours += 1;
  }
  out.method = 'estimated';
  return out;
}

// ---------- today's battery ----------

// Rated capacity from how far the state of charge falls while the battery discharges:
// kWh discharged between two hours ÷ SOC drop. Median over many hours.
function estimateBattery(h) {
  if (!h.has.soc || !h.has.battery) return null;
  const est = [];
  for (let i = 0; i + 1 < h.n; i++) {
    const s0 = h.soc[i];
    const s1 = h.soc[i + 1];
    const p0 = h.battery[i];
    const p1 = h.battery[i + 1];
    if (![s0, s1, p0, p1].every(Number.isFinite)) continue;
    const drop = s0 - s1;
    if (p0 > 200 && p1 > 200 && drop >= 3) est.push((((p0 + p1) / 2 / 1000) * 100) / drop);
  }
  if (est.length < 12) return null;
  const kwh = median(est);
  return kwh >= 0.5 && kwh <= 500 ? { kwh, samples: est.length } : null;
}

// ---------- simulation ----------

/** Precomputes everything the simulation needs once per analysis. */
export function prepare(h, station) {
  const n = h.n;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = Number.isFinite(h.load[i]) && Number.isFinite(h.solar[i]) ? 1 : 0;

  const lat = Number(station.lat);
  const lng = Number(station.lng);
  const geo = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  const cs = new Float64Array(n);
  if (geo) for (let i = 0; i < n; i++) cs[i] = clearSkyHour(h.t[i], lat, lng);

  // Local calendar days and months.
  const dayOf = new Int32Array(n);
  const monthOf = new Int32Array(n);
  const days = [];
  const months = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(h.t[i] * 1000);
    const dk = dayKey(d);
    const mk = monthKey(d);
    if (days[days.length - 1] !== dk) days.push(dk);
    if (months[months.length - 1] !== mk) months.push(mk);
    dayOf[i] = days.length - 1;
    monthOf[i] = months.length - 1;
  }

  const solar = solarPotential(h, valid, cs, dayOf, days, { lat: geo ? lat : NaN, lng: geo ? lng : NaN, capacityKw: Number(station.installedCapacity) });
  const gridImport = Float64Array.from(h.grid, (v) => (v > 0 ? v : 0));
  const gridAvail = availability(h.gridVoltage, gridImport, h.has.gridVoltage);
  const genAvail = availability(h.generatorVoltage, h.generator, h.has.generatorVoltage);

  const idx = [];
  for (let i = 0; i < n; i++) if (valid[i]) idx.push(i);
  const m = idx.length;
  const ctx = {
    h,
    idx,
    days,
    months,
    cs,
    geo,
    solar,
    L: new Float64Array(m),
    S: new Float64Array(m),
    fG: new Float64Array(m),
    fE: new Float64Array(m),
    day: new Int32Array(m),
    month: new Int32Array(m),
    gridMethod: h.has.gridVoltage ? 'voltage' : h.has.grid ? 'power' : 'none',
    generatorMethod: h.has.generatorVoltage ? 'voltage' : h.has.generator ? 'power' : 'none',
    gridAvail,
    genAvail,
    gridImport,
    totalLoad: 0,
  };
  idx.forEach((i, j) => {
    ctx.L[j] = Math.max(0, h.load[i]) / 1000;
    ctx.S[j] = Math.max(0, solar.pot[i]) / 1000;
    ctx.fG[j] = gridAvail[i];
    ctx.fE[j] = genAvail[i];
    ctx.day[j] = dayOf[i];
    ctx.month[j] = monthOf[i];
    ctx.totalLoad += ctx.L[j];
  });
  return ctx;
}

/**
 * Runs one battery size through the period. `allow` is the outside source that may still be used:
 * 'none', 'grid' or 'generator'. Sizes are usable kWh. Returns kWh still missing, bought and wasted.
 */
export function simulate(ctx, { usable, allow = 'none', pvScale = 1, eta, cRate, extChargeKw }) {
  const { L, S } = ctx;
  const avail = allow === 'grid' ? ctx.fG : allow === 'generator' ? ctx.fE : null;
  const C = Math.max(0, usable);
  const ec = Math.sqrt(eta);
  const rate = cRate * C;
  const ext = Math.min(extChargeKw, rate);
  const m = L.length;
  const missingByMonth = new Float64Array(ctx.months.length);
  const shortDay = new Uint8Array(ctx.days.length);
  let e = C;
  let missing = 0;
  let bought = 0;
  let wasted = 0;
  for (let pass = 0; pass < 2; pass++) {
    const count = pass === 1;
    for (let j = 0; j < m; j++) {
      const l = L[j];
      const s = S[j] * pvScale;
      const f = avail ? avail[j] : 0;
      const off = 1 - f;
      let miss = 0;
      // Part of the hour without the outside source: solar, then the battery.
      if (off > 0) {
        const net = (s - l) * off;
        if (net >= 0) {
          const c = Math.min(net, rate * off, (C - e) / ec);
          e += c * ec;
          if (count) wasted += net - c;
        } else {
          const d = Math.min(-net, e * ec);
          e -= d / ec;
          miss = -net - d;
        }
      }
      // Part of the hour with it: it covers the home and tops up the battery.
      if (f > 0) {
        const net = (s - l) * f;
        let room = (C - e) / ec;
        let r = rate * f;
        if (net > 0) {
          const c = Math.min(net, r, room);
          e += c * ec;
          room -= c;
          r -= c;
          if (count) wasted += net - c;
        } else if (count) {
          bought -= net;
        }
        const c2 = Math.max(0, Math.min(ext * f, r, room));
        e += c2 * ec;
        if (count) bought += c2;
      }
      if (count && miss > 1e-6) {
        missing += miss;
        missingByMonth[ctx.month[j]] += miss;
        if (miss > 0.01) shortDay[ctx.day[j]] = 1;
      }
    }
  }
  let shortDays = 0;
  for (const x of shortDay) shortDays += x;
  return { missing, bought, wasted, missingByMonth, shortDays, coverage: ctx.totalLoad > 0 ? 1 - missing / ctx.totalLoad : 1 };
}

/** Smallest usable size (kWh) that leaves at most `tolerance` kWh missing, or null above `maxUsable`. */
export function requiredUsable(ctx, opt, tolerance, maxUsable) {
  if (simulate(ctx, { ...opt, usable: 0 }).missing <= tolerance) return 0;
  if (simulate(ctx, { ...opt, usable: maxUsable }).missing > tolerance) return null;
  let lo = 0;
  let hi = maxUsable;
  while (hi - lo > Math.max(0.05, hi * 0.002)) {
    const mid = (lo + hi) / 2;
    if (simulate(ctx, { ...opt, usable: mid }).missing <= tolerance) hi = mid;
    else lo = mid;
  }
  return hi;
}

const niceStep = (span) => {
  const raw = span / 30;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((x) => x * p).find((x) => x >= raw);
};

// ---------- the full analysis ----------

/**
 * h: from buildHours; station: { lat, lng, installedCapacity }; assumptions: see DEFAULT_ASSUMPTIONS.
 * Returns everything the Insights page shows.
 */
export function analyse(h, station, assumptions = {}) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  const ctx = prepare(h, station);
  const m = ctx.L.length;
  if (m < 24) return { ok: false, hours: m };

  const dayCount = new Set(ctx.day).size;
  const avgDaily = ctx.totalLoad / dayCount;
  const sim = { eta: a.eta, cRate: a.cRate, extChargeKw: a.extChargeKw };
  const toRated = (usable) => usable / a.dod;
  const battery = estimateBattery(h);
  const currentKwh = a.currentKwh > 0 ? a.currentKwh : battery ? battery.kwh : null;
  const fullTol = Math.max(0.5, ctx.totalLoad * FULL_TOLERANCE);
  const practicalUsable = PRACTICAL_DAYS * avgDaily;
  const searchMax = Math.max(60, 40 * avgDaily);

  // Totals and per-month figures.
  const monthRows = ctx.months.map((key) => ({ key, days: new Set(), load: 0, solar: 0, potential: 0, grid: 0, generator: 0, gridHours: 0, generatorHours: 0 }));
  const totals = { load: 0, solar: 0, potential: 0, grid: 0, generator: 0 };
  ctx.idx.forEach((i, j) => {
    const r = monthRows[ctx.month[j]];
    const solar = Math.max(0, h.solar[i]) / 1000;
    const grid = ctx.gridImport[i] / 1000;
    const gen = Number.isFinite(h.generator[i]) ? Math.max(0, h.generator[i]) / 1000 : 0;
    r.days.add(ctx.day[j]);
    r.load += ctx.L[j];
    r.solar += solar;
    r.potential += ctx.S[j];
    r.grid += grid;
    r.generator += gen;
    r.gridHours += ctx.fG[j];
    r.generatorHours += ctx.fE[j];
    totals.load += ctx.L[j];
    totals.solar += solar;
    totals.potential += ctx.S[j];
    totals.grid += grid;
    totals.generator += gen;
  });
  const months = monthRows
    .filter((r) => r.days.size)
    .map((r) => ({ ...r, days: r.days.size, gridHours: r.gridHours / r.days.size, generatorHours: r.generatorHours / r.days.size }));

  // Night use (sun below the horizon), per night: the least a battery must hold on a sunny day.
  const nights = new Map();
  let peakKw = 0;
  ctx.idx.forEach((i, j) => {
    peakKw = Math.max(peakKw, ctx.L[j]);
    if (!ctx.geo || ctx.cs[i] > 0) return;
    const key = dayKey(new Date((h.t[i] - 12 * HOUR) * 1000));
    nights.set(key, (nights.get(key) || 0) + ctx.L[j]);
  });
  const nightValues = [...nights.values()].filter((v) => v > 0.2);

  // Scenarios: which outside source may still be used.
  const scenarios = [{ id: 'solar', allow: 'none' }];
  if (ctx.gridMethod !== 'none') scenarios.push({ id: 'grid', allow: 'grid' });
  if (ctx.generatorMethod !== 'none') scenarios.push({ id: 'generator', allow: 'generator' });

  for (const sc of scenarios) {
    const opt = { ...sim, allow: sc.allow };
    const full = requiredUsable(ctx, opt, fullTol, searchMax);
    const p99 = requiredUsable(ctx, opt, ctx.totalLoad * 0.01, searchMax);
    sc.required = full === null ? null : toRated(full);
    sc.practical = full !== null && full <= practicalUsable;
    sc.p99 = p99 === null ? null : toRated(p99);
    sc.atRequired = full === null ? null : simulate(ctx, { ...opt, usable: full });
    if (currentKwh) {
      const r = simulate(ctx, { ...opt, usable: currentKwh * a.dod });
      const worst = r.missingByMonth.reduce((best, v, k) => (v > r.missingByMonth[best] ? k : best), 0);
      sc.atCurrent = { ...r, worstMonth: r.missing > 0.5 ? ctx.months[worst] : null };
    }
    // With today's panels it may take an impractically big battery; how many more panels would do?
    if (sc.allow === 'none' && !sc.practical) {
      for (let k = 1.1; k <= 4.001; k += 0.1) {
        const u = requiredUsable(ctx, { ...opt, pvScale: k }, fullTol, practicalUsable);
        if (u !== null) {
          sc.morePanels = { factor: k, rated: toRated(u) };
          break;
        }
      }
    }
  }

  // Coverage curve: share of consumption met without the excluded source(s), by rated size.
  const finite = scenarios.map((s) => s.required).filter((v) => v !== null);
  const curveMax = Math.max(20, (currentKwh || 0) * 2, Math.min(Math.max(0, ...finite) * 1.15, toRated(practicalUsable) * 1.5));
  const step = niceStep(curveMax);
  const sizes = [];
  for (let x = 0; x <= curveMax + 1e-9; x += step) sizes.push(Math.round(x * 100) / 100);
  const curve = {
    sizes,
    series: Object.fromEntries(scenarios.map((sc) => [sc.id, sizes.map((x) => simulate(ctx, { ...sim, allow: sc.allow, usable: x * a.dod }).coverage * 100)])),
  };

  return {
    ok: true,
    assumptions: a,
    hours: m,
    days: dayCount,
    firstTs: h.t[ctx.idx[0]],
    lastTs: h.t[ctx.idx[m - 1]],
    avgDaily,
    peakKw,
    nights: nightValues.length ? { avg: nightValues.reduce((s, v) => s + v, 0) / nightValues.length, p90: quantile(nightValues, 0.9), max: Math.max(...nightValues) } : null,
    totals: { ...totals, wasted: Math.max(0, totals.potential - totals.solar) },
    solar: { method: ctx.solar.method, curtailedHours: ctx.solar.curtailedHours },
    gridMethod: ctx.gridMethod,
    generatorMethod: ctx.generatorMethod,
    battery: battery ? { ...battery, used: currentKwh, estimated: !(a.currentKwh > 0) } : currentKwh ? { kwh: currentKwh, used: currentKwh, estimated: false } : null,
    currentKwh,
    practicalRated: toRated(practicalUsable),
    searchMaxRated: toRated(searchMax),
    scenarios,
    curve,
    months,
  };
}
