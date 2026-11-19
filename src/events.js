'use strict';

// Events and patterns, worked out from the stored readings rather than recorded as they happen:
// when the grid and the generator came on and went off, when the battery crossed chosen levels,
// and when custom conditions started and stopped holding. Because they come from history, they
// cover everything that was imported, and "grid on" means the same as on the Overview and in
// automations (public/js/flow.js).

const db = require('./db');
const settings = require('./settings');
const { liveStations, flow } = require('./live');
const automations = require('./automations');
const schedule = require('./schedule');

const STEP = 60; // s: readings are grouped to the minute
const HOLD = 15 * 60; // s a reading stands for when no newer one arrived
const GAP = 30 * 60; // s without any reading after which nothing is known
const LOOKBACK = 86400; // s read before the period, to know how it started
const HYSTERESIS = 2; // % the battery must move away from a level before it can cross it again
const MAX_DAYS = 400;
const MAX_EVENTS = 4000;
const USUAL_SHARE = 0.6; // "usually on" in an hour of the day: on this share of the time
const RULE_TYPES = ['soc', 'power', 'battery', 'reading', 'source'];
const POWER_ROLES = ['solar', 'load', 'grid', 'generator', 'battery'];

const nowSec = () => Math.floor(Date.now() / 1000);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// ---------- settings ----------

function parseLevels(text) {
  const out = [...new Set(String(text || '').split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 100))];
  return out.sort((a, b) => a - b).slice(0, 8);
}

async function levels() {
  return parseLevels(await settings.get('event_soc_levels'));
}

async function setLevels(input) {
  const list = parseLevels(Array.isArray(input) ? input.join(',') : input);
  await settings.set({ event_soc_levels: list.join(',') });
  return list;
}

function cleanRule(input) {
  const name = String((input && input.name) || '').trim().slice(0, 120);
  if (!name) throw badRequest('Give the event a name');
  const condition = automations.cleanCondition(input.condition);
  if (!RULE_TYPES.includes(condition.type)) throw badRequest('Events can only watch inverter readings');
  return { name, rule: { condition } };
}

async function rules() {
  const rows = await db.query('SELECT * FROM event_rules ORDER BY id');
  const out = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, name: r.name, condition: JSON.parse(r.rule).condition });
    } catch {
      /* unreadable rule: skip it */
    }
  }
  return out;
}

async function saveRule(id, input, username) {
  const r = cleanRule(input);
  const now = nowSec();
  if (id) {
    const res = await db.query('UPDATE event_rules SET name = ?, rule = ?, updated_ts = ? WHERE id = ?', [r.name, JSON.stringify(r.rule), now, id]);
    if (!res.affectedRows) {
      const err = new Error('Event not found');
      err.status = 404;
      throw err;
    }
    return id;
  }
  const ins = await db.query('INSERT INTO event_rules (name, rule, created_by, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)', [r.name, JSON.stringify(r.rule), username || null, now, now]);
  return ins.insertId;
}

async function deleteRule(id) {
  await db.query('DELETE FROM event_rules WHERE id = ?', [id]);
}

// ---------- helpers ----------

/** Seconds to add to an instant to get wall-clock time in a zone (looked up once per hour). */
function zoneOffset(timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return () => 0;
  }
  const cache = new Map();
  return (t) => {
    const k = Math.floor(t / 3600);
    let off = cache.get(k);
    if (off === undefined) {
      const p = {};
      for (const x of fmt.formatToParts(new Date(k * 3600 * 1000))) p[x.type] = Number(x.value);
      off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - k * 3600;
      cache.set(k, off);
    }
    return off;
  };
}

function stats(list) {
  const v = list.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0, avg: null, median: null, max: null };
  const mid = (v.length - 1) / 2;
  return { n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, median: (v[Math.floor(mid)] + v[Math.ceil(mid)]) / 2, max: v[v.length - 1] };
}

/** Remembers a yes/no state over time: the stretches it lasted and when it changed. */
function tracker() {
  return { state: null, since: null, exact: false, before: null, lastT: null, intervals: [] };
}

/**
 * Feeds one sample (true, false or null for unknown). Returns { prevFor, approx } when the state
 * changed: prevFor is how long the previous state lasted (null when its start wasn't seen),
 * approx that the change happened somewhere in a gap in the data.
 */
function feed(tr, t, value) {
  if (value === null) {
    if (tr.state !== null) {
      tr.intervals.push({ state: tr.state, from: tr.since, to: tr.lastT, exact: false });
      tr.before = tr.state;
      tr.state = null;
    }
    return null;
  }
  let change = null;
  if (tr.state === null) {
    if (tr.before !== null && tr.before !== value) change = { prevFor: null, approx: true };
    Object.assign(tr, { state: value, since: t, exact: false });
  } else if (value !== tr.state) {
    tr.intervals.push({ state: tr.state, from: tr.since, to: t, exact: tr.exact });
    change = { prevFor: tr.exact ? t - tr.since : null, approx: false };
    Object.assign(tr, { state: value, since: t, exact: true });
  }
  tr.lastT = t;
  return change;
}

function holds(c, v) {
  switch (c.type) {
    case 'source': {
      const on = c.source === 'grid' ? v.gridOn : v.genOn;
      return on === null ? null : on === (c.state === 'on');
    }
    case 'soc':
      return v.soc === null ? null : automations.compare(v.soc, c.op, c.value);
    case 'power': {
      const w = automations.powerValue(c.node, v);
      return w === null ? null : automations.compare(w, c.op, c.value);
    }
    case 'battery':
      return v.battery === null ? null : (v.battery < -15 ? 'charging' : v.battery > 15 ? 'discharging' : 'idle') === c.state;
    case 'reading': {
      const x = v.reading(c.metricId);
      return x === null ? null : automations.compare(x, c.op, c.value);
    }
    default:
      return null;
  }
}

/** Hours of the day a source is usually on, as [[fromHour, toHour]] (toHour exclusive, may pass 24). */
function usualHours(share) {
  const on = share.map((s) => s !== null && s >= USUAL_SHARE);
  if (on.every(Boolean)) return [[0, 24]];
  const out = [];
  // Start after an "off" hour so a stretch over midnight comes out as one range.
  const start = on.indexOf(false) + 1;
  let cur = null;
  for (let k = 0; k < 24; k++) {
    const h = (start + k) % 24;
    if (on[h]) {
      if (!cur) cur = [h, h + 1];
      else cur[1] += 1;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------- the timeline ----------

/**
 * Events and patterns for one station between two instants.
 * Returns { events, sources, battery, levels, rules, names, timeZone, … } (see the Events page).
 */
async function build({ stationId, from, to, withForecast = false }) {
  const now = nowSec();
  to = Math.min(Number.isFinite(to) ? to : now, now);
  from = Math.max(Number.isFinite(from) ? from : to - 7 * 86400, to - MAX_DAYS * 86400);
  const { stations } = await liveStations();
  const station = stations.find((s) => s.id === String(stationId)) || stations[0];
  const tz = (await automations.timeZone()).timeZone;
  const socLevels = await levels();
  const customs = await rules();
  const base = { from, to, timeZone: tz, levels: socLevels, rules: customs, stations: stations.map((s) => ({ id: s.id, name: s.name })) };
  if (!station) return { ...base, station: null, events: [], sources: [], battery: null, levelStats: [], ruleStats: [] };

  const f = await flow();
  const r = f.resolveFlow(station);
  const names = f.sourceNames(station);
  const part = (role) => (r[role] && !r[role].hidden ? r[role].parts.map((p) => ({ id: p.metric.id, scale: p.scale })) : []);
  const roles = {};
  for (const role of [...POWER_ROLES, 'soc', 'gridVoltage', 'generatorVoltage']) roles[role] = part(role);
  const presenceUnit = (role) => (r[role].parts.length && !r[role].hidden ? r[role].parts[0].metric : null);
  const hasGrid = !r.grid.hidden && (roles.grid.length > 0 || roles.gridVoltage.length > 0);
  const hasGenerator = !r.generator.hidden && roles.generator.length > 0;

  const needPower = customs.some((c) => c.condition.type === 'power' || c.condition.type === 'battery');
  const ids = new Set();
  for (const [role, parts] of Object.entries(roles)) {
    if (!needPower && ['solar', 'load', 'battery'].includes(role)) continue;
    for (const p of parts) ids.add(p.id);
  }
  for (const c of customs) if (c.condition.type === 'reading') ids.add(c.condition.metricId);

  const rows = ids.size
    ? await db.query(
        `SELECT metric_id AS m, FLOOR(ts / ?) * ? AS t, AVG(value) AS v
           FROM readings
          WHERE metric_id IN (?) AND ts BETWEEN ? AND ?
          GROUP BY metric_id, t
          ORDER BY t`,
        [STEP, STEP, [...ids], from - LOOKBACK, to]
      )
    : [];

  // The newest value of each reading while walking forward in time.
  const last = new Map();
  const reading = (id, t) => {
    const x = last.get(id);
    return x && t - x.t <= HOLD ? x.v : null;
  };
  const node = (role, t) => {
    let sum = 0;
    let any = false;
    for (const p of roles[role]) {
      const v = reading(p.id, t);
      if (v === null) continue;
      sum += v * p.scale;
      any = true;
    }
    return any ? sum : null;
  };
  const sourceOn = (voltRole, power, t) => {
    const metric = presenceUnit(voltRole);
    if (!metric) return power === null ? null : Math.abs(power) > automations.SOURCE_IDLE;
    const on = f.sourceOn({ hidden: false, parts: [{ metric }], value: node(voltRole, t) }, power, automations.SOURCE_IDLE);
    return on;
  };

  const offsetOf = zoneOffset(tz);
  const local = (t) => t + offsetOf(t);
  const events = [];
  const src = {
    grid: { tr: tracker(), on: new Float64Array(24), known: new Float64Array(24), starts: new Array(24).fill(0), slots: new Map() },
    generator: { tr: tracker(), on: new Float64Array(24), known: new Float64Array(24), starts: new Array(24).fill(0), slots: new Map() },
  };
  const island = { tr: tracker(), socStart: null, runs: [] };
  const ruleTr = customs.map(() => tracker());
  const level = socLevels.map((value) => ({ value, up: null, down: null, firstUp: new Map(), firstDown: new Map() }));
  const socDays = new Set();
  let prevT = null;
  let lastSoc = null;
  let firstT = null;

  const step = (t) => {
    const gap = prevT !== null && t - prevT > GAP;
    if (gap) {
      for (const tr of [src.grid.tr, src.generator.tr, island.tr, ...ruleTr]) feed(tr, prevT, null);
    } else if (prevT !== null && prevT >= from) {
      // The time since the previous sample counts towards the state it showed.
      const h = Math.floor((local(prevT) % 86400) / 3600);
      const slot = Math.floor(local(prevT) / 1800); // half-hours, for the schedule analysis
      for (const s of [src.grid, src.generator]) {
        if (s.tr.state === null) continue;
        s.known[h] += t - prevT;
        if (s.tr.state) s.on[h] += t - prevT;
        if (!withForecast) continue;
        const x = s.slots.get(slot) || s.slots.set(slot, [0, 0]).get(slot);
        x[1] += t - prevT;
        if (s.tr.state) x[0] += t - prevT;
      }
    }
    const v = { reading: (id) => reading(id, t) };
    for (const role of POWER_ROLES) v[role] = node(role, t);
    v.soc = node('soc', t);
    v.gridOn = hasGrid ? sourceOn('gridVoltage', v.grid, t) : null;
    v.genOn = hasGenerator ? sourceOn('generatorVoltage', v.generator, t) : null;
    const soc = v.soc === null ? null : Math.round(v.soc);
    const push = (e) => t >= from && events.push({ ts: t, soc, ...e });

    for (const [kind, on] of [['grid', v.gridOn], ['generator', v.genOn]]) {
      const ch = feed(src[kind].tr, t, on);
      if (!ch) continue;
      push({ kind, on, ...ch });
      if (on && t >= from) src[kind].starts[Math.floor((local(t) % 86400) / 3600)] += 1;
    }

    // "On battery": the grid is off and the generator isn't running.
    const alone = v.gridOn === null || (hasGenerator && v.genOn === null) ? null : v.gridOn === false && v.genOn !== true;
    const ch = feed(island.tr, t, alone);
    if (ch && alone) island.socStart = v.soc;
    else if (ch && !alone) {
      if (!ch.approx && ch.prevFor !== null && t - ch.prevFor >= from) island.runs.push({ seconds: ch.prevFor, socStart: island.socStart, socEnd: v.soc, endedBy: v.genOn === true ? 'generator' : 'grid' });
      island.socStart = null;
    } else if (alone === null) island.socStart = null;

    if (v.soc !== null) {
      const day = Math.floor(local(t) / 86400);
      const minute = Math.floor((local(t) % 86400) / 60);
      if (t >= from) socDays.add(day);
      for (const l of level) {
        if (l.up === null) {
          l.up = v.soc < l.value;
          l.down = v.soc > l.value;
          continue;
        }
        if (l.up && v.soc >= l.value) {
          l.up = false;
          push({ kind: 'soc', level: l.value, dir: 'up', approx: gap });
          if (t >= from && !l.firstUp.has(day)) l.firstUp.set(day, minute);
        } else if (!l.up && v.soc <= l.value - HYSTERESIS) l.up = true;
        if (l.value < 100) {
          if (l.down && v.soc <= l.value) {
            l.down = false;
            push({ kind: 'soc', level: l.value, dir: 'down', approx: gap });
            if (t >= from && !l.firstDown.has(day)) l.firstDown.set(day, minute);
          } else if (!l.down && v.soc >= l.value + HYSTERESIS) l.down = true;
        }
      }
      lastSoc = v.soc;
    }

    customs.forEach((c, i) => {
      const on = holds(c.condition, v);
      const chg = feed(ruleTr[i], t, on);
      if (chg) push({ kind: 'custom', ruleId: c.id, name: c.name, on, ...chg });
    });
    prevT = t;
    if (firstT === null) firstT = t;
  };

  let i = 0;
  while (i < rows.length) {
    const t = Number(rows[i].t);
    for (; i < rows.length && Number(rows[i].t) === t; i++) last.set(rows[i].m, { t, v: Number(rows[i].v) });
    step(t);
  }

  // ---------- patterns ----------
  const lengths = (tr, state) => tr.intervals.filter((x) => x.exact && x.state === state && x.from >= from).map((x) => x.to - x.from);
  const stale = prevT === null || now - prevT > GAP;
  const current = (tr) => (tr.state === null || stale ? null : { on: tr.state, since: tr.since, exact: tr.exact });
  const scheduleFor = (raw) => {
    // Half-hours with readings for less than a third of them say too little to learn from.
    const slots = new Map();
    for (const [k, [on, known]] of raw) if (known >= 600) slots.set(k, on / known);
    return schedule.analyse(slots, Math.floor(local(now) / 86400), Math.floor((local(now) % 86400) / 1800));
  };
  const sources = [];
  for (const kind of ['grid', 'generator']) {
    if (kind === 'grid' ? !hasGrid : !hasGenerator) continue;
    const s = src[kind];
    const known = s.known.reduce((a, b) => a + b, 0);
    const on = s.on.reduce((a, b) => a + b, 0);
    const hourShare = Array.from(s.known, (k, h) => (k > 0 ? s.on[h] / k : null));
    sources.push({
      kind,
      name: names[kind],
      knownSeconds: known,
      share: known ? on / known : null,
      hoursPerDay: known ? (on / known) * 24 : null,
      hourShare,
      hourStarts: s.starts,
      startsPerDay: known ? s.starts.reduce((a, b) => a + b, 0) / (known / 86400) : null,
      usual: known ? usualHours(hourShare) : [],
      onStretch: stats(lengths(s.tr, true)),
      offStretch: stats(lengths(s.tr, false)),
      now: current(s.tr),
      schedule: withForecast && kind === 'grid' ? scheduleFor(s.slots) : undefined,
    });
  }

  const runStats = (list) => ({
    ...stats(list.map((x) => x.seconds)),
    socStart: stats(list.map((x) => x.socStart)).avg,
    socEnd: stats(list.map((x) => x.socEnd)).avg,
  });
  const battery = {
    soc: stale ? null : lastSoc,
    hasGenerator,
    all: runStats(island.runs),
    untilGenerator: runStats(island.runs.filter((x) => x.endedBy === 'generator')),
    untilGrid: runStats(island.runs.filter((x) => x.endedBy === 'grid')),
    now: current(island.tr),
  };
  const dayStats = (m) => ({ days: m.size, medianMinute: m.size ? Math.round(stats([...m.values()]).median) : null });
  const levelStats = level.map((l) => ({ level: l.value, daysWithData: socDays.size, up: dayStats(l.firstUp), down: l.value < 100 ? dayStats(l.firstDown) : null }));
  const ruleStats = customs.map((c, k) => ({ id: c.id, held: stats(lengths(ruleTr[k], true)), now: current(ruleTr[k]), times: events.filter((e) => e.kind === 'custom' && e.ruleId === c.id && e.on).length }));

  events.reverse();
  return {
    ...base,
    station: { id: station.id, name: station.name },
    names,
    dataFrom: firstT === null ? null : Math.max(firstT, from),
    dataTo: prevT,
    truncated: events.length > MAX_EVENTS,
    events: events.slice(0, MAX_EVENTS),
    sources,
    battery,
    levelStats,
    ruleStats,
  };
}

/**
 * The grid's schedule (its recurring day cases) and the prediction for today and tomorrow,
 * learned from the last weeks whatever period the page shows.
 */
async function forecasts(stationId) {
  const now = nowSec();
  const data = await build({ stationId, from: now - (schedule.HISTORY_DAYS + 1) * 86400, to: now, withForecast: true });
  const s = data.sources.find((x) => x.kind === 'grid');
  return { timeZone: data.timeZone, station: data.station, source: s ? { kind: s.kind, name: s.name, now: s.now, onStretch: s.onStretch, offStretch: s.offStretch, schedule: s.schedule } : null };
}

module.exports = { build, forecasts, levels, setLevels, rules, saveRule, deleteRule };
